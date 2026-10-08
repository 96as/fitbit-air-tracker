import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { PushService } from '../push/webpush.js';
import type { TimetableService } from '../prayer/timetable.js';
import { timingKeyForPrayer } from '../prayer/timetable.js';
import { mcpTools } from '../mcp/index.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  GoogleAuthError,
  buildAuthUrl,
  exchangeCode,
  localDateString,
  revokeToken,
  type AlarmPolicy,
  type Prayer,
  type SleepStage,
  type WakeScheduler,
} from '@fitbit-air-tracker/core';
import type { ServerGoogleHealth } from '../providers/googleHealth/index.js';

export interface ApiContext {
  db: Db;
  userId: string; // single-user scaffold
  timetable: TimetableService;
  scheduler: WakeScheduler;
  push: PushService;
  providerName: string;
  /** Recompute + reschedule tonight's alarms (after settings changes). */
  replan: () => Promise<void>;
  /** Google Health API sign-in (Web OAuth client) — see docs/GOOGLE_HEALTH_API.md. */
  google: ServerGoogleHealth & { clientId?: string; clientSecret?: string; redirectUri: string; webOrigin: string };
  /** Pull recent Google sleep sessions into the DB; resolves to the count saved. */
  syncGoogleSessions: () => Promise<number>;
}

const base64url = (b: Buffer) => b.toString('base64url');
/** PKCE + state for in-flight sign-ins (single-user server; expires after 10 min). */
const pendingSignIns = new Map<string, { verifier: string; createdAt: number }>();

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

  // ---- Google Health API sign-in ----------------------------------------------------------

  app.get('/api/v1/auth/google/status', async () => ({
    configured: ctx.google.configured,
    connected: await ctx.google.tokenManager.isConnected(),
    active: ctx.providerName === 'google_health',
    redirectUri: ctx.google.redirectUri,
  }));

  app.get('/api/v1/auth/google/start', async (_req, reply) => {
    if (!ctx.google.configured) {
      reply.code(400);
      return { error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in server/.env (see docs/GOOGLE_HEALTH_API.md)' };
    }
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    for (const [k, v] of pendingSignIns) if (Date.now() - v.createdAt > 600_000) pendingSignIns.delete(k);
    pendingSignIns.set(state, { verifier, createdAt: Date.now() });
    return reply.redirect(
      buildAuthUrl({ clientId: ctx.google.clientId!, redirectUri: ctx.google.redirectUri, codeChallenge: challenge, state }),
      302,
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/v1/auth/google/callback',
    async (req, reply) => {
      const back = (q: string) => reply.redirect(`${ctx.google.webOrigin}/connect?${q}`, 302);
      if (req.query.error) return back(`google=error&reason=${encodeURIComponent(req.query.error)}`);
      const pending = req.query.state ? pendingSignIns.get(req.query.state) : undefined;
      if (!req.query.code || !pending) return back('google=error&reason=invalid_state');
      pendingSignIns.delete(req.query.state!);
      try {
        const tokens = await exchangeCode({
          clientId: ctx.google.clientId!,
          clientSecret: ctx.google.clientSecret,
          code: req.query.code,
          codeVerifier: pending.verifier,
          redirectUri: ctx.google.redirectUri,
        });
        await ctx.google.store.save(tokens);
        ctx.db.logEvent('google.connected', ctx.userId, { scope: tokens.scope });
        void ctx.syncGoogleSessions().catch(() => undefined);
        return back('google=connected');
      } catch (err) {
        const reason = err instanceof GoogleAuthError ? (err.code ?? err.message) : String(err);
        ctx.db.logEvent('google.connect-failed', ctx.userId, { reason });
        return back(`google=error&reason=${encodeURIComponent(reason)}`);
      }
    },
  );

  app.delete('/api/v1/auth/google', async () => {
    const tokens = await ctx.google.store.load();
    if (tokens?.refreshToken) await revokeToken(tokens.refreshToken);
    await ctx.google.store.clear();
    ctx.db.logEvent('google.disconnected', ctx.userId);
    return { ok: true };
  });

  /** Day-one experiment: how fresh is the Fitbit Air data right now? */
  app.get('/api/v1/google/probe', async (_req, reply) => {
    if (!(await ctx.google.tokenManager.isConnected())) {
      reply.code(409);
      return { error: 'not connected to Google' };
    }
    const report = await ctx.google.provider.probe(ctx.userId);
    ctx.db.logEvent('google.probe', ctx.userId, { ...report });
    return report;
  });

  app.post('/api/v1/google/sync', async (_req, reply) => {
    if (!(await ctx.google.tokenManager.isConnected())) {
      reply.code(409);
      return { error: 'not connected to Google' };
    }
    return { saved: await ctx.syncGoogleSessions() };
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
