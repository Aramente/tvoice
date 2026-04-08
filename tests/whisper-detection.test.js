// Tests for whisper.js detection and status — these don't exercise real
// transcription (that would need a full audio file + whisper installed)
// but they verify the status-shape contract the server/client depend on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { status, invalidateCache } from '../src/server/whisper.js';

test('status() returns an object with ready + binary + ffmpeg + model + missing + installHint', async () => {
  invalidateCache();
  const s = await status();
  assert.equal(typeof s, 'object');
  assert.equal(typeof s.ready, 'boolean');
  assert.ok('binary' in s);
  assert.ok('ffmpeg' in s);
  assert.ok('model' in s);
  assert.ok(Array.isArray(s.missing));
  // installHint is null when everything is present, string otherwise
  if (!s.ready) {
    assert.equal(typeof s.installHint, 'string');
    assert.ok(s.missing.length > 0);
  } else {
    assert.equal(s.installHint, null);
    assert.equal(s.missing.length, 0);
  }
});

test('status() missing list uses stable tokens', async () => {
  invalidateCache();
  const s = await status();
  const allowed = new Set(['whisper', 'ffmpeg', 'model']);
  for (const m of s.missing) {
    assert.ok(allowed.has(m), `unexpected missing token: ${m}`);
  }
});

test('status() binary path (when present) points to an absolute file', async () => {
  invalidateCache();
  const s = await status();
  if (s.binary) {
    assert.ok(s.binary.startsWith('/'), 'binary should be an absolute path');
  }
});
