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
  rateLimitCheck,
  rateLimitGc,
  mintTotpPending,
  verifyTotpPending,
  deviceFingerprint,
} from './auth.js';
import { transcribe, status as whisperStatus } from './whisper.js';
import { audit, auditFromReq } from './audit.js';
import { generateSecret as totpGenerateSecret, buildOtpauthUri, buildQrSvg, verifyCode as totpVerifyCode } from './totp.js';
import { saveConfig } from './config.js';

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
      auditFromReq('login.rate_limited', req);
      res.status(429).send('Too many attempts. Try again later.');
      return;
    }
    try {
      await consumeLoginToken(cfg, token);
    } catch (err) {
      auditFromReq('login.failed', req, { reason: err.message });
      const loginHtml = await readFile(join(PUBLIC_DIR, 'login.html'), 'utf8')
        .catch(() => '<h1>Login</h1><p>Token required</p>');
      res.status(401).type('html').send(
        loginHtml.replace('{{ERROR}}', err.message).replace('{{VAPID}}', '')
      );
      return;
    }
    resetRateLimit(ip);

    // Fork on TOTP: if enabled, the burn-token gets the user to the
    // second-factor page only, not the full PWA. We set a short-lived
    // pending cookie and redirect to /totp.html.
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    if (cfg.totpEnabled && cfg.totpSecret) {
      const pending = await mintTotpPending(cfg);
      res.cookie('tvoice_totp_pending', pending, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        maxAge: 5 * 60 * 1000,
        path: '/',
      });
      auditFromReq('login.totp_required', req);
      res.redirect('/totp.html');
      return;
    }

    const fp = deviceFingerprint(req);
    const access = await issueAccessToken(cfg, { fp });
    const cookieMaxAgeMs = (cfg.cookieTtlMin || 7 * 24 * 60) * 60 * 1000;
    res.cookie('tvoice_auth', access, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: cookieMaxAgeMs,
      path: '/',
    });
    auditFromReq('login.success', req, { cookieTtlMs: cookieMaxAgeMs, fp });
    push.notifyAll({
      title: 'Tvoice: new login',
      body: `New session from ${ip}`,
      tag: 'tvoice-login',
      requireInteraction: false,
    }).catch(() => {});
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

  router.post('/api/logout', auth, (req, res) => {
    res.clearCookie('tvoice_auth', { path: '/' });
    auditFromReq('logout', req);
    res.json({ ok: true });
  });

  router.get('/api/sessions', auth, (_req, res) => {
    res.json({ sessions: sessions.listSessions() });
  });

  // Create a session from the CLI (tvoice --new). Returns the session
  // ID and tmux name so the CLI can tmux-attach to it. Also broadcasts
  // to all connected WS clients so the phone picks it up.
  router.post('/api/sessions/create', auth, async (req, res) => {
    try {
      const s = await sessions.createSession({
        cols: 80,
        rows: 24,
        title: req.body?.title || null,
      });
      if (sessions._broadcast) {
        sessions._broadcast({ type: 'session.sync', sessions: sessions.listSessions() });
      }
      res.json({ id: s.id, tmuxName: s.tmuxName, title: s.title });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
    if (!sub || typeof sub.endpoint !== 'string') {
      return res.status(400).json({ error: 'bad subscription' });
    }
    // Only accept endpoints from known push services. This blocks a
    // malicious client from feeding a junk URL into the server's push
    // loop and turning tvoice into an outbound HTTP cannon.
    const ok = /^https:\/\/([a-z0-9.-]+\.)?(googleapis\.com|mozilla\.com|windows\.com|apple\.com|push\.services\.mozilla\.com|wns2-.*\.notify\.windows\.com)\//i
      .test(sub.endpoint);
    if (!ok) {
      return res.status(400).json({ error: 'endpoint not in allowlist of push services' });
    }
    if (sub.endpoint.length > 2048) {
      return res.status(400).json({ error: 'endpoint too long' });
    }
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

  // ---------- TOTP second factor ----------
  //
  // Status is authenticated (you need a cookie to check whether 2FA is
  // enabled). Setup / confirm / disable all require a live cookie.
  // Verify is the ONLY TOTP endpoint that accepts the totp_pending cookie
  // instead of the real auth cookie — that's how you upgrade a pending
  // session into a real one.

  router.get('/api/totp/status', auth, (_req, res) => {
    res.json({
      enabled: !!cfg.totpEnabled,
      pending: !!cfg.totpPending,
    });
  });

  router.post('/api/totp/setup', auth, async (req, res) => {
    // Generate a fresh secret and stash it as pending. Return the
    // otpauth URI + an inline SVG QR so the client can render it
    // without any extra JS libraries.
    const secret = totpGenerateSecret();
    cfg.totpPending = secret;
    await saveConfig(cfg);
    const uri = buildOtpauthUri({ secret, account: 'tvoice', issuer: 'Tvoice' });
    const svg = await buildQrSvg(uri);
    auditFromReq('totp.setup_started', req);
    res.json({ secret, uri, svg });
  });

  router.post('/api/totp/confirm', auth, async (req, res) => {
    const { code } = req.body || {};
    if (!cfg.totpPending) return res.status(400).json({ error: 'no pending secret — call /api/totp/setup first' });
    if (!totpVerifyCode(cfg.totpPending, code)) {
      auditFromReq('totp.confirm_failed', req);
      return res.status(401).json({ error: 'code does not match' });
    }
    cfg.totpSecret = cfg.totpPending;
    cfg.totpEnabled = true;
    cfg.totpPending = null;
    await saveConfig(cfg);
    auditFromReq('totp.enabled', req);
    res.json({ ok: true, enabled: true });
  });

  router.post('/api/totp/verify', async (req, res) => {
    // Called from /totp.html with the 6-digit code. Uses the PENDING
    // cookie, not the auth cookie, because the user doesn't have an
    // auth cookie yet.
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    rateLimitGc();
    const rl = rateLimitCheck('totp_verify', ip, { max: 10, windowMs: 5 * 60_000 });
    if (!rl.ok) {
      auditFromReq('totp.verify_rate_limited', req);
      res.setHeader('Retry-After', Math.ceil(rl.retryMs / 1000));
      return res.status(429).json({ error: 'too many attempts' });
    }

    const cookies = parseCookies(req.headers.cookie || '');
    const pending = await verifyTotpPending(cfg, cookies.tvoice_totp_pending);
    if (!pending) {
      auditFromReq('totp.verify_no_pending', req);
      return res.status(401).json({ error: 'pending session expired — re-scan QR from CLI' });
    }

    const { code } = req.body || {};
    if (!cfg.totpEnabled || !cfg.totpSecret || !totpVerifyCode(cfg.totpSecret, code)) {
      auditFromReq('totp.verify_failed', req);
      return res.status(401).json({ error: 'code does not match' });
    }

    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const fp = deviceFingerprint(req);
    const access = await issueAccessToken(cfg, { fp });
    const cookieMaxAgeMs = (cfg.cookieTtlMin || 7 * 24 * 60) * 60 * 1000;
    res.cookie('tvoice_auth', access, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: cookieMaxAgeMs,
      path: '/',
    });
    res.clearCookie('tvoice_totp_pending', { path: '/' });
    auditFromReq('totp.verify_success', req, { fp });
    push.notifyAll({
      title: 'Tvoice: new login',
      body: `New session from ${ip} (2FA)`,
      tag: 'tvoice-login',
    }).catch(() => {});
    res.json({ ok: true, redirect: '/' });
  });

  router.post('/api/totp/disable', auth, async (req, res) => {
    // Require a fresh code so an attacker who stole the cookie can't
    // silently turn off 2FA on their way out.
    const { code } = req.body || {};
    if (!cfg.totpEnabled) return res.status(400).json({ error: 'not enabled' });
    if (!totpVerifyCode(cfg.totpSecret, code)) {
      auditFromReq('totp.disable_failed', req);
      return res.status(401).json({ error: 'code does not match' });
    }
    cfg.totpEnabled = false;
    cfg.totpSecret = null;
    cfg.totpPending = null;
    await saveConfig(cfg);
    auditFromReq('totp.disabled', req);
    res.json({ ok: true, enabled: false });
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

  // Accept raw audio bytes. Content-Type signals the container format.
  // Size limit: 3 MB is ample for ≤30 s of opus audio and caps resource
  // cost. Rate limit: 20 requests/minute per IP — whisper is the most
  // expensive endpoint in the app so it needs the tightest bucket.
  router.post(
    '/api/transcribe',
    auth,
    expressRaw({ type: 'audio/*', limit: '3mb' }),
    async (req, res) => {
      try {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        rateLimitGc();
        const rl = rateLimitCheck('transcribe', ip, { max: 20, windowMs: 60_000 });
        if (!rl.ok) {
          res.setHeader('Retry-After', Math.ceil(rl.retryMs / 1000));
          return res.status(429).json({ error: 'rate limited', retryMs: rl.retryMs });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'no audio body' });
        }
        // Allowlist of language codes we'll accept. 'auto' is the default.
        const requested = typeof req.query.lang === 'string' ? req.query.lang : 'auto';
        const allowed = new Set(['auto', 'en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'ja', 'zh', 'ko', 'ru']);
        const lang = allowed.has(requested) ? requested : 'auto';
        const ext = extForContentType(req.headers['content-type']);
        const t0 = Date.now();
        const text = await transcribe(req.body, { language: lang, ext });
        auditFromReq('transcribe', req, {
          bytes: req.body.length,
          lang,
          ms: Date.now() - t0,
          chars: text.length,
        });
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
      voiceLang: cfg.voiceLang || 'auto',
    });
  });
  router.post('/api/settings', auth, async (req, res) => {
    const { theme, snippets, fontSize, voiceLang } = req.body || {};
    if (theme !== undefined) cfg.theme = theme;
    if (Array.isArray(snippets)) cfg.snippets = snippets.slice(0, 200);
    if (Number.isFinite(fontSize)) cfg.fontSize = Math.max(8, Math.min(32, fontSize));
    if (typeof voiceLang === 'string') {
      const allowed = new Set(['auto', 'en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'ja', 'zh', 'ko', 'ru']);
      if (allowed.has(voiceLang)) cfg.voiceLang = voiceLang;
    }
    const { saveConfig } = await import('./config.js');
    await saveConfig(cfg);
    res.json({ ok: true });
  });

  return router;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
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
