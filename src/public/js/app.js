// Tvoice client bootstrap. Wires the tab manager, key toolbar, gestures,
// voice input, push notifications, and drawer UI.

import { setupViewport } from './viewport.js';
import { TabManager } from './tabs.js';
import { KeyToolbar } from './toolbar.js';
import { setupGestures } from './gestures.js';
import { VoiceInput } from './voice.js';
import { PushClient } from './push-client.js';
import { CommandHistory } from './history.js';
import { Snippets } from './snippets.js';
import { ThemeManager } from './themes.js';

const el = (id) => document.getElementById(id);
const $ = (sel) => document.querySelector(sel);

const app = {
  settings: { fontSize: 14, theme: 'oled', softWrap: false, customTheme: null },
  tabManager: null,
  toolbar: null,
  voice: null,
  push: null,
  history: new CommandHistory(),
  snippets: new Snippets(),
};

async function main() {
  // Gate on auth
  const authed = await checkAuth();
  if (!authed) {
    showLoginRequired();
    return;
  }

  await loadSettings();
  setupConnStatus();

  // Viewport + keyboard handling
  const vp = setupViewport({
    onResize: () => app.tabManager?.refitAll(),
  });

  // Tab manager
  app.tabManager = new TabManager({
    host: el('terminal-host'),
    tabsEl: el('tabs'),
    settings: app.settings,
    historyObserver: app.history,
    onActiveChange: (tab) => {
      // Refresh toolbar AI state for the new active tab
      if (tab?.ai) {
        app.toolbar?.setAIActive(tab.ai.detected);
        app.toolbar?.setAIAwaiting(tab.ai.awaiting);
      } else {
        app.toolbar?.setAIActive(false);
        app.toolbar?.setAIAwaiting(false);
      }
    },
    onAIStateChange: (_tab, state) => {
      app.toolbar?.setAIActive(state.detected);
      app.toolbar?.setAIAwaiting(state.awaiting);
      if (state.awaiting) {
        maybeBuzz();
      }
    },
  });

  // Pick up existing tmux sessions if any (orphans from a previous connection)
  const existing = await fetchExistingSessions();
  if (existing.length > 0) {
    showSessionPicker(existing);
  } else {
    app.tabManager.newTab();
  }

  // Toolbar
  app.toolbar = new KeyToolbar({
    root: el('key-toolbar'),
    terminalSession: null,  // updated per-active-tab via proxy below
    onExpand: (_expanded) => app.tabManager.refitAll(),
    onAI: (action) => handleToolbarAction(action),
  });

  // Proxy toolbar input to active session
  const realSendInput = (data) => {
    const s = app.tabManager.activeSession();
    if (s) s.sendInput(data);
  };
  app.toolbar.session = { sendInput: realSendInput };
  app.toolbar.mount();

  // Gestures
  setupGestures({
    host: el('terminal-host'),
    onSwipeLeft: () => app.tabManager.nextTab(),
    onSwipeRight: () => app.tabManager.prevTab(),
    onPinch: ({ phase, ratio }) => {
      if (phase === 'start') app._pinchStartSize = app.settings.fontSize;
      if (phase === 'move' && app._pinchStartSize) {
        const next = Math.max(10, Math.min(24, Math.round(app._pinchStartSize * ratio)));
        if (next !== app.settings.fontSize) {
          setFontSize(next);
        }
      }
      if (phase === 'end') {
        app._pinchStartSize = null;
        persistSettings();
      }
    },
    onThreeFingerTap: async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) realSendInput(text);
      } catch { /* clipboard blocked */ }
    },
    onDoubleTap: async ({ x, y }) => {
      // Double-tap copies the row under the tap position to the clipboard.
      const s = app.tabManager.activeSession();
      if (!s?.term) return;
      const cell = pixelToCell(x, y, s.term);
      if (!cell) return;
      try {
        const buf = s.term.buffer.active;
        const line = buf.getLine(buf.viewportY + cell.row);
        const text = line ? line.translateToString(true).trim() : '';
        if (!text) { toast('Empty line', 'error'); return; }
        await navigator.clipboard.writeText(text);
        toast(`Copied: ${text.length > 40 ? text.slice(0, 40) + '…' : text}`, 'success');
      } catch (err) {
        toast('Copy failed: ' + err.message, 'error');
      }
    },
    // Long-press + drag selection
    onSelectStart: ({ x, y }) => {
      const s = app.tabManager.activeSession();
      if (!s?.term) return;
      const cell = pixelToCell(x, y, s.term);
      if (!cell) return;
      const absRow = s.term.buffer.active.viewportY + cell.row;
      app._selection = { term: s.term, anchor: { col: cell.col, row: absRow }, cursor: { col: cell.col, row: absRow } };
      try {
        s.term.select(cell.col, absRow, 1);
        if ('vibrate' in navigator) navigator.vibrate(10);
      } catch { /* ignore */ }
    },
    onSelectMove: ({ x, y }) => {
      const sel = app._selection;
      if (!sel) return;
      const cell = pixelToCell(x, y, sel.term);
      if (!cell) return;
      const absRow = sel.term.buffer.active.viewportY + cell.row;
      sel.cursor = { col: cell.col, row: absRow };
      const a = sel.anchor;
      const c = sel.cursor;
      const cols = sel.term.cols;
      const aOff = a.row * cols + a.col;
      const cOff = c.row * cols + c.col;
      const start = Math.min(aOff, cOff);
      const end = Math.max(aOff, cOff);
      const startRow = Math.floor(start / cols);
      const startCol = start % cols;
      const length = end - start + 1;
      try { sel.term.select(startCol, startRow, length); } catch { /* ignore */ }
    },
    onSelectEnd: async (info = {}) => {
      const sel = app._selection;
      if (!sel) return;
      if (info.cancelled) {
        try { sel.term.clearSelection(); } catch { /* ignore */ }
        app._selection = null;
        return;
      }
      let text = '';
      try { text = sel.term.getSelection() || ''; } catch { /* ignore */ }
      if (text.trim()) {
        try {
          await navigator.clipboard.writeText(text);
          toast(`Copied ${text.length} char${text.length === 1 ? '' : 's'}`, 'success');
        } catch {
          toast('Selected — tap "copy" in the expanded row to copy', 'info');
        }
      }
      // Keep the highlight briefly so the user sees what was captured, then clear
      setTimeout(() => {
        try { sel.term.clearSelection(); } catch { /* ignore */ }
      }, 1500);
      app._selection = null;
    },
  });

  // Helper — convert a screen pixel coordinate to a terminal cell (col, row).
  // `row` is relative to the visible viewport, not the absolute buffer.
  function pixelToCell(x, y, term) {
    const host = el('terminal-host');
    if (!host || !term) return null;
    // Prefer the xterm .xterm-screen element for accurate bounds
    const screen = host.querySelector('.xterm-screen') || term.element;
    if (!screen) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;
    const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / cellW)));
    const row = Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / cellH)));
    return { col, row };
  }

  // Drawer + modal wiring
  setupDrawer();
  setupPasteModal();

  // Voice input (lives in the drawer now)
  app.voice = new VoiceInput({
    onResult: (text) => realSendInput(text),
    onState: (state, err) => {
      const btn = el('voice-btn');
      if (btn) btn.classList.toggle('recording', state === 'listening');
      if (state === 'listening') toast('Listening…');
      if (state === 'error') toast(err || 'Voice error', 'error');
      if (state === 'unsupported') toast('Voice input not supported in this browser', 'error');
    },
  });
  el('voice-btn')?.addEventListener('click', () => {
    if (app.voice.active) app.voice.stop();
    else app.voice.start();
  });

  // Push client
  app.push = new PushClient();
  app.push.init();

  // Snippets
  await app.snippets.load();
  renderSnippets();

  // SW message listener (notification action clicks)
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data?.type === 'notification-action') {
        const action = ev.data.action;
        if (action === 'approve') realSendInput('y\r');
        if (action === 'deny')    realSendInput('n\r');
      }
    });
  }

  // Version
  try {
    const res = await fetch('/health');
    if (res.ok) {
      const { version } = await res.json();
      const v = el('version-info');
      if (v) v.textContent = `tvoice v${version}`;
    }
  } catch { /* ignore */ }

  // Periodic auth check — if the cookie expires mid-session, show the
  // login-required overlay so the user knows they need a fresh QR code.
  setInterval(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.status === 401) showLoginRequired();
    } catch { /* network blip, ignore */ }
  }, 60_000);
}

