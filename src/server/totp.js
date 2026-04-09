// TOTP (RFC 6238) second factor for the login flow.
//
// Lifecycle:
//   1. Drawer "Enable 2FA" → POST /api/totp/setup
//      Server generates a base32 secret, stores it as `totpPending`
//      (NOT yet active), returns the otpauth:// URI + an SVG QR code.
//   2. User scans the QR with Google Authenticator / 1Password / Authy.
//   3. Drawer "Confirm" with the 6-digit code → POST /api/totp/confirm
//      Server verifies the code against the pending secret, then
//      promotes pending → active (totpSecret, totpEnabled = true).
//   4. Login flow with TOTP enabled:
//        /login consumes the burn-token as before, but instead of
//        issuing the long-lived auth cookie it issues a short-lived
//        tvoice_totp_pending cookie (5 min) and redirects to
//        /totp.html. The client posts to /api/totp/verify with the
//        6-digit code. On success, the real auth cookie is issued.
//   5. Disable: POST /api/totp/disable with a current code as proof.
//
// Recovery if the user loses their authenticator:
//   `node bin/tvoice.js --reset-totp` clears the secret from the host's
//   own config file. No second factor required because the user already
//   has filesystem access to the host — that IS the proof of identity.

import {
  generateSecret as _generateSecret,
  generateSync,
  verifySync,
  generateURI,
} from 'otplib';
import QRCode from 'qrcode';

// otplib v13 functional API — the free functions include the default
// crypto plugin (noble) and base32 plugin (scure). The OTP class
// variant doesn't include them unless you pass them explicitly, which
// is why the class-based code throws CryptoPluginMissingError.

export function generateSecret() {
  return _generateSecret({ length: 20 });  // base32, 32 chars
}

export function buildOtpauthUri({ secret, account = 'tvoice', issuer = 'Tvoice' }) {
  return generateURI({
    strategy: 'totp',
    secret,
    label: account,
    issuer,
  });
}

export async function buildQrSvg(uri) {
  return QRCode.toString(uri, { type: 'svg', margin: 1, width: 240 });
}

export function verifyCode(secret, code) {
  if (!secret || typeof code !== 'string') return false;
  // Strip spaces / dashes — authenticator apps sometimes show "123 456"
  const cleaned = code.replace(/\s|-/g, '');
  if (!/^\d{6,8}$/.test(cleaned)) return false;
  try {
    // epochTolerance: 1 means ±1 step (±30 s) for clock drift.
    // otplib v13 returns { valid, delta, ... } instead of a bare boolean.
    const result = verifySync({
      strategy: 'totp',
      token: cleaned,
      secret,
      epochTolerance: 1,
    });
    return !!(result && result.valid);
  } catch {
    return false;
  }
}

// Test helper — generate a current code for a given secret
export function _generateCurrentCode(secret) {
  return generateSync({ strategy: 'totp', secret });
}
