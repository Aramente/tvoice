// Config loader. Reads ~/.tvoice/config.json and environment variables,
// generates secrets on first run, and provides a single source of truth.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';

// Config directory can be overridden via env var. Critical for tests —
// without this, any test that boots the server and touches /api/settings
// or /api/push/subscribe will happily clobber the user's real config at
// ~/.tvoice/config.json.
function getConfigDir() {
  return process.env.TVOICE_CONFIG_DIR || join(homedir(), '.tvoice');
}
function getConfigFile() {
  return join(getConfigDir(), 'config.json');
}

const DEFAULTS = {
  port: 3000,
  host: '127.0.0.1',
  tunnel: 'cloudflare',
  tmuxPrefix: 'tvoice',
  bufferKB: 256,
  sessionTimeoutMin: 60 * 24 * 7,  // 7 days
  jwtSecret: null,
  vapidPublic: null,
  vapidPrivate: null,
  vapidSubject: 'mailto:tvoice@localhost',
  pushSubscriptions: [],
};

export async function loadConfig() {
  await ensureConfigDir();
  let stored = {};
  const file = getConfigFile();
  try {
    // Refuse to load the config file if it's world-readable. This file
    // contains the JWT signing secret — anyone who can read it can mint
    // valid auth cookies and get an interactive shell. We auto-fix the
    // mode to 600 if we can; otherwise we throw and the server refuses
    // to start.
    try {
      const st = await stat(file);
      // On Unix, mode & 0o077 catches "any group or other bit set"
      const groupOrOther = st.mode & 0o077;
      if (groupOrOther !== 0 && process.platform !== 'win32') {
        try {
          await chmod(file, 0o600);
        } catch (e) {
          throw new Error(
            `Tvoice refuses to start: ${file} is readable by other users ` +
            `(mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 "${file}"`
          );
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const raw = await readFile(file, 'utf8');
    stored = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const cfg = { ...DEFAULTS, ...stored };

  // Environment variable overrides
  if (process.env.TVOICE_PORT) cfg.port = parseInt(process.env.TVOICE_PORT, 10);
  if (process.env.TVOICE_HOST) cfg.host = process.env.TVOICE_HOST;
  if (process.env.TVOICE_TUNNEL) cfg.tunnel = process.env.TVOICE_TUNNEL;
  if (process.env.TVOICE_JWT_SECRET) cfg.jwtSecret = process.env.TVOICE_JWT_SECRET;
  if (process.env.TVOICE_VAPID_PUBLIC) cfg.vapidPublic = process.env.TVOICE_VAPID_PUBLIC;
  if (process.env.TVOICE_VAPID_PRIVATE) cfg.vapidPrivate = process.env.TVOICE_VAPID_PRIVATE;
  if (process.env.TVOICE_VAPID_SUBJECT) cfg.vapidSubject = process.env.TVOICE_VAPID_SUBJECT;
  if (process.env.TVOICE_TMUX_PREFIX) cfg.tmuxPrefix = process.env.TVOICE_TMUX_PREFIX;
  if (process.env.TVOICE_BUFFER_KB) cfg.bufferKB = parseInt(process.env.TVOICE_BUFFER_KB, 10);

  // Generate missing secrets
  let mutated = false;
  if (!cfg.jwtSecret) {
    cfg.jwtSecret = randomBytes(32).toString('hex');
    mutated = true;
  }
  if (!cfg.vapidPublic || !cfg.vapidPrivate) {
    const keys = webpush.generateVAPIDKeys();
    cfg.vapidPublic = keys.publicKey;
    cfg.vapidPrivate = keys.privateKey;
    mutated = true;
  }

  if (mutated) await saveConfig(cfg);

  return cfg;
}

export async function saveConfig(cfg) {
  await ensureConfigDir();
  // Strip runtime-only fields that should never be persisted. Currently
  // that's nothing, but the spread leaves room to add denylist entries
  // without touching callers.
  const { ...persistable } = cfg;
  const file = getConfigFile();
  await writeFile(file, JSON.stringify(persistable, null, 2), 'utf8');
  try { await chmod(file, 0o600); } catch { /* best-effort on non-unix */ }
}

async function ensureConfigDir() {
  const dir = getConfigDir();
  await mkdir(dir, { recursive: true });
  try { await chmod(dir, 0o700); } catch { /* ignore */ }
}

export function getConfigPath() {
  return getConfigFile();
}
