// Main server entry. Builds Express, wires routes, attaches WebSocket, and
// boots the session manager. Returns handles for the CLI to manage lifecycle.

import express from 'express';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildRoutes } from './routes.js';
import { attachWebSocket } from './ws-handler.js';
import { SessionManager } from './session-manager.js';
import { PushDispatcher } from './push.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = resolve(__dirname, '../public');
const VENDOR_MAP = {
  '/vendor/xterm.js': '@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-serialize.js': '@xterm/addon-serialize/lib/addon-serialize.js',
  '/vendor/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
};

export async function startServer(cfg) {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Session manager
  const sessions = new SessionManager(cfg);
  await sessions.init();

  // Push dispatcher
  const push = new PushDispatcher(cfg);

  // Vendor assets (xterm + addons served from node_modules)
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  for (const [route, pkgPath] of Object.entries(VENDOR_MAP)) {
    let resolved;
    try {
      resolved = require.resolve(pkgPath);
    } catch {
      // package not installed yet; the install step will provide it
      continue;
    }
    app.get(route, (_req, res) => res.sendFile(resolved));
  }

  // Inject VAPID public key into index.html and login.html on the fly
  const injectVapid = async (filename) => {
    const raw = await readFile(join(PUBLIC_DIR, filename), 'utf8');
    return raw.replace(/\{\{VAPID_PUBLIC_KEY\}\}/g, cfg.vapidPublic || '');
  };

  // PWA shell is public — it boots, calls /api/me, and redirects internally
  // if unauthenticated. Actual terminal traffic runs over the WebSocket which
  // does require a valid auth cookie during the upgrade handshake.
  app.get('/', async (_req, res, next) => {
    try {
      const html = await injectVapid('index.html');
      res.type('html').send(html);
    } catch (err) { next(err); }
  });

  // Static assets from public/
  app.use('/static', express.static(PUBLIC_DIR, { fallthrough: true }));
  app.use('/icons', express.static(join(PUBLIC_DIR, 'icons'), { fallthrough: true }));
  app.use('/css',   express.static(join(PUBLIC_DIR, 'css'),   { fallthrough: true }));
  app.use('/js',    express.static(join(PUBLIC_DIR, 'js'),    { fallthrough: true }));

  // Routes (login, API, etc)
  app.use(buildRoutes({ cfg, sessions, push }));

  // Catch-all to /login if nothing matched and no auth
  app.use((req, res) => {
    if (req.accepts('html')) {
      res.redirect('/');
    } else {
      res.status(404).json({ error: 'not found' });
    }
  });

  // HTTP server
  const httpServer = http.createServer(app);
  attachWebSocket({ httpServer, cfg, sessions });

  await new Promise((resolve, reject) => {
    httpServer.listen(cfg.port, cfg.host, () => resolve());
    httpServer.once('error', reject);
  });

  // Also expose push dispatcher so CLI can emit lifecycle notifications
  return {
    app,
    server: httpServer,
    sessions,
    push,
    close: async () => {
      await sessions.shutdown();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