// ---------- Auth ----------

async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    return res.ok;
  } catch { return false; }
}

let _retryBound = false;
function showLoginRequired() {
  const overlay = el('login-required');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.setAttribute('aria-hidden', 'false');
  }
  if (_retryBound) return;
  const retry = el('retry-auth');
  if (retry) {
    retry.addEventListener('click', async () => {
      const ok = await checkAuth();
      if (ok) location.reload();
      else toast('Still not authenticated. Run `npx tvoice` on your Mac for a new QR code.', 'error');
    });
    _retryBound = true;
  }
}

// ---------- Settings ----------

async function loadSettings() {
  try {
    const res = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (Number.isFinite(data.fontSize)) app.settings.fontSize = data.fontSize;
    if (data.theme) {
      if (typeof data.theme === 'object') {
        app.settings.theme = 'custom';
        app.settings.customTheme = data.theme;
      } else {
        app.settings.theme = data.theme;
      }
    }
  } catch { /* ignore */ }
}

async function persistSettings() {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fontSize: app.settings.fontSize,
        theme: app.settings.theme === 'custom' ? app.settings.customTheme : app.settings.theme,
      }),
    });
  } catch { /* ignore */ }
}

function setFontSize(n) {
  app.settings.fontSize = n;
  app.tabManager.applyFontSize(n);
  const v = el('font-size-value');
  if (v) v.textContent = `${n}px`;
  const r = el('font-size');
  if (r) r.value = n;
}

