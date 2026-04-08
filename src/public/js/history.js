// Command history: locally stored (IndexedDB fallback to localStorage),
// scraped from terminal input between Enter keypresses.

const KEY = 'tvoice.history';
const MAX = 500;

export class CommandHistory {
  constructor() {
    this.items = this._load();
    this.current = '';
  }

  // Feed raw input characters. We accumulate until we see a CR/LF, then
  // store the accumulated line if it's non-empty and not a duplicate.
  observe(input) {
    for (const ch of input) {
      if (ch === '\r' || ch === '\n') {
        this._commit();
      } else if (ch === '\x7f' || ch === '\b') {
        this.current = this.current.slice(0, -1);
      } else if (ch >= ' ' && ch.charCodeAt(0) < 0x7f) {
        this.current += ch;
      }
      // Reset on control characters (Ctrl+C)
      if (ch === '\x03') this.current = '';
    }
  }

  _commit() {
    const line = this.current.trim();
    this.current = '';
    if (!line) return;
    if (this.items[this.items.length - 1] === line) return;
    this.items.push(line);
    if (this.items.length > MAX) {
      this.items.splice(0, this.items.length - MAX);
    }
    this._save();
  }

  clear() {
    this.items = [];
    this._save();
  }

  list() { return [...this.items].reverse(); }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  _save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.items));
    } catch { /* full / privacy mode */ }
  }
}
