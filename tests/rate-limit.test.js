// Tests for the generic rate-limit check used on /api/transcribe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitCheck } from '../src/server/auth.js';

test('rateLimitCheck: first N-1 requests pass', () => {
  const key = 'test-first';
  const ip = '10.0.0.1';
  for (let i = 0; i < 5; i++) {
    const r = rateLimitCheck(key, ip, { max: 5, windowMs: 60_000 });
    assert.equal(r.ok, true);
  }
});

test('rateLimitCheck: (max+1)th request is rejected with retry time', () => {
  const key = 'test-reject';
  const ip = '10.0.0.2';
  for (let i = 0; i < 3; i++) rateLimitCheck(key, ip, { max: 3, windowMs: 60_000 });
  const r = rateLimitCheck(key, ip, { max: 3, windowMs: 60_000 });
  assert.equal(r.ok, false);
  assert.ok(r.retryMs > 0);
  assert.ok(r.retryMs <= 60_000);
});

test('rateLimitCheck: independent buckets per (key, ip)', () => {
  for (let i = 0; i < 3; i++) rateLimitCheck('t-a', '10.0.0.3', { max: 3, windowMs: 60_000 });
  // Same IP, different key
  const r1 = rateLimitCheck('t-b', '10.0.0.3', { max: 3, windowMs: 60_000 });
  assert.equal(r1.ok, true);
  // Same key, different IP
  const r2 = rateLimitCheck('t-a', '10.0.0.4', { max: 3, windowMs: 60_000 });
  assert.equal(r2.ok, true);
});

test('rateLimitCheck: window expires and bucket resets', async () => {
  const key = 'test-window';
  const ip = '10.0.0.5';
  // Use a tiny window so the test runs fast
  rateLimitCheck(key, ip, { max: 1, windowMs: 50 });
  const r1 = rateLimitCheck(key, ip, { max: 1, windowMs: 50 });
  assert.equal(r1.ok, false);
  await new Promise((r) => setTimeout(r, 80));
  const r2 = rateLimitCheck(key, ip, { max: 1, windowMs: 50 });
  assert.equal(r2.ok, true);
});
