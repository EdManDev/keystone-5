const express = require('express');
const cors = require('cors');
const path = require('path');
const falsey = require('falsey');
const cookie = require('cookie');
const expressSession = require('express-session');
const cookieSignature = require('cookie-signature');
const createGraphQLMiddleware = require('./graphql');
const initConfig = require('./initConfig');
const createApolloServer = require('./apolloServer.js');
const {
  session: { populateAuthedItemMiddleware },
} = require('@keystone-alpha/keystone');

const sessionCommonMiddleware = (keystone, cookieSecret, sessionStore) => {
  const COOKIE_NAME = 'keystone.sid';

  // We have at least one auth strategy
  // Setup the session as the very first thing.
  // The way express works, the `req.session` (and, really, anything added
  // to `req`) will be available to all sub `express()` instances.
  // This way, we have one global setting for authentication / sessions that
  // all routes on the server can utilize.
  function injectAuthCookieMiddleware(req, res, next) {
    if (!req.headers) {
      return next();
    }

    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader) {
      return next();
    }

    const [type, token] = (req.headers.authorization || req.headers.Authorization).split(' ');

    if (type !== 'Bearer') {
      // TODO: Use logger
      console.warn(`Got Authorization header of type ${type}, but expected Bearer`);
      return next();
    }

    // Split the cookies out
    const cookies = cookie.parse(req.headers.cookie || '');

    // Construct a "fake" session cookie based on the authorization token
    cookies[COOKIE_NAME] = `s:${cookieSignature.sign(token, cookieSecret)}`;

    // Then reset the cookies so the session middleware can read it.
    req.headers.cookie = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    // Always call next
    next();
  }

  const sessionMiddleware = expressSession({
    secret: cookieSecret,
    resave: false,
    saveUninitialized: false,
    name: COOKIE_NAME,
    store: sessionStore,
  });

  return [injectAuthCookieMiddleware, sessionMiddleware, populateAuthedItemMiddleware(keystone)];
};

module.exports = class WebServer {
  constructor(keystone, config) {
    this.keystone = keystone;
    this.config = initConfig(config);
    this.express = express;
    this.app = express();

    const { adminUI, cookieSecret, sessionStore } = this.config;

    if (falsey(process.env.DISABLE_LOGGING)) {
      this.app.use(require('express-pino-logger')(this.config.pinoOptions));
    }

    if (this.config.cors) {
      this.app.use(cors(this.config.cors));
    }

    if (Object.keys(keystone.auth).length > 0) {
      this.app.use(sessionCommonMiddleware(this.keystone, cookieSecret, sessionStore));
    }

    if (adminUI && adminUI.authStrategy) {
      // Inject the Admin specific session routes.
      // ie; this includes the signin/signout UI
      this.app.use(adminUI.createSessionMiddleware());
    }

    // GraphQL API always exists independent of any adminUI or Session settings
    const { apollo } = this.config;
    const schemaName = 'admin';
    const accessRestriction = null;
    const server = createApolloServer(keystone, apollo, schemaName, accessRestriction);

    const { apiPath, graphiqlPath, port } = this.config;
    this.app.use(createGraphQLMiddleware(server, { apiPath, graphiqlPath, port }));

    if (adminUI) {
      // This must be last as it's the "catch all" which falls into Webpack to
      // serve the Admin UI.
      this.app.use(adminUI.createDevMiddleware({ apiPath, graphiqlPath, port }));
    }
  }

  async start(...args) {
    const {
      app,
      config: { port },
    } = this;

    await this.keystone.connect(...args);
    return new Promise((resolve, reject) => {
      app.get('/', (req, res) => res.sendFile(path.resolve(__dirname, './default.html')));

      app.listen(port, error => {
        if (error) {
          return reject(error);
        }
        return resolve({ port });
      });
    });
  }
};
