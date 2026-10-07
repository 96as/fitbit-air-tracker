import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { NightData } from '@fitbit-air-tracker/core';

/**
 * Per-night health data on the phone (the shared `NightData` contract), filled
 * by services/health.ts from Google Health or the mock. Raw data only — the
 * metrics engine computes scores from it. Same persist pattern as store.ts.
 */

export const MAX_NIGHTS = 60;

export type HealthSource = 'google' | 'mock';

/** dataType → error message (e.g. "403 PERMISSION_DENIED: …"). */
export type TypeErrors = Record<string, string>;

export interface HealthState {
  hydrated: boolean;
  /** Where the stored nights came from; a change of source clears them. */
  source?: HealthSource;
  /** dateLocal (night end, YYYY-MM-DD) → night. Capped at MAX_NIGHTS newest. */
  nights: Record<string, NightData>;
  /** dateLocal → per-type errors from the last fetch of that night (absent = all OK). */
  errors: Record<string, TypeErrors>;
  /** Last sync that stored data (ISO UTC). */
  lastSyncUtc?: string;
  /** Last sync attempt, successful or not — the 60 s floor is enforced on this. */
  lastAttemptUtc?: string;
  /** Whole-sync failure (e.g. not connected), if the last attempt failed. */
  lastError?: string;

  upsertNights(nights: NightData[], errors: Record<string, TypeErrors>, source: HealthSource, atUtc: string): void;
  markAttempt(atUtc: string, error?: string): void;
  reset(source?: HealthSource): void;
}

function capNewest<T>(rec: Record<string, T>, max: number): Record<string, T> {
  const keep = Object.keys(rec).sort().slice(-max);
  const out: Record<string, T> = {};
  for (const k of keep) out[k] = rec[k]!;
  return out;
}

export const useHealthStore = create<HealthState>()(
  persist(
    (set) => ({
      hydrated: false,
      source: undefined,
      nights: {},
      errors: {},
      lastSyncUtc: undefined,
      lastAttemptUtc: undefined,
      lastError: undefined,

      upsertNights: (nights, errors, source, atUtc) =>
        set((s) => {
          const merged = { ...s.nights };
          const mergedErrors = { ...s.errors };
          for (const n of nights) {
            merged[n.dateLocal] = n;
            if (errors[n.dateLocal] && Object.keys(errors[n.dateLocal]!).length > 0) mergedErrors[n.dateLocal] = errors[n.dateLocal]!;
            else delete mergedErrors[n.dateLocal];
          }
          const capped = capNewest(merged, MAX_NIGHTS);
          const cappedErrors: Record<string, TypeErrors> = {};
          for (const d of Object.keys(mergedErrors)) if (capped[d]) cappedErrors[d] = mergedErrors[d]!;
          return { nights: capped, errors: cappedErrors, source, lastSyncUtc: atUtc, lastError: undefined };
        }),
      markAttempt: (atUtc, error) => set({ lastAttemptUtc: atUtc, lastError: error }),
      reset: (source) => set({ nights: {}, errors: {}, source, lastSyncUtc: undefined }),
    }),
    {
      name: 'smartwake-health-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        source: s.source,
        nights: s.nights,
        errors: s.errors,
        lastSyncUtc: s.lastSyncUtc,
        lastAttemptUtc: s.lastAttemptUtc,
        lastError: s.lastError,
      }),
      onRehydrateStorage: () => () => {
        useHealthStore.setState({ hydrated: true });
      },
    },
  ),
);
