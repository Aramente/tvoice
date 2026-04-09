// TOTP module smoke tests. No network, no server — just the pure
// functions in src/server/totp.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tvoice-test-'));
process.env.TVOICE_CONFIG_DIR = TEST_CONFIG_DIR;

const { generateSecret, buildOtpauthUri, buildQrSvg, verifyCode } = await import('../src/server/totp.js');
const { authenticator } = await import('otplib');

process.on('exit', () => {
  try { rmSync(TEST_CONFIG_DIR, { recursive: true, force: true }); } catch {}
});

test('generateSecret: returns a non-empty base32 string', () => {
  const s = generateSecret();
  assert.equal(typeof s, 'string');
  assert.ok(s.length >= 16);
  assert.match(s, /^[A-Z2-7]+$/);
});

test('buildOtpauthUri: includes issuer and account', () => {
  const secret = generateSecret();
  const uri = buildOtpauthUri({ secret, account: 'tvoice', issuer: 'Tvoice' });
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /Tvoice/);
  assert.match(uri, new RegExp(`secret=${secret}`));
});

test('buildQrSvg: returns valid SVG', async () => {
  const secret = generateSecret();
  const uri = buildOtpauthUri({ secret });
  const svg = await buildQrSvg(uri);
  assert.match(svg, /^<\?xml|^<svg/);
  assert.match(svg, /<\/svg>/);
});

test('verifyCode: accepts the current code', () => {
  const secret = generateSecret();
  const code = authenticator.generate(secret);
  assert.equal(verifyCode(secret, code), true);
});

test('verifyCode: rejects wrong codes', () => {
  const secret = generateSecret();
  assert.equal(verifyCode(secret, '000000'), false);
  assert.equal(verifyCode(secret, '999999'), false);
  assert.equal(verifyCode(secret, 'abcdef'), false);
});

test('verifyCode: accepts spaces and dashes in the code', () => {
  const secret = generateSecret();
  const code = authenticator.generate(secret);
  // Format the code with a space in the middle like some apps do
  const spaced = code.slice(0, 3) + ' ' + code.slice(3);
  assert.equal(verifyCode(secret, spaced), true);
  const dashed = code.slice(0, 3) + '-' + code.slice(3);
  assert.equal(verifyCode(secret, dashed), true);
});

test('verifyCode: rejects non-numeric input', () => {
  const secret = generateSecret();
  assert.equal(verifyCode(secret, ''), false);
  assert.equal(verifyCode(secret, 'hello'), false);
  assert.equal(verifyCode(secret, '12345'), false);   // too short
  assert.equal(verifyCode(secret, '123456789'), false);  // too long
});
