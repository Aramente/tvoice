// Session manager: one terminal session = one tmux session + one node-pty
// process attaching to it. Node-pty can die (client disconnect, crash) without
// killing the underlying tmux session. On reconnect, a new node-pty is spawned
// that attaches to the existing tmux session.

import { spawn as ptySpawn } from 'node-pty';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { RingBuffer } from './ring-buffer.js';
import { audit } from './audit.js';

const execFileP = promisify(execFile);

export class SessionManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();  // id -> Session
    this.tmuxAvailable = null;  // null until probed
    this.reaperTimer = null;
  }

  async init() {
    this.tmuxAvailable = await probeTmux();
    this.startIdleReaper();
  }

  // Periodically kill sessions that have been idle for more than
  // `sessionTimeoutMin` (default 7 days from config). Prevents orphan
  // tmux sessions from accumulating forever on a long-running server.
  startIdleReaper() {
    const intervalMs = 15 * 60 * 1000; // check every 15 minutes
    const timeoutMs = (this.cfg.sessionTimeoutMin || 7 * 24 * 60) * 60 * 1000;
    this.reaperTimer = setInterval(async () => {
      const now = Date.now();
      const stale = [];
      for (const s of this.sessions.values()) {
        if (now - s.lastActivity > timeoutMs) stale.push(s.id);
      }
      for (const id of stale) {
        try { await this.closeSession(id); } catch { /* ignore */ }
      }
    }, intervalMs);
    // Let the timer not block process exit
    if (this.reaperTimer.unref) this.reaperTimer.unref();
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => s.describe());
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  async createSession({ cols = 80, rows = 24, title = null, cwd = process.env.HOME } = {}) {
    const id = randomUUID().slice(0, 8);
    const s = new Session({
      id,
      cfg: this.cfg,
      cols,
      rows,
      title: title || `term-${id}`,
      cwd,
      tmuxAvailable: this.tmuxAvailable,
    });
    await s.spawn();
    this.sessions.set(id, s);
    s.on('exit', () => {
      audit('session.exit', { id });
      this.sessions.delete(id);
    });
    audit('session.create', { id, cols, rows, tmuxBacked: !!this.tmuxAvailable });
    return s;
  }

  async closeSession(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    await s.kill();
    audit('session.close', { id });
    this.sessions.delete(id);
  }

  async shutdown() {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    const jobs = [];
    for (const s of this.sessions.values()) {
      jobs.push(s.kill().catch(() => {}));
    }
    await Promise.all(jobs);
    this.sessions.clear();
  }
}

class Session {
  constructor({ id, cfg, cols, rows, title, cwd, tmuxAvailable }) {
    this.id = id;
    this.cfg = cfg;
    this.cols = cols;
    this.rows = rows;
    this.title = title;
    this.cwd = cwd;
    this.tmuxAvailable = tmuxAvailable;
    this.tmuxName = `${cfg.tmuxPrefix}-${id}`;
    this.pty = null;
    this.buffer = new RingBuffer(cfg.bufferKB * 1024);
    this.listeners = { data: [], exit: [], title: [] };
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    // Claude Code detection state
    this.aiMode = { detected: false, awaiting: false };
  }

  async spawn() {
    let cmd, args;
    if (this.tmuxAvailable) {
      cmd = 'tmux';
      args = [
        'new-session',
        '-A',                        // attach if exists, else create
        '-s', this.tmuxName,
        '-x', String(this.cols),
        '-y', String(this.rows),
      ];
    } else {
      cmd = process.platform === 'win32'
        ? (process.env.COMSPEC || 'cmd.exe')
        : (process.env.SHELL || '/bin/bash');
      args = process.platform === 'win32' ? [] : ['-l'];
    }

    this.pty = ptySpawn(cmd, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TVOICE_SESSION_ID: this.id,
      },
    });

    this.pty.onData((data) => {
      this.buffer.push(data);
      this.lastActivity = Date.now();
      this.scanForAIMarkers(data);
      this.emit('data', data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.emit('exit', { exitCode, signal });
    });
  }

  on(event, handler) {
    this.listeners[event] ??= [];
    this.listeners[event].push(handler);
  }

  off(event, handler) {
    if (!this.listeners[event]) return;
    const idx = this.listeners[event].indexOf(handler);
    if (idx >= 0) this.listeners[event].splice(idx, 1);
  }

  emit(event, payload) {
    const list = this.listeners[event];
    if (!list) return;
    for (const fn of list) {
      try { fn(payload); } catch (err) { /* swallow */ }
    }
  }

  write(data) {
    if (!this.pty) return;
    this.pty.write(data);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.pty) {
      try { this.pty.resize(cols, rows); } catch { /* ignore */ }
    }
  }

  async kill() {
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }
    if (this.tmuxAvailable) {
      // Kill the underlying tmux session so it doesn't accumulate forever.
      try {
        await execFileP('tmux', ['kill-session', '-t', this.tmuxName]);
      } catch {
        /* session may already be gone */
      }
    }
  }

  describe() {
    return {
      id: this.id,
      title: this.title,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      aiMode: this.aiMode,
    };
  }

  // Scan a chunk of output for Claude Code markers. Best-effort heuristic —
  // the client layer also does its own rendering detection.
  scanForAIMarkers(chunk) {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    // Detected if we see a Claude Code prompt header
    if (!this.aiMode.detected) {
      if (/claude-code|Claude Code|claude > |⏵ /.test(text)) {
        this.aiMode.detected = true;
        this.emit('title', { aiMode: true });
      }
    }

    // Awaiting-input heuristic: common Claude Code confirm prompts
    if (/Do you want to proceed\?|\[y\/n\]|\(y\/N\)|\(yes\/no\)/i.test(text)) {
      this.aiMode.awaiting = true;
    } else if (this.aiMode.awaiting && /\n> $/.test(text)) {
      this.aiMode.awaiting = false;
    }
  }
}

async function probeTmux() {
  try {
    await execFileP('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}
