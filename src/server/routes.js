// Express routes. Intentionally minimal — most interactivity happens over the
// WebSocket channel.

import { Router } from 'express';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  consumeLoginToken,
  issueAccessToken,
  authMiddleware,
  checkRateLimit,
  resetRateLimit,
} from './auth.js';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = resolve(__dirname, '../public');

export function buildRoutes({ cfg, sessions, push }) {
  const router = Router();

  // ---------- Unauthenticated ----------

  // Login: exchange a one-time token for an access cookie
  router.get('/login', async (req, res) => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const rl = checkRateLimit(ip);
    if (!rl.ok) {
      res.status(429).send('Too many attempts. Try again later.');
      return;
    }
    try {
      await consumeLoginToken(cfg, token);
    } catch (err) {
      // Render login page so the user sees a real error
      const loginHtml = await readFile(join(PUBLIC_DIR, 'login.html'), 'utf8')
        .catch(() => '<h1>Login</h1><p>Token required</p>');
      res.status(401).type('html').send(
        loginHtml.replace('{{ERROR}}', err.message).replace('{{VAPID}}', '')
      );
      return;
    }
    resetRateLimit(ip);
    const access = await issueAccessToken(cfg);
    res.cookie('tvoice_auth', access, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    res.redirect('/');
  });

  // Health
  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: require('../../package.json').version });
  });

  // PWA manifest + service worker must be reachable without auth
  router.get('/manifest.webmanifest', (_req, res) => {
    res.type('application/manifest+json').sendFile(join(PUBLIC_DIR, 'manifest.webmanifest'));
  });
  router.get('/sw.js', (_req, res) => {
    res.type('application/javascript').sendFile(join(PUBLIC_DIR, 'sw.js'));
  });

  // ---------- Authenticated ----------
  const auth = authMiddleware(cfg);

  router.get('/api/me', auth, (req, res) => {
    res.json({ ok: true, user: req.auth.u });
  });

  router.post('/api/logout', auth, (_req, res) => {
    res.clearCookie('tvoice_auth', { path: '/' });
    res.json({ ok: true });
  });

  router.get('/api/sessions', auth, (_req, res) => {
    res.json({ sessions: sessions.listSessions() });
  });

  router.post('/api/sessions/:id/close', auth, async (req, res) => {
    await sessions.closeSession(req.params.id);
    res.json({ ok: true });
  });

  // Push notifications
  router.get('/api/push/key', auth, (_req, res) => {
    res.json({ publicKey: push.getPublicKey() });
  });
  router.post('/api/push/subscribe', auth, async (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
    await push.subscribe(sub);
    res.json({ ok: true });
  });
  router.post('/api/push/unsubscribe', auth, async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });
    await push.unsubscribe(endpoint);
    res.json({ ok: true });
  });
  router.post('/api/push/test', auth, async (_req, res) => {
    const r = await push.notifyAll({
      title: 'Tvoice',
      body: 'Push notifications are working.',
      tag: 'tvoice-test',
    });
    res.json(r);
  });

  // Theme + snippet storage (stored in config for single-user simplicity)
  router.get('/api/settings', auth, (_req, res) => {
    res.json({
      theme: cfg.theme || null,
      snippets: cfg.snippets || [],
      fontSize: cfg.fontSize || 14,
    });
  });
  router.post('/api/settings', auth, async (req, res) => {
    const { theme, snippets, fontSize } = req.body || {};
    if (theme !== undefined) cfg.theme = theme;
    if (Array.isArray(snippets)) cfg.snippets = snippets.slice(0, 200);
    if (Number.isFinite(fontSize)) cfg.fontSize = Math.max(8, Math.min(32, fontSize));
    const { saveConfig } = await import('./config.js');
    await saveConfig(cfg);
    res.json({ ok: true });
  });

  return router;
}
