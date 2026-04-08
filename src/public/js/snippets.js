// Snippet storage — synced with the server /api/settings so they survive
// device changes.

// A few useful defaults — only seeded when the user has no snippets yet.
const DEFAULT_SNIPPETS = [
  { name: 'claude', body: 'claude' },
  { name: 'status', body: 'git status' },
  { name: 'log', body: 'git log --oneline -20' },
  { name: 'diff', body: 'git diff' },
  { name: 'ls', body: 'ls -la' },
  { name: 'vault', body: 'cd ~/my-vault' },
];

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
      if (this.items.length === 0) {
        this.items = DEFAULT_SNIPPETS.slice();
        await this.save();
      }
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
