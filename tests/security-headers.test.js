// Verifies that the security headers added in src/server/index.js are
// actually set on every response and are sane.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/index.js';

const TEST_CFG = {
  port: 0,
  host: '127.0.0.1',
  tunnel: 'none',
  tmuxPrefix: 'tvoice-test-sec',
  bufferKB: 64,
  jwtSecret: 'test-secret',
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

test('every response sets X-Content-Type-Options: nosniff', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await close();
  }
});

test('every response sets X-Frame-Options: DENY', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  } finally {
    await close();
  }
});

test('every response sets Referrer-Policy: no-referrer', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  } finally {
    await close();
  }
});

test('CSP header blocks frame-ancestors and has object-src none', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src [^;]*wss:/);
  } finally {
    await close();
  }
});

test('Permissions-Policy allows microphone only from self', async () => {
  const { base, close } = await boot();
  try {
    const res = await fetch(`${base}/health`);
    const pp = res.headers.get('permissions-policy') || '';
    assert.match(pp, /microphone=\(self\)/);
    assert.match(pp, /camera=\(\)/);
  } finally {
    await close();
  }
});
