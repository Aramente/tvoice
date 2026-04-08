// WebSocket with exponential-backoff reconnection and a pluggable message
// handler. The caller receives an object with send(), close(), onOpen,
// onMessage, onStateChange.

export class ReconnectingWS {
  constructor({ url, onMessage, onOpen, onStateChange, onClose }) {
    this.url = url;
    this.onMessage = onMessage || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onClose = onClose || (() => {});
    this.state = 'idle';
    this.attempt = 0;
    this.ws = null;
    this.shouldReconnect = true;
    this.pingTimer = null;
  }

  connect() {
    this.shouldReconnect = true;
    this._open();
  }

  _open() {
    this._setState('connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.attempt = 0;
      this._setState('connected');
      this._startPing();
      try { this.onOpen(); } catch { /* ignore */ }
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      try { this.onMessage(msg); } catch (err) { console.error(err); }
    };
    this.ws.onerror = () => { /* handled by onclose */ };
    this.ws.onclose = () => {
      this._stopPing();
      try { this.onClose(); } catch { /* ignore */ }
      if (this.shouldReconnect) {
        this._scheduleReconnect();
      } else {
        this._setState('closed');
      }
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    this.shouldReconnect = false;
    this._stopPing();
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  _scheduleReconnect() {
    this._setState('reconnecting');
    this.attempt += 1;
    const base = Math.min(500 * Math.pow(2, this.attempt - 1), 30_000);
    const jitter = Math.random() * 500;
    const delay = base + jitter;
    setTimeout(() => {
      if (this.shouldReconnect) this._open();
    }, delay);
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    try { this.onStateChange(s); } catch { /* ignore */ }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
      }
    }, 25_000);
  }
  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
