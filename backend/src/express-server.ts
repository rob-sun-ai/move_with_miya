import express from 'express';

/**
 * The Express instance the HTTP app runs on. Express matches routes
 * case-insensitively by default, so /METRICS would reach the /metrics
 * handler; matching case means only the exact paths nginx's location rules
 * are written for reach a handler. The setting must be in place before
 * Nest's adapter creates the router.
 */
export function createExpressServer(): express.Express {
  const server = express();
  server.set('case sensitive routing', true);
  // Do not advertise the framework in every response.
  server.disable('x-powered-by');
  return server;
}
