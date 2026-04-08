// Snippet storage — synced with the server /api/settings so they survive
// device changes.

export class Snippets {
  constructor() {
    this.items = [];  // { name, body }
  }

  async load() {
    try {
      const res = await fetch('/api/settings', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      this.items = Array.isArray(data.snippets) ? data.snippets : [];
    } catch { /* ignore */ }
  }

  async save() {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snippets: this.items }),
      });
    } catch { /* ignore */ }
  }

  add(name, body) {
    if (!name || !body) return;
    this.items.push({ name: name.slice(0, 40), body: body.slice(0, 500) });
    this.save();
  }

  remove(idx) {
    if (idx < 0 || idx >= this.items.length) return;
    this.items.splice(idx, 1);
    this.save();
  }

  list() { return [...this.items]; }
}
