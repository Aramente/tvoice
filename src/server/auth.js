// Authentication: JWT access tokens + one-time login tokens.
// Single-user model. Login tokens are minted by the CLI and exchanged for JWTs
// via the /login endpoint.

import jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const usedLoginTokens = new Set();       // burn-after-use
const loginTokenTTL = 15 * 60;           // 15 minutes
const jwtAccessTTL = 60 * 60 * 24 * 7;   // 7 days

// Rate limit state (in-memory, single process).
const loginAttempts = new Map();  // ip -> { count, firstAt }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

export async function mintLoginToken(cfg, { ttl = loginTokenTTL } = {}) {
  const payload = {
    t: 'login',
    nonce: randomBytes(16).toString('hex'),
  };
  return jwt.sign(payload, cfg.jwtSecret, { expiresIn: ttl });
}

export async function consumeLoginToken(cfg, token) {
  if (!token || typeof token !== 'string') throw new Error('missing token');
  let decoded;
  try {
    decoded = jwt.verify(token, cfg.jwtSecret);
  } catch (err) {
    throw new Error('invalid token');
  }
  if (decoded.t !== 'login') throw new Error('wrong token type');
  if (usedLoginTokens.has(decoded.nonce)) throw new Error('token already used');
  usedLoginTokens.add(decoded.nonce);
  // Best-effort cleanup — drop nonces after their max TTL
  setTimeout(() => usedLoginTokens.delete(decoded.nonce), loginTokenTTL * 1000 * 2).unref?.();
  return decoded;
}

export async function issueAccessToken(cfg) {
  return jwt.sign(
    { t: 'access', u: 'owner' },
    cfg.jwtSecret,
    { expiresIn: jwtAccessTTL }
  );
}

export async function verifyAccessToken(cfg, token) {
  if (!token || typeof token !== 'string') return null;
  try {
    const decoded = jwt.verify(token, cfg.jwtSecret);
    if (decoded.t !== 'access') return null;
    return decoded;
  } catch {
    return null;
  }
}

export function getAccessTokenFromRequest(req) {
  // Prefer cookie, fall back to Authorization header, fall back to ?token=
  const cookies = parseCookieHeader(req.headers.cookie || '');
  if (cookies.tvoice_auth) return cookies.tvoice_auth;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const url = req.url || '';
  const qIdx = url.indexOf('?');
  if (qIdx >= 0) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const t = params.get('token');
    if (t) return t;
  }
  return null;
}

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

export function authMiddleware(cfg) {
  return async (req, res, next) => {
    const token = getAccessTokenFromRequest(req);
    const claims = await verifyAccessToken(cfg, token);
    if (!claims) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    req.auth = claims;
    next();
  };
}

export function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) {
    loginAttempts.set(ip, { count: 1, firstAt: now });
    return { ok: true };
  }
  if (now - entry.firstAt > LOCKOUT_MS) {
    loginAttempts.set(ip, { count: 1, firstAt: now });
    return { ok: true };
  }
  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    const retryMs = LOCKOUT_MS - (now - entry.firstAt);
    return { ok: false, retryMs };
  }
  return { ok: true };
}

export function resetRateLimit(ip) {
  loginAttempts.delete(ip);
}

// Generic endpoint rate limiter — token bucket style. One bucket per
// (ip, key) combo. Call rateLimitCheck(key, ip, { max, windowMs }) before
// handling an expensive endpoint. Returns { ok, retryMs }.
const buckets = new Map();
export function rateLimitCheck(key, ip, { max = 30, windowMs = 60_000 } = {}) {
  const id = `${key}:${ip}`;
  const now = Date.now();
  let bucket = buckets.get(id);
  if (!bucket || now - bucket.firstAt > windowMs) {
    bucket = { count: 1, firstAt: now };
    buckets.set(id, bucket);
    return { ok: true };
  }
  bucket.count += 1;
  if (bucket.count > max) {
    return { ok: false, retryMs: windowMs - (now - bucket.firstAt) };
  }
  return { ok: true };
}

// Best-effort cleanup: on every Nth call, drop stale buckets.
let gcCounter = 0;
export function rateLimitGc(windowMs = 60_000) {
  gcCounter += 1;
  if (gcCounter % 50 !== 0) return;
  const cutoff = Date.now() - windowMs;
  for (const [id, bucket] of buckets.entries()) {
    if (bucket.firstAt < cutoff) buckets.delete(id);
  }
}

// Constant-time string comparison for passwords etc.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
