// xterm.js wrapper. Loads the global Terminal/FitAddon/SerializeAddon/WebLinksAddon
// constructors (loaded via <script> in index.html) and ties one instance to
// one WebSocket-backed remote session.

import { ReconnectingWS } from './reconnect.js';
import { ThemeManager } from './themes.js';

const Terminal = window.Terminal;
const FitAddon = window.FitAddon?.FitAddon;
const SerializeAddon = window.SerializeAddon?.SerializeAddon;
const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon;

export class TerminalSession {
  constructor({ container, sessionId = null, onState, onAIChange, onTitle, onData, onInput, fontSize = 14, theme = 'oled' }) {
    this.container = container;
    this.sessionId = sessionId;
    this.onState = onState || (() => {});
    this.onAIChange = onAIChange || (() => {});
    this.onTitle = onTitle || (() => {});
    this.onData = onData || (() => {});
    this.onInput = onInput || (() => {});
    this.term = null;
    this.fit = null;
    this.serialize = null;
    this.ws = null;
    this.attached = false;
    this.softWrap = false;
    this.fontSize = fontSize;
    this.theme = theme;
    this.titleText = '';
    this.aiMode = { detected: false, awaiting: false };
  }

  mount() {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', 'Menlo', 'Consolas', monospace",
      fontSize: this.fontSize,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      convertEol: false,
      theme: ThemeManager.get(this.theme),
      allowTransparency: false,
    });

    const fit = FitAddon ? new FitAddon() : null;
    const serialize = SerializeAddon ? new SerializeAddon() : null;
    const links = WebLinksAddon ? new WebLinksAddon() : null;
    if (fit) term.loadAddon(fit);
    if (serialize) term.loadAddon(serialize);
    if (links) term.loadAddon(links);

    term.open(this.container);
    try { term.focus(); } catch { /* ignore */ }

    term.onData((data) => {
      if (!this.ws) return;
      this.ws.send({ type: 'input', data });
      try { this.onInput(data); } catch { /* ignore */ }
    });

    term.onResize(({ cols, rows }) => {
      if (!this.ws) return;
      this.ws.send({ type: 'resize', cols, rows });
    });

    this.term = term;
    this.fit = fit;
    this.serialize = serialize;

    this.refit();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/ws`;

    this.ws = new ReconnectingWS({
      url: wsUrl,
      onStateChange: (s) => {
        this.onState(s);
        if (s === 'connected') this._handshake();
      },
      onMessage: (msg) => this._handleMessage(msg),
    });
    this.ws.connect();
  }

  _handshake() {
    const { cols, rows } = this.term;
    if (this.sessionId) {
      this.ws.send({ type: 'attach', sessionId: this.sessionId, cols, rows });
    } else {
      this.ws.send({ type: 'create', cols, rows, title: this.titleText || null });
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'created':
        this.sessionId = msg.session.id;
        this.titleText = msg.session.title;
        this.onTitle(this.titleText);
        this.attached = true;
        break;
      case 'attached':
        this.sessionId = msg.session.id;
        this.titleText = msg.session.title;
        this.onTitle(this.titleText);
        this.attached = true;
        if (msg.snapshot) {
          this.term.reset();
          this.term.write(msg.snapshot);
        }
        break;
      case 'data':
        this.term.write(msg.data);
        try { this.onData(msg.data); } catch { /* ignore */ }
        break;
      case 'title':
        if (msg.aiMode !== undefined) {
          this.aiMode.detected = !!msg.aiMode;
          this.onAIChange(this.aiMode);
        }
        break;
      case 'exit':
        this.term.writeln(`\r\n\x1b[90m[session exited with code ${msg.exitCode}]\x1b[0m`);
        this.attached = false;
        break;
      case 'error':
        this.term.writeln(`\r\n\x1b[31m[server error] ${msg.message}\x1b[0m`);
        break;
    }
  }

  sendInput(data) {
    if (!this.ws) return;
    this.ws.send({ type: 'input', data });
    try { this.term.focus(); } catch { /* ignore */ }
  }

  sendLine(text) {
    this.sendInput(text + '\r');
  }

  refit() {
    if (this.fit) {
      try { this.fit.fit(); } catch { /* ignore */ }
    }
  }

  setFontSize(n) {
    this.fontSize = n;
    if (this.term) this.term.options.fontSize = n;
    this.refit();
  }

  setTheme(name, custom = null) {
    this.theme = name;
    const t = name === 'custom' && custom ? custom : ThemeManager.get(name);
    if (this.term && t) this.term.options.theme = t;
  }

  setSoftWrap(enabled) {
    // xterm.js doesn't support reflow on fly well — we emulate by reducing cols.
    // Actually xterm wraps by default at cols; soft wrap is the default. We use
    // this flag for AI-prose rendering in the overlay layer.
    this.softWrap = !!enabled;
  }

  serializeState() {
    if (!this.serialize) return '';
    try { return this.serialize.serialize(); } catch { return ''; }
  }

  focus() {
    try { this.term.focus(); } catch { /* ignore */ }
  }

  dispose() {
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.term?.dispose(); } catch { /* ignore */ }
    this.ws = null;
    this.term = null;
  }
}
