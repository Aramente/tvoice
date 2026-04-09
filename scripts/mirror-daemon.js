#!/usr/bin/env node
// Mirror daemon — runs as a LaunchAgent, watches for new tvoice tmux
// sessions, and opens a Terminal.app window for each one automatically.
// When Kevin creates a tab on his phone, a terminal window pops up on
// his Mac with the same session. No manual `tmux attach` needed.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const PREFIX = process.env.TVOICE_TMUX_PREFIX || 'tvoice';
const POLL_MS = 1500;
const attached = new Set();

async function listTvoiceSessions() {
  try {
    const { stdout } = await execFileP('tmux', ['ls', '-F', '#{session_name}']);
    return stdout.trim().split('\n').filter((s) => s.startsWith(PREFIX + '-'));
  } catch {
    return [];
  }
}

async function openTerminalWindow(sessionName) {
  // Use osascript to tell Terminal.app to open a new window and run
  // tmux attach inside it. The window title shows the session name.
  const script = `
    tell application "Terminal"
      activate
      set newTab to do script "tmux attach -t ${sessionName}"
      set custom title of front window to "tvoice: ${sessionName}"
    end tell
  `;
  try {
    await execFileP('osascript', ['-e', script]);
    console.log(`[mirror] opened Terminal.app window for ${sessionName}`);
  } catch (err) {
    console.error(`[mirror] failed to open window for ${sessionName}:`, err.message);
  }
}

async function poll() {
  const sessions = await listTvoiceSessions();
  for (const name of sessions) {
    if (!attached.has(name)) {
      attached.add(name);
      await openTerminalWindow(name);
    }
  }
  // Clean up sessions that no longer exist
  for (const name of attached) {
    if (!sessions.includes(name)) {
      attached.delete(name);
    }
  }
}

console.log(`[mirror] watching for tmux sessions with prefix "${PREFIX}-"`);
setInterval(poll, POLL_MS);
poll();