function setTheme(name, custom = null) {
  app.settings.theme = name;
  app.settings.customTheme = custom;
  app.tabManager.applyTheme(name, custom);
}

// ---------- Drawer ----------

function setupDrawer() {
  const menu = el('menu-drawer');
  const history = el('history-drawer');

  el('menu-btn')?.addEventListener('click', () => menu.classList.remove('hidden'));
  el('new-tab-btn')?.addEventListener('click', () => app.tabManager.newTab());

  document.querySelectorAll('[data-drawer-close]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.target.closest('.drawer')?.classList.add('hidden');
    });
  });

  // Font size
  const sizeInput = el('font-size');
  sizeInput?.addEventListener('input', (e) => {
    setFontSize(parseInt(e.target.value, 10));
  });
  sizeInput?.addEventListener('change', () => persistSettings());

  // Soft wrap (AI prose)
  el('soft-wrap')?.addEventListener('change', (e) => {
    app.settings.softWrap = e.target.checked;
    for (const t of app.tabManager.tabs) t.session.setSoftWrap(app.settings.softWrap);
  });

  // Theme
  const themeSelect = el('theme-select');
  const customArea = el('custom-theme-json');
  themeSelect?.addEventListener('change', (e) => {
    const v = e.target.value;
    if (v === 'custom') {
      customArea?.classList.remove('hidden');
    } else {
      customArea?.classList.add('hidden');
      setTheme(v);
      persistSettings();
    }
  });
  customArea?.addEventListener('change', (e) => {
    const parsed = ThemeManager.parseCustom(e.target.value);
    if (!parsed) return toast('Invalid theme JSON', 'error');
    setTheme('custom', parsed);
    persistSettings();
  });

  // Push
  el('push-enable')?.addEventListener('click', async () => {
    const r = await app.push.enable();
    if (r.ok) toast('Push notifications enabled', 'success');
    else toast(`Push enable failed: ${r.reason}`, 'error');
  });
  el('push-test')?.addEventListener('click', async () => {
    await app.push.sendTest();
    toast('Test push sent', 'success');
  });

  // Snippets
  el('snippet-add')?.addEventListener('click', () => {
    const name = el('snippet-name').value.trim();
    const body = el('snippet-body').value.trim();
    if (!name || !body) return;
    app.snippets.add(name, body);
    el('snippet-name').value = '';
    el('snippet-body').value = '';
    renderSnippets();
  });

  // History
  el('history-show')?.addEventListener('click', () => {
    menu.classList.add('hidden');
    renderHistory();
    history.classList.remove('hidden');
  });

  // Logout
  el('logout-btn')?.addEventListener('click', async () => {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* ignore */ }
    location.reload();
  });
}

