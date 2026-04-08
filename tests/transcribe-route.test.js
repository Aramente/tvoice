// Tests for /api/transcribe and /api/voice/status — auth gating, body
// size limits, content-type handling, and the push-subscription allowlist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point every test at an isolated temp config dir BEFORE importing any
// server module. Without this, tests that hit /api/settings or
// /api/push/subscribe will silently clobber the user's real ~/.tvoice/
// config, destroying their jwt secret, vapid keys, and push subscriptions.
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tvoice-test-'));
process.env.TVOICE_CONFIG_DIR = TEST_CONFIG_DIR;

const { startServer } = await import('../src/server/index.js');
const { mintLoginToken } = await import('../src/server/auth.js');

process.on('exit', () => {
  try { rmSync(TEST_CONFIG_DIR, { recursive: true, force: true }); } catch {}
});

const TEST_CFG = {
  port: 0,
  host: '127.0.0.1',
  tunnel: 'none',
  tmuxPrefix: 'tvoice-test-trans',
  bufferKB: 64,
  jwtSecret: 'test-secret-trans',
  vapidPublic: 'BKf8J_PS4VtGMQdC4Ikf8LcS5Tql9vNl5GY5qg89D4_VX1U8xcVJGx0cOuqgvS-zgHdH7hHIoqHbFR4hTQbfhFI',
  vapidPrivate: 'yJf3aAb-nJnKZ4N-fNxbLzJGx0cOuqgvS-zgHdH7hHI',
  vapidSubject: 'mailto:test@localhost',
  pushSubscriptions: [],
};

async function boot() {
  const handles = await startServer({ ...TEST_CFG });
  const addr = handles.server.address();
  return { ...handles, base: `http://127.0.0.1:${addr.port}` };
}

async function authedFetch(base, path, init = {}) {
  // Log in first so we have a valid cookie
  const token = await mintLoginToken(TEST_CFG, { ttl: 60 });
  const login = await fetch(`${base}/login?t=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const headers = { ...(init.headers || {}), cookie };
  return fetch(`${base}${path}`, { ...init, headers });
}

test('/api/transcribe requires auth', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('/api/voice/status requires auth', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/api/voice/status`);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test('/api/voice/status returns the status shape when authenticated', async () => {
  const { base, close } = await boot();
  try {
    const res = await authedFetch(base, '/api/voice/status');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.ready, 'boolean');
    assert.ok('missing' in data);
  } finally {
    await close();
  }
});

test('/api/transcribe with empty body returns 400', async () => {
  const { base, close } = await boot();
  try {
    const res = await authedFetch(base, '/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: new Uint8Array(0),
    });
    // 400 for empty body, 503 if whisper isn't installed — both are valid
    // because either one precedes the other depending on install state.
    assert.ok([400, 503].includes(res.status), `unexpected ${res.status}`);
  } finally {
    await close();
  }
});

test('/api/push/subscribe rejects non-allowlisted endpoints', async () => {
  const { base, close } = await boot();
  try {
    const res = await authedFetch(base, '/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://evil.example.com/subscribe/xxx',
        keys: { p256dh: 'x', auth: 'y' },
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /allowlist/);
  } finally {
    await close();
  }
});

test('/api/push/subscribe accepts an FCM endpoint', async () => {
  const { base, close } = await boot();
  try {
    const res = await authedFetch(base, '/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: 'https://fcm.googleapis.com/fcm/send/real-subscription-id',
        keys: { p256dh: 'x', auth: 'y' },
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
  } finally {
    await close();
  }
});
