// Web Push client: registers the service worker, subscribes to push,
// sends subscription to the server.

export class PushClient {
  constructor() {
    this.registration = null;
    this.subscription = null;
    this.publicKey = null;
  }

  async init() {
    if (!('serviceWorker' in navigator)) return { ok: false, reason: 'no-service-worker' };
    try {
      this.registration = await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      return { ok: false, reason: 'register-failed', error: err.message };
    }
    try {
      const res = await fetch('/api/push/key', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        this.publicKey = data.publicKey;
      }
    } catch { /* ignore */ }
    return { ok: true };
  }

  isSupported() {
    return 'PushManager' in window && 'Notification' in window;
  }

  async enable() {
    if (!this.registration) {
      const r = await this.init();
      if (!r.ok) return r;
    }
    if (!this.isSupported()) return { ok: false, reason: 'unsupported' };
    if (!this.publicKey) return { ok: false, reason: 'no-vapid-key' };

    // iOS needs user interaction + installed PWA
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: 'denied' };

    const appServerKey = urlBase64ToUint8Array(this.publicKey);
    let sub;
    try {
      sub = await this.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey,
      });
    } catch (err) {
      return { ok: false, reason: 'subscribe-failed', error: err.message };
    }
    this.subscription = sub;
    try {
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
    } catch (err) {
      return { ok: false, reason: 'server-save-failed', error: err.message };
    }
    return { ok: true };
  }

  async sendTest() {
    await fetch('/api/push/test', {
      method: 'POST',
      credentials: 'same-origin',
    });
  }

  async disable() {
    if (this.subscription) {
      try {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: this.subscription.endpoint }),
        });
      } catch { /* ignore */ }
      try { await this.subscription.unsubscribe(); } catch { /* ignore */ }
      this.subscription = null;
    }
    return { ok: true };
  }
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}
