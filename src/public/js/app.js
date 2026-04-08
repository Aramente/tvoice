// Tvoice client bootstrap. Wires the tab manager, key toolbar, gestures,
// voice input, push notifications, and drawer UI.

import { setupViewport } from './viewport.js';
import { TabManager } from './tabs.js';
import { KeyToolbar } from './toolbar.js';
import { setupGestures } from './gestures.js';
import { VoiceInput } from './voice.js';
import { VoiceRecorder } from './voice-record.js';
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
    onLongPress: ({ x, y }) => startWordSelection(x, y),
    isSelectionActive: () => !!app._selection?.active,
    onTapOutsideSelection: () => clearSelection(),
  });

  // Wire up the draggable selection handles
  setupSelectionHandles();

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
  // Voice input — unified across platforms. MediaRecorder captures audio
  // (works in iOS Safari PWAs where SpeechRecognition is blocked), we
  // upload the blob to /api/transcribe on the Mac, and whisper.cpp runs
  // locally to turn it into text. Auto-stops on silence.
  setupVoiceFlow();

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

// ---------- Voice flow (record → whisper → inject) ----------

function setupVoiceFlow() {
  const overlay = el('voice-overlay');
  const ringEl = el('voice-ring');
  const statusEl = el('voice-status');
  const hintEl = el('voice-hint');
  const cancelBtn = el('voice-cancel');

  const showOverlay = () => {
    overlay.classList.remove('hidden', 'transcribing', 'error');
    overlay.setAttribute('aria-hidden', 'false');
    statusEl.textContent = 'Listening…';
    hintEl.textContent = "Speak — I'll stop when you pause";
  };
  const hideOverlay = () => {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.remove('transcribing', 'error');
    if (ringEl) ringEl.style.transform = '';
  };

  const startRecording = async () => {
    if (app._voiceRecorder?.active) {
      app._voiceRecorder.stop();
      return;
    }
    showOverlay();
    const rec = new VoiceRecorder({
      onStart: () => { /* overlay already visible */ },
      onLevel: (rms) => {
        if (!ringEl) return;
        // Scale ring from 0.6 to ~1.4 based on rms (clamped)
        const scale = 0.6 + Math.min(0.8, rms * 8);
        ringEl.style.transform = `scale(${scale})`;
        ringEl.style.opacity = String(0.4 + Math.min(0.5, rms * 6));
      },
      onError: (msg) => {
        overlay.classList.add('error');
        statusEl.textContent = 'Microphone error';
        hintEl.textContent = msg;
        setTimeout(hideOverlay, 2500);
      },
      onStop: async (blob, { cancelled }) => {
        if (cancelled || !blob || blob.size < 1000) {
          hideOverlay();
          return;
        }
        overlay.classList.add('transcribing');
        statusEl.textContent = 'Transcribing…';
        hintEl.textContent = 'whisper.cpp on your Mac, not the cloud';
        try {
          const res = await fetch('/api/transcribe?lang=auto', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': blob.type || 'audio/webm' },
            body: blob,
          });
          if (res.status === 503) {
            const err = await res.json().catch(() => ({}));
            showInstallHint(err);
            return;
          }
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const data = await res.json();
          const text = (data.text || '').trim();
          if (!text) {
            overlay.classList.add('error');
            statusEl.textContent = 'No speech detected';
            hintEl.textContent = 'Try again a little louder';
            setTimeout(hideOverlay, 1800);
            return;
          }
          const s = app.tabManager.activeSession();
          if (s) s.sendInput(text);
          toast(`Heard: ${text.length > 50 ? text.slice(0, 50) + '…' : text}`, 'success');
          hideOverlay();
        } catch (err) {
          overlay.classList.add('error');
          statusEl.textContent = 'Transcription failed';
          hintEl.textContent = err.message;
          setTimeout(hideOverlay, 3000);
        }
      },
    });
    app._voiceRecorder = rec;
    await rec.start();
  };

  const cancelRecording = () => {
    if (app._voiceRecorder?.active) {
      app._voiceRecorder.cancel();
    }
    hideOverlay();
  };

  el('voice-btn')?.addEventListener('click', startRecording);
  el('voice-header-btn')?.addEventListener('click', startRecording);
  cancelBtn?.addEventListener('click', cancelRecording);
  // Tap anywhere in the backdrop (not the panel) to cancel
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) cancelRecording();
  });

  // Visual pulse on the header mic while recording
  const headerBtn = el('voice-header-btn');
  const observer = new MutationObserver(() => {
    if (headerBtn) headerBtn.classList.toggle('recording', !overlay.classList.contains('hidden'));
  });
  if (overlay && headerBtn) observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
}

