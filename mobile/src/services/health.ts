import { useMemo } from 'react';
import { AppState } from 'react-native';
import {
  ALL_NIGHT_DATA_TYPES,
  GoogleHealthClient,
  TokenManager,
  fetchNightData,
  localDateString,
  mockNightData,
  wallTimeToUtc,
  type NightData,
} from '@fitbit-air-tracker/core';
import { useStore } from '../store';
import { useHealthStore, type HealthSource, type TypeErrors } from '../healthStore';
import { secureTokenStore } from './googleAuth';
import { usingRealData } from './sleep';

/**
 * Phone-side health sync: one `NightData` per night into healthStore.
 * - Source: Google Health (Fitbit Air) when connected, else the core mock.
 * - First run (or after a source change): backfill BACKFILL_NIGHTS nights;
 *   afterwards refresh the last 2 nights (daily summaries land late).
 * - Triggers: app start + every foreground (startHealthAutoSync) and the
 *   background refresh task. Never more often than once per 60 s.
 * No metrics here — the metrics engine reads the stored nights.
 */

export const MIN_SYNC_INTERVAL_MS = 60_000;
export const BACKFILL_NIGHTS = 30;
const REFRESH_NIGHTS = 2;

export interface SyncResult {
  status: 'synced' | 'skipped' | 'failed';
  source: HealthSource;
  /** Dates (YYYY-MM-DD) stored by this sync. */
  dates: string[];
  /** dateLocal → per-type errors. */
  errors: Record<string, TypeErrors>;
  reason?: string;
}

/** Window that holds the night ending on `dateLocal`: 18:00 the evening before → 14:00 (capped at now). */
export function nightWindow(dateLocal: string, tz: string, now: Date): { startUtc: Date; endUtc: Date } {
  const [y, m, d] = dateLocal.split('-').map(Number);
  const prev = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
  const startUtc = wallTimeToUtc(prev, '18:00', tz);
  const end = wallTimeToUtc(dateLocal, '14:00', tz);
  return { startUtc, endUtc: end > now ? now : end };
}

function recentDates(now: Date, tz: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(localDateString(new Date(now.getTime() - i * 86_400_000), tz));
  return [...new Set(out)];
}

function makeClient(clientId: string): GoogleHealthClient {
  const tokenManager = new TokenManager({ store: secureTokenStore, clientId: clientId.trim() });
  return new GoogleHealthClient({ getAccessToken: tokenManager.getAccessToken, onUnauthorized: () => tokenManager.forceRefresh() });
}

let inflight: Promise<SyncResult> | undefined;

/** Sync recent nights. `days` overrides the automatic 30-night backfill / 2-night refresh. */
export function syncNights(opts: { days?: number } = {}): Promise<SyncResult> {
  if (!inflight) {
    inflight = runSync(opts).finally(() => {
      inflight = undefined;
    });
  }
  return inflight;
}

async function runSync(opts: { days?: number }): Promise<SyncResult> {
  const now = new Date();
  const app = useStore.getState();
  const health = useHealthStore.getState();
  const source: HealthSource = usingRealData() ? 'google' : 'mock';

  // Platform rule: never poll Google faster than 60 s (applies to mock too, for parity).
  if (health.lastAttemptUtc && now.getTime() - Date.parse(health.lastAttemptUtc) < MIN_SYNC_INTERVAL_MS) {
    return { status: 'skipped', source, dates: [], errors: {}, reason: 'rate-limit-60s' };
  }
  health.markAttempt(now.toISOString());

  const sourceChanged = health.source !== undefined && health.source !== source;
  if (sourceChanged) health.reset(source);
  const firstRun = sourceChanged || Object.keys(useHealthStore.getState().nights).length === 0;
  const days = Math.max(1, Math.min(opts.days ?? (firstRun ? BACKFILL_NIGHTS : REFRESH_NIGHTS), BACKFILL_NIGHTS));
  const tz = app.settings.tz;
  const dates = recentDates(now, tz, days);

  const nights: NightData[] = [];
  const errors: Record<string, TypeErrors> = {};
  try {
    if (source === 'mock') {
      for (const dateLocal of dates) nights.push(mockNightData({ dateLocal, tz }));
    } else {
      const client = makeClient(app.settings.googleIosClientId);
      // Newest first, sequentially — gentle on quota; stop if every type fails (auth/network down).
      for (const dateLocal of [...dates].reverse()) {
        const { startUtc, endUtc } = nightWindow(dateLocal, tz, now);
        if (!(endUtc > startUtc)) continue;
        const res = await fetchNightData(client, { dateLocal, tz, startUtc, endUtc, userId: 'me' });
        if (Object.keys(res.errors).length === ALL_NIGHT_DATA_TYPES.length) {
          throw new Error(`Google Health unavailable: ${res.errors.sleep ?? Object.values(res.errors)[0]}`);
        }
        nights.push(res.night);
        if (Object.keys(res.errors).length > 0) errors[dateLocal] = res.errors;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Keep whatever nights did arrive before the failure.
    if (nights.length > 0) useHealthStore.getState().upsertNights(nights, errors, source, new Date().toISOString());
    useHealthStore.getState().markAttempt(now.toISOString(), msg);
    app.logEvent('health.sync-failed', { source, error: msg, stored: nights.length });
    return { status: 'failed', source, dates: nights.map((n) => n.dateLocal), errors, reason: msg };
  }

  useHealthStore.getState().upsertNights(nights, errors, source, new Date().toISOString());
  app.logEvent('health.synced', {
    source,
    nights: nights.length,
    ...(Object.keys(errors).length > 0 ? { errorTypes: [...new Set(Object.values(errors).flatMap((e) => Object.keys(e)))] } : {}),
  });
  return { status: 'synced', source, dates: nights.map((n) => n.dateLocal), errors };
}

let autoSyncStarted = false;

/**
 * Sync now (once the health store has hydrated) and on every return to the
 * foreground. Idempotent — safe to call more than once.
 */
export function startHealthAutoSync(): void {
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  const kick = () => void syncNights().catch(() => undefined);
  if (useHealthStore.persist.hasHydrated()) kick();
  else useHealthStore.persist.onFinishHydration(kick);
  AppState.addEventListener('change', (state) => {
    if (state === 'active') kick();
  });
}

/** Stored nights, oldest → newest. */
export function useNights(): NightData[] {
  const nights = useHealthStore((s) => s.nights);
  return useMemo(() => Object.keys(nights).sort().map((d) => nights[d]!), [nights]);
}
