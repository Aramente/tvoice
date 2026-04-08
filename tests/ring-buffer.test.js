// Tests for the bounded ring buffer that backs WebSocket output replay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../src/server/ring-buffer.js';

test('RingBuffer: empty snapshot is empty string', () => {
  const rb = new RingBuffer(1024);
  assert.equal(rb.snapshot(), '');
});

test('RingBuffer: single push fits', () => {
  const rb = new RingBuffer(1024);
  rb.push('hello');
  assert.equal(rb.snapshot(), 'hello');
});

test('RingBuffer: small pushes accumulate', () => {
  const rb = new RingBuffer(1024);
  rb.push('a');
  rb.push('b');
  rb.push('c');
  assert.equal(rb.snapshot(), 'abc');
});

test('RingBuffer: oversize pushes drop the oldest chunks but keep the last', () => {
  const rb = new RingBuffer(10);
  rb.push('1234567890');           // 10 bytes — fills exactly
  rb.push('X');                    // 1 byte pushed, should drop chunk 1
  const snap = rb.snapshot();
  assert.ok(snap.endsWith('X'));
  assert.ok(snap.length <= 11);
});

test('RingBuffer: very large single push is retained as-is', () => {
  const rb = new RingBuffer(10);
  const bigChunk = 'x'.repeat(50);
  rb.push(bigChunk);
  assert.equal(rb.snapshot(), bigChunk);
});

test('RingBuffer: Buffer inputs work alongside strings', () => {
  const rb = new RingBuffer(100);
  rb.push('hello ');
  rb.push(Buffer.from('world'));
  assert.equal(rb.snapshot(), 'hello world');
});

test('RingBuffer: clear() empties the buffer', () => {
  const rb = new RingBuffer(1024);
  rb.push('data');
  rb.clear();
  assert.equal(rb.snapshot(), '');
  assert.equal(rb.totalBytes, 0);
});

test('RingBuffer: utf-8 multi-byte characters are handled', () => {
  const rb = new RingBuffer(100);
  rb.push('café ☕ 日本');
  assert.equal(rb.snapshot(), 'café ☕ 日本');
});
