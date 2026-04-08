// Append-only audit log. JSONL format, one event per line. Lives at
// $TVOICE_CONFIG_DIR/audit.log so tests get an isolated copy.
//
// Anything security-relevant gets logged here:
//   - server boot (with mode and bind host)
//   - login attempt (success/fail) with IP and user-agent
//   - session create / close
//   - transcribe request (size, language, duration, NOT audio)
//   - logout
//   - config load failures (e.g. bad permissions)
//
// What is NEVER logged:
//   - login tokens, JWT secrets, VAPID keys
//   - audio bytes
//   - terminal output
//   - shell commands the user types
//
// We don't rotate the file; the user can `rm` it whenever they want. The
// goal is "see what happened recently when something goes wrong", not
// long-term forensics.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, appendFile, chmod, stat } from 'node:fs/promises';

function getAuditPath() {
  const dir = process.env.TVOICE_CONFIG_DIR || join(homedir(), '.tvoice');
  return join(dir, 'audit.log');
}

let inited = false;
async function ensureFile() {
  if (inited) return;
  const dir = process.env.TVOICE_CONFIG_DIR || join(homedir(), '.tvoice');
  await mkdir(dir, { recursive: true });
  inited = true;
}

export async function audit(type, payload = {}) {
  try {
    await ensureFile();
    const entry = {
      ts: new Date().toISOString(),
      type,
      ...payload,
    };
    const path = getAuditPath();
    await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
    try { await chmod(path, 0o600); } catch { /* best effort */ }
  } catch {
    // Audit failures must never break the request being audited
  }
}

// Helper for HTTP route handlers — pulls IP and UA out of the request
// in a single call.
export function auditFromReq(type, req, extra = {}) {
  const ip = req?.ip || req?.socket?.remoteAddress || 'unknown';
  const ua = (req?.headers?.['user-agent'] || '').slice(0, 200);
  return audit(type, { ip, ua, ...extra });
}
