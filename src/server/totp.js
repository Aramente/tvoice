// TOTP (RFC 6238) second factor for the login flow.
//
// Lifecycle:
//   1. Drawer "Enable 2FA" → POST /api/totp/setup
//      Server generates a base32 secret, stores it as `totpPending`
//      (NOT yet active), returns the otpauth:// URI + an SVG QR code.
//   2. User scans the QR with Google Authenticator / 1Password / Authy.
//   3. Drawer "Confirm" with the 6-digit code → POST /api/totp/confirm
//      Server verifies the code matches the pending secret, then
//      promotes pending → active by setting `totpSecret = pending` and
//      `totpEnabled = true`. Until this confirmation, login is unaffected.
//   4. Login flow with TOTP enabled:
//        /login?t=TOKEN consumes the burn-token as before, but instead
//        of issuing the long-lived auth cookie it issues a short-lived
//        `tvoice_totp_pending` cookie (5 min) and redirects to /totp.html.
//        /totp.html shows a 6-digit input. JS posts to /api/totp/verify
//        with the code. The endpoint validates the pending cookie + the
//        code, then issues the real `tvoice_auth` cookie and clears the
//        pending one.
//   5. Disable: POST /api/totp/disable with a current code → unsets
//      both totpSecret and totpEnabled.
//
// Recovery if the user loses their authenticator:
//   `node bin/tvoice.js --reset-totp` clears the secret from the host's
//   own config file. No second factor required because the user already
//   has filesystem access to the host — that IS the proof of identity.

import { authenticator } from 'otplib';
import QRCode from 'qrcode';

// Allow ±1 step (30 s either side) for clock drift
authenticator.options = { window: 1 };

export function generateSecret() {
  return authenticator.generateSecret();  // base32, 32 chars
}

export function buildOtpauthUri({ secret, account = 'tvoice', issuer = 'Tvoice' }) {
  return authenticator.keyuri(account, issuer, secret);
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
    return authenticator.check(cleaned, secret);
  } catch {
    return false;
  }
}
