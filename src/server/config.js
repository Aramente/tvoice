// Config loader. Reads ~/.tvoice/config.json and environment variables,
// generates secrets on first run, and provides a single source of truth.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import webpush from 'web-push';

const CONFIG_DIR = join(homedir(), '.tvoice');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

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
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
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
  // Never persist runtime-only fields
  const { ...persistable } = cfg;
  await writeFile(CONFIG_FILE, JSON.stringify(persistable, null, 2), 'utf8');
  try {
    await chmod(CONFIG_FILE, 0o600);
  } catch {
    // best-effort on non-unix
  }
}

async function ensureConfigDir() {
  await mkdir(CONFIG_DIR, { recursive: true });
  try {
    await chmod(CONFIG_DIR, 0o700);
  } catch {
    // ignore
  }
}

export function getConfigPath() {
  return CONFIG_FILE;
}