function renderSnippets() {
  const listEl = el('snippet-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  listEl.classList.add('snippet-list');
  const items = app.snippets.list();
  if (items.length === 0) {
    listEl.innerHTML = '<p class="muted small">No snippets yet.</p>';
    return;
  }
  items.forEach((snip, idx) => {
    const row = document.createElement('div');
    row.className = 'snippet-item';
    row.innerHTML = `
      <span class="snippet-name"></span>
      <span class="snippet-body"></span>
      <button class="snippet-run">run</button>
      <button class="snippet-delete">×</button>
    `;
    row.querySelector('.snippet-name').textContent = snip.name;
    row.querySelector('.snippet-body').textContent = snip.body;
    row.querySelector('.snippet-run').addEventListener('click', () => {
      const s = app.tabManager.activeSession();
      if (s) s.sendLine(snip.body);
      el('menu-drawer').classList.add('hidden');
    });
    row.querySelector('.snippet-delete').addEventListener('click', () => {
      app.snippets.remove(idx);
      renderSnippets();
    });
    listEl.appendChild(row);
  });
}

function renderHistory() {
  const listEl = el('history-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  const items = app.history.list();
  if (items.length === 0) {
    listEl.innerHTML = '<p class="muted small" style="padding:16px">No history yet.</p>';
    return;
  }
  for (const line of items) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.textContent = line;
    row.addEventListener('click', () => {
      const s = app.tabManager.activeSession();
      if (s) s.sendInput(line);
      el('history-drawer').classList.add('hidden');
    });
    listEl.appendChild(row);
  }
}

// ---------- Toolbar actions ----------

function handleToolbarAction(action) {
  if (action.tool === 'voice') {
    if (app.voice.active) app.voice.stop();
    else app.voice.start();
    return;
  }
  if (action.tool === 'snippets') {
    el('menu-drawer').classList.remove('hidden');
    return;
  }
  if (action.tool === 'copy') {
    handleCopy();
    return;
  }
  if (action.tool === 'paste') {
    handlePaste();
    return;
  }
  if (action.ai === 'collapse') {
    const ai = app.tabManager.activeAI();
    if (ai) ai.collapsedByDefault = !ai.collapsedByDefault;
    toast(ai?.collapsedByDefault ? 'Collapsing AI tool calls' : 'Expanding AI tool calls');
    return;
  }
  if (action.ai === 'scroll-ai') {
    const s = app.tabManager.activeSession();
    if (s?.term) {
      try { s.term.scrollToBottom(); } catch { /* ignore */ }
    }
  }
}

async function handleCopy() {
  const s = app.tabManager.activeSession();
  if (!s?.term) return;
  let text = '';
  try {
    text = s.term.getSelection() || '';
  } catch { /* ignore */ }
  if (!text) {
    // Fall back to copying the whole visible buffer so the button is always useful
    try {
      const buf = s.term.buffer.active;
      const lines = [];
      const start = buf.viewportY;
      const end = start + s.term.rows;
      for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      text = lines.join('\n').replace(/\n+$/, '');
    } catch { /* ignore */ }
  }
  if (!text) {
    toast('Nothing to copy — select text first or use "all"', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${text.length} char${text.length === 1 ? '' : 's'}`, 'success');
  } catch (err) {
    toast('Copy failed: ' + err.message, 'error');
  }
}

async function handlePaste() {
  // Try the silent clipboard API path first. If it works and returns text,
  // inject immediately. Otherwise (or if empty) fall back to the paste modal
  // — which works on iOS without any clipboard permission prompt because
  // the user does the paste via the native long-press menu on the textarea.
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        const s = app.tabManager.activeSession();
        if (s) s.sendInput(text);
        toast(`Pasted ${text.length} chars`, 'success');
        return;
      }
    }
  } catch {
    // permission denied or unsupported — fall through to modal
  }
  openPasteModal();
}

function openPasteModal() {
  const modal = el('paste-modal');
  const input = el('paste-input');
  if (!modal || !input) return;
  input.value = '';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  // Focus after the opening animation so iOS actually shows the keyboard
  setTimeout(() => { try { input.focus(); } catch {} }, 120);
}

function closePasteModal() {
  const modal = el('paste-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  const s = app.tabManager.activeSession();
  if (s) s.focus();
}

// ---------- Session picker (orphan tmux) ----------

async function fetchExistingSessions() {
  try {
    const res = await fetch('/api/sessions', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch { return []; }
}

async function closeSessionById(id) {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch { /* ignore */ }
}

function showSessionPicker(sessions) {
  const modal = el('session-picker');
  const list = el('session-list');
  if (!modal || !list) return;
  list.innerHTML = '';

  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.dataset.ai = s.aiMode?.detected ? 'true' : 'false';
    row.dataset.aiAwaiting = s.aiMode?.awaiting ? 'true' : 'false';
    const age = humanAge(Date.now() - (s.lastActivity || s.createdAt));
    row.innerHTML = `
      <span class="session-ai-dot"></span>
      <div class="session-info">
        <div class="session-title"></div>
        <div class="session-meta"></div>
      </div>
      <button class="session-delete" data-action="delete">×</button>
    `;
    row.querySelector('.session-title').textContent = s.title || s.id;
    row.querySelector('.session-meta').textContent =
      `${s.cols}×${s.rows} · last active ${age} ago`;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="delete"]')) return;
      hideSessionPicker();
      app.tabManager.newTab({ sessionId: s.id });
    });
    row.querySelector('.session-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      await closeSessionById(s.id);
      row.remove();
      if (list.children.length === 0) {
        hideSessionPicker();
        app.tabManager.newTab();
      }
    });
    list.appendChild(row);
  }

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');

  el('new-session-btn').onclick = () => {
    hideSessionPicker();
    app.tabManager.newTab();
  };
  el('close-all-sessions').onclick = async () => {
    const jobs = sessions.map((s) => closeSessionById(s.id));
    await Promise.all(jobs);
    hideSessionPicker();
    app.tabManager.newTab();
  };
}

function hideSessionPicker() {
  const modal = el('session-picker');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function humanAge(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function setupPasteModal() {
  const modal = el('paste-modal');
  if (!modal) return;
  document.querySelectorAll('[data-modal-close]').forEach((target) => {
    target.addEventListener('click', (e) => {
      if (e.target.closest('.modal') === modal) closePasteModal();
    });
  });
  el('paste-send')?.addEventListener('click', () => {
    const input = el('paste-input');
    const appendNl = el('paste-append-nl')?.checked;
    let text = input?.value || '';
    if (!text) {
      closePasteModal();
      return;
    }
    if (appendNl && !text.endsWith('\n') && !text.endsWith('\r')) text += '\r';
    const s = app.tabManager.activeSession();
    if (s) s.sendInput(text);
    closePasteModal();
  });
}


// ---------- Misc ----------

function setupConnStatus() {
  // We keep a single indicator that tracks the active tab's session state.
  // Called from tabs/terminal via a periodic poll.
  const statusEl = el('conn-status');
  const textEl = el('conn-text');
  setInterval(() => {
    const s = app.tabManager?.activeSession();
    const ws = s?.ws;
    const state = ws?.state || 'idle';
    if (!statusEl || !textEl) return;
    statusEl.classList.remove('connected', 'connecting', 'disconnected');
    if (state === 'connected') {
      statusEl.classList.add('connected');
      textEl.textContent = 'live';
    } else if (state === 'connecting' || state === 'reconnecting') {
      statusEl.classList.add('connecting');
      textEl.textContent = state;
    } else {
      statusEl.classList.add('disconnected');
      textEl.textContent = state;
    }
  }, 500);
}

function maybeBuzz() {
  try {
    if ('vibrate' in navigator) navigator.vibrate([40, 20, 40]);
  } catch { /* ignore */ }
}

function toast(msg, kind = 'info') {
  const stack = el('toast-stack');
  if (!stack) return;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  stack.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, 3500);
}

main().catch((err) => {
  console.error('Tvoice fatal:', err);
  toast(`Fatal: ${err.message}`, 'error');
});
