// Tab manager. Each tab owns a TerminalSession + AIRenderer. Switching tabs
// hides the other xterm DOM nodes (we don't destroy them — the WebSocket
// stays open).

import { TerminalSession } from './terminal.js';
import { AIRenderer } from './ai-render.js';

export class TabManager {
  constructor({ host, tabsEl, onActiveChange, onAIStateChange, historyObserver, settings }) {
    this.host = host;
    this.tabsEl = tabsEl;
    this.onActiveChange = onActiveChange || (() => {});
    this.onAIStateChange = onAIStateChange || (() => {});
    this.historyObserver = historyObserver || null;
    this.settings = settings;
    this.tabs = [];  // { id, session, ai, containerEl, tabEl }
    this.activeId = null;
  }

  newTab({ sessionId = null } = {}) {
    const id = 'tab-' + Math.random().toString(36).slice(2, 8);

    const container = document.createElement('div');
    container.className = 'term-container';
    container.style.position = 'absolute';
    container.style.inset = '0';
    container.style.display = 'none';
    this.host.appendChild(container);

    const tabEl = document.createElement('button');
    tabEl.className = 'tab';
    tabEl.role = 'tab';
    tabEl.setAttribute('aria-selected', 'false');
    tabEl.innerHTML = `
      <span class="tab-ai-dot"></span>
      <span class="tab-label">…</span>
      <button class="tab-close" aria-label="Close tab">×</button>
    `;
    this.tabsEl.appendChild(tabEl);

    let tab;  // populated below, referenced in closures

    const ai = new AIRenderer({
      terminalSession: null,  // set after session is created
      onAIChange: (state) => {
        tabEl.dataset.ai = state.detected ? 'true' : 'false';
        if (tab && this.activeId === id) this.onAIStateChange(tab, state);
      },
      onAwaiting: (awaiting) => {
        tabEl.dataset.aiAwaiting = awaiting ? 'true' : 'false';
        if (tab && this.activeId === id) {
          this.onAIStateChange(tab, { detected: ai.detected, awaiting });
        }
      },
    });

    const session = new TerminalSession({
      container,
      sessionId,
      fontSize: this.settings?.fontSize || 14,
      theme: this.settings?.theme || 'oled',
      onTitle: (title) => {
        const labelEl = tabEl.querySelector('.tab-label');
        if (labelEl) labelEl.textContent = title || 'terminal';
      },
      onAIChange: (_mode) => {
        // Server-side detection is best-effort; client AIRenderer is authoritative
      },
      onData: (data) => {
        ai.feed(data);
      },
      onInput: (input) => {
        if (this.historyObserver) this.historyObserver.observe(input);
      },
      onState: (_state) => { /* delegated to conn-status in app.js */ },
    });
    ai.session = session;

    tab = { id, session, ai, containerEl: container, tabEl };
    this.tabs.push(tab);

    session.mount();
    session.connect();

    tabEl.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) {
        e.stopPropagation();
        this.closeTab(id);
        return;
      }
      this.activate(id);
    });

    this.activate(id);
    return tab;
  }

  activate(id) {
    this.activeId = id;
    for (const t of this.tabs) {
      const selected = t.id === id;
      t.containerEl.style.display = selected ? 'block' : 'none';
      t.tabEl.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) {
        // Refit on activation since the container size may have changed
        setTimeout(() => {
          t.session.refit();
          t.session.focus();
        }, 0);
      }
    }
    this.onActiveChange(this.activeTab());
  }

  activeTab() {
    return this.tabs.find((t) => t.id === this.activeId) || null;
  }

  activeSession() {
    return this.activeTab()?.session || null;
  }

  activeAI() {
    return this.activeTab()?.ai || null;
  }

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    // Tell the server to kill the tmux session
    tab.session.ws?.send({ type: 'close' });
    tab.session.dispose();
    tab.tabEl.remove();
    tab.containerEl.remove();
    this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      const next = this.tabs[Math.max(0, idx - 1)];
      if (next) this.activate(next.id);
      else this.newTab();  // always keep at least one tab
    }
  }

  nextTab() {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(idx + 1) % this.tabs.length];
    this.activate(next.id);
  }
  prevTab() {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeId);
    const next = this.tabs[(idx - 1 + this.tabs.length) % this.tabs.length];
    this.activate(next.id);
  }

  refitAll() {
    for (const t of this.tabs) {
      if (t.id === this.activeId) {
        try { t.session.refit(); } catch { /* ignore */ }
      }
    }
  }

  applyFontSize(n) {
    for (const t of this.tabs) {
      t.session.setFontSize(n);
    }
  }

  applyTheme(name, custom = null) {
    for (const t of this.tabs) {
      t.session.setTheme(name, custom);
    }
  }
}
