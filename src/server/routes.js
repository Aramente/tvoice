// Express routes. Intentionally minimal — most interactivity happens over the
// WebSocket channel.

import { Router, raw as expressRaw } from 'express';
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
import { transcribe, status as whisperStatus } from './whisper.js';

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

  // ---------- Speech-to-text via local Whisper ----------

  router.get('/api/voice/status', auth, async (_req, res) => {
    try {
      const st = await whisperStatus();
      res.json(st);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Accept raw audio bytes. Content-Type signals the container format
  // (audio/webm, audio/mp4, audio/ogg, etc.). ffmpeg handles whatever
  // the phone sent.
  router.post(
    '/api/transcribe',
    auth,
    expressRaw({ type: 'audio/*', limit: '15mb' }),
    async (req, res) => {
      try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'no audio body' });
        }
        const lang = typeof req.query.lang === 'string' ? req.query.lang : 'auto';
        const ext = extForContentType(req.headers['content-type']);
        const text = await transcribe(req.body, { language: lang, ext });
        res.json({ text });
      } catch (err) {
        const payload = { error: err.message };
        if (err.code) payload.code = err.code;
        if (err.hint) payload.hint = err.hint;
        if (err.missing) payload.missing = err.missing;
        res.status(err.code === 'NOT_INSTALLED' ? 503 : 500).json(payload);
      }
    }
  );

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

function extForContentType(ct) {
  const t = (ct || '').toLowerCase().split(';')[0].trim();
  switch (t) {
    case 'audio/webm':  return '.webm';
    case 'audio/ogg':   return '.ogg';
    case 'audio/mp4':
    case 'audio/x-m4a': return '.m4a';
    case 'audio/mpeg':  return '.mp3';
    case 'audio/wav':
    case 'audio/x-wav': return '.wav';
    default:            return '.webm';
  }
}
