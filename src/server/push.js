// Web Push dispatcher. Stores subscriptions in the config file, dispatches
// notifications for command completion / agent input requests.

import webpush from 'web-push';
import { saveConfig } from './config.js';

export class PushDispatcher {
  constructor(cfg) {
    this.cfg = cfg;
    webpush.setVapidDetails(
      cfg.vapidSubject || 'mailto:tvoice@localhost',
      cfg.vapidPublic,
      cfg.vapidPrivate
    );
  }

  async subscribe(subscription) {
    // Dedupe by endpoint
    const existing = this.cfg.pushSubscriptions || [];
    const filtered = existing.filter((s) => s.endpoint !== subscription.endpoint);
    filtered.push(subscription);
    this.cfg.pushSubscriptions = filtered;
    await saveConfig(this.cfg);
  }

  async unsubscribe(endpoint) {
    const existing = this.cfg.pushSubscriptions || [];
    this.cfg.pushSubscriptions = existing.filter((s) => s.endpoint !== endpoint);
    await saveConfig(this.cfg);
  }

  getPublicKey() {
    return this.cfg.vapidPublic;
  }

  async notifyAll(payload) {
    const subs = this.cfg.pushSubscriptions || [];
    if (subs.length === 0) return { sent: 0, failed: 0 };

    const body = JSON.stringify(payload);
    let sent = 0, failed = 0;
    const dead = [];

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body);
          sent += 1;
        } catch (err) {
          failed += 1;
          if (err.statusCode === 404 || err.statusCode === 410) {
            dead.push(sub.endpoint);
          }
        }
      })
    );

    if (dead.length > 0) {
      this.cfg.pushSubscriptions = subs.filter((s) => !dead.includes(s.endpoint));
      await saveConfig(this.cfg);
    }

    return { sent, failed };
  }
}
