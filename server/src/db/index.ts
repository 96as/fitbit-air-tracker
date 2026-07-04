import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AlarmEvent,
  AlarmPolicy,
  Prayer,
  PrayerTimetableEntry,
  SleepSession,
  SleepStage,
  User,
} from '../types.js';

/**
 * Thin data-access layer over SQLite (node:sqlite, zero native deps).
 * All SQL lives here so the storage engine can be swapped (e.g. Postgres)
 * without touching business logic. See docs/ARCHITECTURE.md §3 for the model.
 */
export class Db {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    this.db.exec(schema);
  }

  // ---- users -------------------------------------------------------------

  /** Single-user scaffold: ensure the demo user + default Fajr policy exist. */
  seedDemoUser(): User {
    const existing = this.getDefaultUser();
    if (existing) return existing;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users (id, email, tz, lat, lng, calc_method, madhab)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, 'demo@example.com', 'Africa/Cairo', 30.0444, 31.2357, 5, 0);
    this.upsertPolicy({
      userId: id,
      prayer: 'fajr',
      enabled: true,
      windowMinutes: 45,
      deadlineOffsetMinutes: 20,
      preferredStages: ['light', 'awake'],
      snoozeMinutes: 5,
      maxSnoozes: 2,
    });
    return this.getDefaultUser()!;
  }

  getDefaultUser(): User | undefined {
    const row = this.db.prepare('SELECT * FROM users ORDER BY created_at LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    return row ? mapUser(row) : undefined;
  }

  getUser(id: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapUser(row) : undefined;
  }

  updateUser(id: string, patch: Partial<Omit<User, 'id'>>): User | undefined {
    const current = this.getUser(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        'UPDATE users SET email = ?, tz = ?, lat = ?, lng = ?, calc_method = ?, madhab = ? WHERE id = ?',
      )
      .run(next.email, next.tz, next.lat, next.lng, next.calcMethod, next.madhab, id);
    return this.getUser(id);
  }

  // ---- alarm policies ------------------------------------------------------

  getPolicies(userId: string): AlarmPolicy[] {
    const rows = this.db
      .prepare('SELECT * FROM alarm_policies WHERE user_id = ?')
      .all(userId) as Record<string, unknown>[];
    return rows.map(mapPolicy);
  }

  getPolicy(userId: string, prayer: Prayer): AlarmPolicy | undefined {
    const row = this.db
      .prepare('SELECT * FROM alarm_policies WHERE user_id = ? AND prayer = ?')
      .get(userId, prayer) as Record<string, unknown> | undefined;
    return row ? mapPolicy(row) : undefined;
  }

  upsertPolicy(p: Omit<AlarmPolicy, 'id'> & { id?: string }): AlarmPolicy {
    this.db
      .prepare(
        `INSERT INTO alarm_policies
           (id, user_id, prayer, enabled, window_min, deadline_offset_min,
            preferred_stages_json, snooze_min, max_snoozes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, prayer) DO UPDATE SET
           enabled = excluded.enabled,
           window_min = excluded.window_min,
           deadline_offset_min = excluded.deadline_offset_min,
           preferred_stages_json = excluded.preferred_stages_json,
           snooze_min = excluded.snooze_min,
           max_snoozes = excluded.max_snoozes`,
      )
      .run(
        p.id ?? randomUUID(),
        p.userId,
        p.prayer,
        p.enabled ? 1 : 0,
        p.windowMinutes,
        p.deadlineOffsetMinutes,
        JSON.stringify(p.preferredStages),
        p.snoozeMinutes,
        p.maxSnoozes,
      );
    return this.getPolicy(p.userId, p.prayer)!;
  }

  // ---- prayer timetable ----------------------------------------------------

  getTimetable(userId: string, dateLocal: string): PrayerTimetableEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM prayer_timetable WHERE user_id = ? AND date_local = ?')
      .all(userId, dateLocal) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      dateLocal: String(r.date_local),
      prayer: String(r.prayer),
      timeUtc: String(r.time_utc),
    }));
  }

  saveTimetable(
    userId: string,
    dateLocal: string,
    method: number,
    entries: { prayer: string; timeUtc: string }[],
    sourceJson?: string,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO prayer_timetable (id, user_id, date_local, prayer, time_utc, method, source_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, date_local, prayer, method) DO UPDATE SET
         time_utc = excluded.time_utc, source_json = excluded.source_json`,
    );
    for (const e of entries) {
      stmt.run(randomUUID(), userId, dateLocal, e.prayer, e.timeUtc, method, sourceJson ?? null);
    }
  }

  // ---- sleep data ------------------------------------------------------------

  saveSession(s: SleepSession): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sleep_sessions
           (id, user_id, start_utc, end_utc, tz_offset_min, is_nap, efficiency_pct, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.userId,
        s.startUtc,
        s.endUtc,
        s.tzOffsetMin,
        s.isNap ? 1 : 0,
        s.efficiencyPct ?? null,
        s.source,
      );
    this.db.prepare('DELETE FROM sleep_stages WHERE session_id = ?').run(s.id);
    const stmt = this.db.prepare(
      'INSERT INTO sleep_stages (id, session_id, stage, start_utc, end_utc) VALUES (?, ?, ?, ?, ?)',
    );
    for (const seg of s.stages) {
      stmt.run(randomUUID(), s.id, seg.stage, seg.startUtc, seg.endUtc);
    }
  }

  listSessions(userId: string, limit = 30): SleepSession[] {
    const rows = this.db
      .prepare('SELECT * FROM sleep_sessions WHERE user_id = ? ORDER BY start_utc DESC LIMIT ?')
      .all(userId, limit) as Record<string, unknown>[];
    return rows.map((r) => {
      const stages = this.db
        .prepare('SELECT * FROM sleep_stages WHERE session_id = ? ORDER BY start_utc')
        .all(String(r.id)) as Record<string, unknown>[];
      return {
        id: String(r.id),
        userId: String(r.user_id),
        startUtc: String(r.start_utc),
        endUtc: String(r.end_utc),
        tzOffsetMin: Number(r.tz_offset_min),
        isNap: Number(r.is_nap) === 1,
        efficiencyPct: r.efficiency_pct == null ? undefined : Number(r.efficiency_pct),
        source: String(r.source) as SleepSession['source'],
        stages: stages.map((seg) => ({
          stage: String(seg.stage) as SleepStage,
          startUtc: String(seg.start_utc),
          endUtc: String(seg.end_utc),
        })),
      };
    });
  }

  // ---- alarm events + event log ---------------------------------------------

  insertAlarmEvent(ev: Omit<AlarmEvent, 'id'>): AlarmEvent {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO alarm_events (id, user_id, policy_id, type, reason, ts_utc, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ev.userId,
        ev.policyId,
        ev.type,
        ev.reason ?? null,
        ev.tsUtc,
        ev.detail ? JSON.stringify(ev.detail) : null,
      );
    this.logEvent(`alarm.${ev.type}`, ev.userId, { ...ev.detail, reason: ev.reason });
    return { ...ev, id };
  }

  /** The most recent 'fired' alarm not yet dismissed (drives push escalation + bedside ring). */
  pendingAlarm(userId: string): AlarmEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT f.* FROM alarm_events f
         WHERE f.user_id = ? AND f.type = 'fired'
           AND NOT EXISTS (
             SELECT 1 FROM alarm_events d
             WHERE d.user_id = f.user_id AND d.policy_id = f.policy_id
               AND d.type IN ('dismissed','snoozed') AND d.ts_utc >= f.ts_utc
           )
         ORDER BY f.ts_utc DESC LIMIT 1`,
      )
      .get(userId) as Record<string, unknown> | undefined;
    return row ? mapAlarmEvent(row) : undefined;
  }

  listAlarmEvents(userId: string, limit = 100): AlarmEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM alarm_events WHERE user_id = ? ORDER BY ts_utc DESC LIMIT ?')
      .all(userId, limit) as Record<string, unknown>[];
    return rows.map(mapAlarmEvent);
  }

  logEvent(kind: string, userId?: string, payload?: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO event_log (id, user_id, kind, ts_utc, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(
        randomUUID(),
        userId ?? null,
        kind,
        new Date().toISOString(),
        payload ? JSON.stringify(payload) : null,
      );
  }

  // ---- push subscriptions ------------------------------------------------------

  savePushSubscription(userId: string, endpoint: string, keys: Record<string, string>): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET keys_json = excluded.keys_json`,
      )
      .run(randomUUID(), userId, endpoint, JSON.stringify(keys));
  }

  listPushSubscriptions(userId: string): { endpoint: string; keys: Record<string, string> }[] {
    const rows = this.db
      .prepare('SELECT endpoint, keys_json FROM push_subscriptions WHERE user_id = ?')
      .all(userId) as Record<string, unknown>[];
    return rows.map((r) => ({
      endpoint: String(r.endpoint),
      keys: JSON.parse(String(r.keys_json)) as Record<string, string>,
    }));
  }
}

function mapUser(r: Record<string, unknown>): User {
  return {
    id: String(r.id),
    email: String(r.email),
    tz: String(r.tz),
    lat: Number(r.lat),
    lng: Number(r.lng),
    calcMethod: Number(r.calc_method),
    madhab: Number(r.madhab) as 0 | 1,
  };
}

function mapPolicy(r: Record<string, unknown>): AlarmPolicy {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    prayer: String(r.prayer) as Prayer,
    enabled: Number(r.enabled) === 1,
    windowMinutes: Number(r.window_min),
    deadlineOffsetMinutes: Number(r.deadline_offset_min),
    preferredStages: JSON.parse(String(r.preferred_stages_json)) as SleepStage[],
    snoozeMinutes: Number(r.snooze_min),
    maxSnoozes: Number(r.max_snoozes),
  };
}

function mapAlarmEvent(r: Record<string, unknown>): AlarmEvent {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    policyId: String(r.policy_id),
    type: String(r.type) as AlarmEvent['type'],
    reason: (r.reason ?? undefined) as AlarmEvent['reason'],
    tsUtc: String(r.ts_utc),
    detail: r.detail_json ? (JSON.parse(String(r.detail_json)) as Record<string, unknown>) : undefined,
  };
}