function showInstallHint(err) {
  const overlay = el('voice-overlay');
  const statusEl = el('voice-status');
  const hintEl = el('voice-hint');
  overlay.classList.add('error');
  overlay.classList.remove('transcribing');
  statusEl.textContent = 'Whisper not installed';
  const missing = (err.missing || []).join(', ');
  hintEl.textContent = missing
    ? `Missing: ${missing}. Run: ${err.hint?.split('\n')[0] || 'brew install whisper-cpp ffmpeg'} on your Mac.`
    : (err.hint || err.error || 'See README for setup.');
  // Leave it visible longer so the user can read the command
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  }, 6000);
}

// ---------- iOS-style text selection ----------
//
// Flow:
//   long-press on terminal → selectWord() picks the word under finger, sets
//     term.select() for that range, and positions the start + end handles
//     at the selection corners + shows the floating "Copy" button
//   drag a handle → handlePointerMove recomputes the selection range from
//     the dragged handle's pointer position while keeping the other anchor
//     fixed
//   tap the Copy button → writes term.getSelection() to the clipboard
//   tap anywhere else → clearSelection()
//
// app._selection shape:
//   { active, term, start: {col, absRow}, end: {col, absRow} }
// Both coordinates use ABSOLUTE buffer rows, not viewport-relative.

function pixelToCell(x, y, term) {
  const host = el('terminal-host');
  if (!host || !term) return null;
  const screen = host.querySelector('.xterm-screen') || term.element;
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const cellW = rect.width / term.cols;
  const cellH = rect.height / term.rows;
  const col = Math.max(0, Math.min(term.cols - 1, Math.floor((x - rect.left) / cellW)));
  const viewRow = Math.max(0, Math.min(term.rows - 1, Math.floor((y - rect.top) / cellH)));
  return { col, viewRow };
}

// Convert a (col, viewRow) pair to absolute pixel coordinates (client space).
function cellToPixel(col, viewRow, term, corner = 'tl') {
  const host = el('terminal-host');
  if (!host || !term) return null;
  const screen = host.querySelector('.xterm-screen') || term.element;
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  const cellW = rect.width / term.cols;
  const cellH = rect.height / term.rows;
  let x = rect.left + col * cellW;
  let y = rect.top + viewRow * cellH;
  if (corner === 'tr' || corner === 'br') x += cellW;
  if (corner === 'bl' || corner === 'br') y += cellH;
  return { x, y };
}

// Pick the word around (col, absRow) using the xterm buffer.
function detectWord(term, col, absRow) {
  const line = term.buffer.active.getLine(absRow);
  if (!line) return { startCol: col, endCol: col };
  const text = line.translateToString(true);
  const isWordChar = (ch) => ch && /[\w/.\-+@]/.test(ch);

  // If the tapped char is whitespace, just select the single cell
  if (!isWordChar(text[col])) return { startCol: col, endCol: col + 1 };

  let start = col;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  let end = col;
  while (end < text.length && isWordChar(text[end])) end++;
  return { startCol: start, endCol: end };
}

function startWordSelection(x, y) {
  const s = app.tabManager.activeSession();
  if (!s?.term) return;
  const cell = pixelToCell(x, y, s.term);
  if (!cell) return;
  const absRow = s.term.buffer.active.viewportY + cell.viewRow;
  const { startCol, endCol } = detectWord(s.term, cell.col, absRow);

  applySelectionRange(s.term, { col: startCol, absRow }, { col: endCol - 1 < startCol ? startCol : endCol - 1, absRow });

  app._selection = {
    active: true,
    term: s.term,
    start: { col: startCol, absRow },
    end: { col: endCol - 1 < startCol ? startCol : endCol - 1, absRow },
  };
  showSelectionHandles();
  try { if ('vibrate' in navigator) navigator.vibrate([6, 10, 6]); } catch { /* ignore */ }
}

function applySelectionRange(term, a, b) {
  // Normalise so lo <= hi, then ask xterm to highlight the contiguous
  // range via term.select(startCol, startRow, length).
  const cols = term.cols;
  const aOff = a.absRow * cols + a.col;
  const bOff = b.absRow * cols + b.col;
  const lo = Math.min(aOff, bOff);
  const hi = Math.max(aOff, bOff);
  const startRow = Math.floor(lo / cols);
  const startCol = lo % cols;
  const length = hi - lo + 1;
  try { term.select(startCol, startRow, length); } catch { /* ignore */ }
}

