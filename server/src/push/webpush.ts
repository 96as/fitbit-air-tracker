import webpush from 'web-push';
import type { Db } from '../db/index.js';

export interface AlarmPushPayload {
  type: 'prayer-alarm';
  prayer: string;
  reason: string;
  firedAtUtc: string;
  title: string;
  body: string;
}

/**
 * Web Push (VAPID) delivery with escalation: once an alarm fires, the payload
 * is re-sent every minute until the alarm is acknowledged (dismiss/snooze) or
 * the attempt budget runs out. Push is tier-1 delivery; Bedside Mode is the
 * offline guarantee (docs/ARCHITECTURE.md §5).
 */
export class PushService {
  readonly enabled: boolean;
  readonly publicKey?: string;
  private readonly escalations = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    cfg: { vapidPublicKey?: string; vapidPrivateKey?: string; vapidSubject: string },
  ) {
    this.enabled = Boolean(cfg.vapidPublicKey && cfg.vapidPrivateKey);
    this.publicKey = cfg.vapidPublicKey;
    if (this.enabled) {
      webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublicKey!, cfg.vapidPrivateKey!);
    }
  }

  async sendToUser(userId: string, payload: AlarmPushPayload): Promise<number> {
    if (!this.enabled) return 0;
    const subs = this.db.listPushSubscriptions(userId);
    let delivered = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          JSON.stringify(payload),
          { urgency: 'high', TTL: 120 },
        );
        delivered++;
      } catch (err) {
        this.db.logEvent('push.failed', userId, {
          endpoint: sub.endpoint,
          error: String(err),
        });
      }
    }
    return delivered;
  }

  /** Re-send every minute until the pending alarm is acknowledged. */
  startEscalation(userId: string, payload: AlarmPushPayload, maxAttempts = 10): void {
    this.stopEscalation(userId);
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (attempts > maxAttempts || !this.db.pendingAlarm(userId)) {
        this.stopEscalation(userId);
        return;
      }
      void this.sendToUser(userId, { ...payload, body: `${payload.body} (reminder ${attempts})` });
    }, 60_000);
    timer.unref?.();
    this.escalations.set(userId, timer);
  }

  stopEscalation(userId: string): void {
    const timer = this.escalations.get(userId);
    if (timer) clearInterval(timer);
    this.escalations.delete(userId);
  }
}
