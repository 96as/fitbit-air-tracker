import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { PushService } from '../push/webpush.js';
import type { TimetableService } from '../prayer/timetable.js';
import { timingKeyForPrayer } from '../prayer/timetable.js';
import { mcpTools } from '../mcp/index.js';
import {
  localDateString,
  type AlarmPolicy,
  type Prayer,
  type SleepStage,
  type WakeScheduler,
} from '@fitbit-air-tracker/core';

export interface ApiContext {
  db: Db;
  userId: string; // single-user scaffold
  timetable: TimetableService;
  scheduler: WakeScheduler;
  push: PushService;
  providerName: string;
  /** Recompute + reschedule tonight's alarms (after settings changes). */
  replan: () => Promise<void>;
}

interface SettingsBody {
  lat?: number;
  lng?: number;
  tz?: string;
  calcMethod?: number;
  madhab?: 0 | 1;
}

interface PolicyBody {
  prayer: Prayer;
  enabled?: boolean;
  windowMinutes?: number;
  deadlineOffsetMinutes?: number;
  preferredStages?: SleepStage[];
  snoozeMinutes?: number;
  maxSnoozes?: number;
}

export async function registerRoutes(app: FastifyInstance, ctx: ApiContext): Promise<void> {
  const user = () => ctx.db.getUser(ctx.userId)!;

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/v1/status', async () => ({
    provider: ctx.providerName,
    mockMode: ctx.providerName === 'mock',
    pushConfigured: ctx.push.enabled,
    scheduledAlarms: ctx.scheduler.scheduled.map((a) => ({
      prayer: a.policy.prayer,
      windowStartUtc: a.windowStartUtc.toISOString(),
      deadlineUtc: a.deadlineUtc.toISOString(),
      prayerTimeUtc: a.prayerTimeUtc.toISOString(),
      fired: a.fired,
    })),
  }));

  // ---- settings ------------------------------------------------------------

  app.get('/api/v1/settings', async () => ({
    user: user(),
    policies: ctx.db.getPolicies(ctx.userId),
  }));

  app.put<{ Body: SettingsBody }>('/api/v1/settings', async (req) => {
    const updated = ctx.db.updateUser(ctx.userId, req.body);
    await ctx.replan();
    return { user: updated };
  });

  app.put<{ Body: PolicyBody }>('/api/v1/alarms/policy', async (req, reply) => {
    const existing = ctx.db.getPolicy(ctx.userId, req.body.prayer);
    const policy: Omit<AlarmPolicy, 'id'> & { id?: string } = {
      id: existing?.id,
      userId: ctx.userId,
      prayer: req.body.prayer,
      enabled: req.body.enabled ?? existing?.enabled ?? true,
      windowMinutes: req.body.windowMinutes ?? existing?.windowMinutes ?? 45,
      deadlineOffsetMinutes: req.body.deadlineOffsetMinutes ?? existing?.deadlineOffsetMinutes ?? 20,
      preferredStages: req.body.preferredStages ?? existing?.preferredStages ?? ['light', 'awake'],
      snoozeMinutes: req.body.snoozeMinutes ?? existing?.snoozeMinutes ?? 5,
      maxSnoozes: req.body.maxSnoozes ?? existing?.maxSnoozes ?? 2,
    };
    const saved = ctx.db.upsertPolicy(policy);
    await ctx.replan();
    reply.code(200);
    return { policy: saved };
  });

  // ---- prayer times ----------------------------------------------------------

  app.get<{ Querystring: { date?: string } }>('/api/v1/prayer/timetable', async (req) => {
    const u = user();
    const date = req.query.date ?? localDateString(new Date(), u.tz);
    const times = await ctx.timetable.getForDate(u, date);
    return { date, timesUtc: times };
  });

  // ---- tonight's plan ----------------------------------------------------------

  app.get('/api/v1/plan/tonight', async () => {
    const u = user();
    const now = new Date();
    const plans = [];
    for (const policy of ctx.db.getPolicies(ctx.userId).filter((p) => p.enabled)) {
      const prayerTime = await ctx.timetable.nextOccurrence(u, timingKeyForPrayer(policy.prayer), now);
      if (!prayerTime) continue;
      const deadline = new Date(prayerTime.getTime() - policy.deadlineOffsetMinutes * 60_000);
      plans.push({
        prayer: policy.prayer,
        prayerTimeUtc: prayerTime.toISOString(),
        deadlineUtc: deadline.toISOString(),
        windowStartUtc: new Date(deadline.getTime() - policy.windowMinutes * 60_000).toISOString(),
        policy,
      });
    }
    plans.sort((a, b) => a.prayerTimeUtc.localeCompare(b.prayerTimeUtc));
    return { nowUtc: now.toISOString(), tz: u.tz, plans };
  });

  // ---- sleep data ----------------------------------------------------------------

  app.get<{ Querystring: { limit?: string } }>('/api/v1/sleep/sessions', async (req) => ({
    sessions: ctx.db.listSessions(ctx.userId, Number(req.query.limit ?? 30)),
  }));

  // ---- alarms ------------------------------------------------------------------------

  app.get('/api/v1/alarms/pending', async () => ({
    pending: ctx.db.pendingAlarm(ctx.userId) ?? null,
  }));

  app.get('/api/v1/alarms/events', async () => ({
    events: ctx.db.listAlarmEvents(ctx.userId),
  }));

  app.post<{ Body: { snooze?: boolean } }>('/api/v1/alarms/ack', async (req, reply) => {
    const pending = ctx.db.pendingAlarm(ctx.userId);
    if (!pending) {
      reply.code(404);
      return { error: 'no pending alarm' };
    }
    const type = req.body?.snooze ? 'snoozed' : 'dismissed';
    ctx.db.insertAlarmEvent({
      userId: ctx.userId,
      policyId: pending.policyId,
      type,
      tsUtc: new Date().toISOString(),
      detail: { acked: pending.id },
    });
    ctx.push.stopEscalation(ctx.userId);
    return { ok: true, type };
  });

  // ---- push --------------------------------------------------------------------------

  app.get('/api/v1/push/key', async () => ({ publicKey: ctx.push.publicKey ?? null }));

  app.post<{ Body: { endpoint: string; keys: Record<string, string> } }>(
    '/api/v1/push/subscribe',
    async (req) => {
      ctx.db.savePushSubscription(ctx.userId, req.body.endpoint, req.body.keys);
      return { ok: true };
    },
  );

  // ---- Google Health webhook (Phase 2 receiver, wired now) ------------------------------
  // Must ACK fast (<5 s): respond immediately, evaluate afterwards.

  app.post('/api/v1/webhooks/google-health', async (req, reply) => {
    ctx.db.logEvent('sync.received', ctx.userId, { source: 'webhook' });
    setImmediate(() => void ctx.scheduler.tick());
    reply.code(204);
  });

  // ---- AI-agent surface -------------------------------------------------------------------

  app.get('/api/v1/mcp/tools', async () => ({ tools: mcpTools }));

  // ---- demo helper: ring the bedside/push alarm ~now (for trying the UX) ---------------------

  app.post('/api/v1/demo/fire-test', async () => {
    const policy =
      ctx.db.getPolicy(ctx.userId, 'fajr') ?? ctx.db.getPolicies(ctx.userId)[0];
    if (!policy) return { ok: false, error: 'no policy' };
    ctx.db.insertAlarmEvent({
      userId: ctx.userId,
      policyId: policy.id,
      type: 'fired',
      reason: 'deadline',
      tsUtc: new Date().toISOString(),
      detail: { demo: true },
    });
    const payload = {
      type: 'prayer-alarm' as const,
      prayer: policy.prayer,
      reason: 'demo',
      firedAtUtc: new Date().toISOString(),
      title: 'Wake up for prayer 🕌 (test)',
      body: 'This is a test alarm from Fitbit Air Tracker.',
    };
    const delivered = await ctx.push.sendToUser(ctx.userId, payload);
    ctx.push.startEscalation(ctx.userId, payload);
    return { ok: true, pushDelivered: delivered };
  });
}
