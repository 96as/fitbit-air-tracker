import { useMemo } from 'react';
import {
  computeNightMetrics,
  localDateString,
  type MetricsReport,
  type MoodEntry,
  type NightData,
} from '@fitbit-air-tracker/core';
import { useStore } from '../store';
import { moodsOnDate, useMoodStore } from '../moodStore';
import { useHealthStore } from '../healthStore';
import { useNights } from './health';

/**
 * The ONE seam between the dashboards (Today / Trends / Mood) and the data.
 *
 * Screens only ever call `useDashboardData()`. Nights come from the health
 * sync (`useNights()` — Google Health when connected, else the core mock),
 * mood check-ins are attached, and every night goes through the real metric
 * engine (`computeNightMetrics`). `source` is 'fixture' while the nights are
 * mock data, so the UI keeps its "sample data" banner until Google is connected.
 *
 * Value conventions the UI assumes (keep the metric engine aligned):
 *   sleepDuration, sleepDebt ............ minutes
 *   sleepScore, recovery, consistency,
 *   fajrWakeEase ........................ 0–100 (higher = better)
 *   breathing ........................... respiratory-v1: breaths/min (components.baselineBrpm);
 *                                         spo2-v1: SpO2 % (components.avgPct, baselinePct)
 *   skinTemp ............................ °C deviation from your baseline
 *   moodLink ............................ Pearson r (−1…1) between mood and the
 *                                         strongest sleep factor; text in `explanation`
 *   sleepDebt.components.needMin ........ personal sleep need (minutes), optional
 */

export type DashboardSource = 'fixture' | 'live';

export interface DashboardData {
  /** Oldest → newest. `mood` is filled from the mood store. */
  nights: NightData[];
  /** Same order/length as `nights` (one report per night). */
  reports: MetricsReport[];
  /** Report for the night that ended today (local), if we have it yet. */
  today?: MetricsReport;
  /** All mood check-ins, newest first. */
  moods: MoodEntry[];
  loading: boolean;
  source: DashboardSource;
}

/** Default sleep need when the engine doesn't provide `sleepDebt.components.needMin`. */
export const DEFAULT_SLEEP_NEED_MIN = 450; // 7 h 30 m; also passed to the metric engine

export function useDashboardData(): DashboardData {
  const tz = useStore((s) => s.settings.tz);
  const moodHydrated = useMoodStore((s) => s.hydrated);
  const realMoods = useMoodStore((s) => s.entries);
  const healthHydrated = useHealthStore((s) => s.hydrated);
  const healthSource = useHealthStore((s) => s.source);
  const lastSyncUtc = useHealthStore((s) => s.lastSyncUtc);
  // Prayer timings by local date (kept ~2 days back) → that morning's Fajr for fajrWakeEase.
  const timings = useStore((s) => s.timings);
  const storedNights = useNights();
  const todayLocal = localDateString(new Date(), tz);

  return useMemo(() => {
    const moods = [...realMoods].sort((a, b) => b.tsUtc.localeCompare(a.tsUtc));
    // Moods go into the nights BEFORE metrics so `moodLink` can use them.
    const nights = attachMoods(storedNights, moods, tz);
    const reports = nights.map((n, i) =>
      computeNightMetrics(n, nights.slice(0, i), {
        sleepNeedMin: DEFAULT_SLEEP_NEED_MIN,
        fajrUtc: timings[n.dateLocal]?.fajr,
      }),
    );
    const today = reports.find((r) => r.dateLocal === todayLocal);
    const loading = !moodHydrated || !healthHydrated || (nights.length === 0 && !lastSyncUtc);
    return { nights, reports, today, moods, loading, source: healthSource === 'google' ? 'live' : 'fixture' };
  }, [storedNights, realMoods, moodHydrated, healthHydrated, healthSource, lastSyncUtc, timings, tz, todayLocal]);
}

/** Fill `NightData.mood` with the check-ins logged on that night's (morning) date. */
export function attachMoods(nights: NightData[], moods: MoodEntry[], tz: string): NightData[] {
  return nights.map((n) => {
    const m = moodsOnDate(moods, n.dateLocal, tz);
    return m.length ? { ...n, mood: m } : n;
  });
}