function showSelectionHandles() {
  const sel = app._selection;
  if (!sel) return;
  positionSelectionHandles();
  el('sel-handle-start')?.classList.remove('hidden');
  el('sel-handle-end')?.classList.remove('hidden');
  el('sel-copy-btn')?.classList.remove('hidden');
}

function positionSelectionHandles() {
  const sel = app._selection;
  if (!sel) return;
  const term = sel.term;
  // Translate absRows back to viewport-relative for pixel lookup
  const top = term.buffer.active.viewportY;
  const startViewRow = sel.start.absRow - top;
  const endViewRow   = sel.end.absRow   - top;

  const hStart = el('sel-handle-start');
  const hEnd   = el('sel-handle-end');
  const btn    = el('sel-copy-btn');
  const host   = el('terminal-host');
  if (!host) return;
  const hostRect = host.getBoundingClientRect();

  // Start handle lives at the top-left of the first selected cell
  const startPx = cellToPixel(sel.start.col, startViewRow, term, 'tl');
  if (startPx && hStart) {
    const visible = startViewRow >= 0 && startViewRow < term.rows;
    hStart.style.left = (startPx.x - hostRect.left) + 'px';
    hStart.style.top  = (startPx.y - hostRect.top) + 'px';
    hStart.classList.toggle('hidden', !visible);
  }
  // End handle lives at the bottom-right of the last selected cell
  const endPx = cellToPixel(sel.end.col, endViewRow, term, 'br');
  if (endPx && hEnd) {
    const visible = endViewRow >= 0 && endViewRow < term.rows;
    hEnd.style.left = (endPx.x - hostRect.left) + 'px';
    hEnd.style.top  = (endPx.y - hostRect.top) + 'px';
    hEnd.classList.toggle('hidden', !visible);
  }
  // Copy button sits above the end handle
  if (endPx && btn) {
    btn.style.left = (endPx.x - hostRect.left) + 'px';
    btn.style.top  = (endPx.y - hostRect.top) + 'px';
  }
}

function clearSelection() {
  if (!app._selection) return;
  try { app._selection.term.clearSelection(); } catch { /* ignore */ }
  app._selection = null;
  el('sel-handle-start')?.classList.add('hidden');
  el('sel-handle-end')?.classList.add('hidden');
  el('sel-copy-btn')?.classList.add('hidden');
}

function setupSelectionHandles() {
  const startH = el('sel-handle-start');
  const endH   = el('sel-handle-end');
  const btn    = el('sel-copy-btn');
  if (!startH || !endH || !btn) return;

  // Re-position when the terminal scrolls or resizes
  window.addEventListener('resize', () => {
    if (app._selection?.active) positionSelectionHandles();
  });

  // Re-position on xterm scroll so handles follow the buffer view
  const host = el('terminal-host');
  if (host) {
    host.addEventListener('scroll', () => {
      if (app._selection?.active) positionSelectionHandles();
    }, true);
  }

  bindHandleDrag(startH, 'start');
  bindHandleDrag(endH, 'end');

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const sel = app._selection;
    if (!sel) return;
    let text = '';
    try { text = sel.term.getSelection() || ''; } catch { /* ignore */ }
    if (!text) { toast('Nothing selected', 'error'); clearSelection(); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${text.length} char${text.length === 1 ? '' : 's'}`, 'success');
    } catch {
      // Clipboard API blocked — fall back: send the text into the paste modal
      // textarea so the user can at least long-press to copy it manually
      toast('Clipboard blocked — selection still visible', 'error');
      return;
    }
    clearSelection();
  });
}

function bindHandleDrag(handleEl, which) {
  let dragging = false;
  handleEl.addEventListener('pointerdown', (e) => {
    if (!app._selection) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    handleEl.classList.add('dragging');
    handleEl.setPointerCapture(e.pointerId);
  });
  handleEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const sel = app._selection;
    if (!sel) return;
    const cell = pixelToCell(e.clientX, e.clientY, sel.term);
    if (!cell) return;
    const absRow = sel.term.buffer.active.viewportY + cell.viewRow;
    if (which === 'start') sel.start = { col: cell.col, absRow };
    else                   sel.end   = { col: cell.col, absRow };
    applySelectionRange(sel.term, sel.start, sel.end);
    positionSelectionHandles();
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove('dragging');
    try { handleEl.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);
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
