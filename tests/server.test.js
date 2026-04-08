// Smoke tests using node:test. These exercise the happy paths without any
// real tmux, cloudflared, or browser — just making sure the server boots,
// routes respond, and auth gates work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate config writes — see transcribe-route.test.js for the why
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tvoice-test-'));
process.env.TVOICE_CONFIG_DIR = TEST_CONFIG_DIR;

const { startServer } = await import('../src/server/index.js');
const {
  mintLoginToken,
  issueAccessToken,
  verifyAccessToken,
} = await import('../src/server/auth.js');

process.on('exit', () => {
  try { rmSync(TEST_CONFIG_DIR, { recursive: true, force: true }); } catch {}
});

const TEST_CFG = {
  port: 0,                                // let OS pick
  host: '127.0.0.1',
  tunnel: 'none',
  tmuxPrefix: 'tvoice-test',
  bufferKB: 64,
  jwtSecret: 'test-secret-do-not-use-in-production',
  vapidPublic: 'BKf8J_PS4VtGMQdC4Ikf8LcS5Tql9vNl5GY5qg89D4_VX1U8xcVJGx0cOuqgvS-zgHdH7hHIoqHbFR4hTQbfhFI',
  vapidPrivate: 'yJf3aAb-nJnKZ4N-fNxbLzJGx0cOuqgvS-zgHdH7hHI',
  vapidSubject: 'mailto:test@localhost',
  pushSubscriptions: [],
};

async function boot() {
  const handles = await startServer({ ...TEST_CFG });
  const addr = handles.server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  return { ...handles, base };
}

test('auth tokens: mint and verify a login token', async () => {
  const token = await mintLoginToken(TEST_CFG, { ttl: 60 });
  assert.ok(typeof token === 'string' && token.length > 20);
});

test('access token: issue and verify', async () => {
  const access = await issueAccessToken(TEST_CFG);
  const decoded = await verifyAccessToken(TEST_CFG, access);
  assert.equal(decoded?.t, 'access');
});

test('server boots and /health responds', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(typeof data.version === 'string');
  } finally {
    await close();
  }
});

test('/ requires no auth but /api/me does', async () => {
  const { base, close } = await boot();
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Tvoice/);

    const me = await fetch(`${base}/api/me`);
    assert.equal(me.status, 401);
  } finally {
    await close();
  }
});

test('login flow: consume token, receive cookie, access /api/me', async () => {
  const { base, close } = await boot();
  try {
    const token = await mintLoginToken(TEST_CFG, { ttl: 60 });
    const login = await fetch(`${base}/login?t=${encodeURIComponent(token)}`, {
      redirect: 'manual',
    });
    // Server redirects to / on success
    assert.ok([302, 303].includes(login.status), `login status ${login.status}`);
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie?.includes('tvoice_auth='), 'auth cookie set');

    const authCookie = cookie.split(';')[0];
    const me = await fetch(`${base}/api/me`, {
      headers: { cookie: authCookie },
    });
    assert.equal(me.status, 200);
    const data = await me.json();
    assert.equal(data.ok, true);
  } finally {
    await close();
  }
});

test('login token: burn after use', async () => {
  const { base, close } = await boot();
  try {
    const token = await mintLoginToken(TEST_CFG, { ttl: 60 });
    const r1 = await fetch(`${base}/login?t=${encodeURIComponent(token)}`, { redirect: 'manual' });
    assert.ok([302, 303].includes(r1.status));
    const r2 = await fetch(`${base}/login?t=${encodeURIComponent(token)}`, { redirect: 'manual' });
    assert.equal(r2.status, 401);
  } finally {
    await close();
  }
});
