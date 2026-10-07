import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { localDateString, type MoodEntry } from '@fitbit-air-tracker/core';

/**
 * Mood check-ins, persisted on the phone like `store.ts` (JSON in AsyncStorage).
 * Entries use the shared `MoodEntry` contract so the metric engine
 * (`NightData.mood`, the `moodLink` metric) and a future AI agent read them as-is.
 */

/** Quick tags offered on the check-in screen (stable strings — metrics may key on them). */
export const MOOD_TAGS = [
  'Prayed Fajr on time',
  'Gym',
  'Late caffeine',
  'Late meal',
  'Stressed',
  'Sick',
  'Travel',
] as const;

export const MOOD_LABELS: Record<MoodEntry['score'], string> = {
  1: 'Awful',
  2: 'Low',
  3: 'Okay',
  4: 'Good',
  5: 'Great',
};

export const MOOD_FACES: Record<MoodEntry['score'], string> = {
  1: '😣',
  2: '🙁',
  3: '😐',
  4: '🙂',
  5: '😄',
};

export const ENERGY_LABELS: Record<NonNullable<MoodEntry['energy']>, string> = {
  1: 'Drained',
  2: 'Tired',
  3: 'Steady',
  4: 'Lively',
  5: 'Energized',
};

const MAX_ENTRIES = 1000;

export interface MoodState {
  hydrated: boolean;
  /** Newest first. */
  entries: MoodEntry[];
  addMood(entry: MoodEntry): void;
  removeMood(tsUtc: string): void;
}

export const useMoodStore = create<MoodState>()(
  persist(
    (set) => ({
      hydrated: false,
      entries: [],
      addMood: (entry) =>
        set((s) => ({
          entries: [entry, ...s.entries.filter((e) => e.tsUtc !== entry.tsUtc)]
            .sort((a, b) => b.tsUtc.localeCompare(a.tsUtc))
            .slice(0, MAX_ENTRIES),
        })),
      removeMood: (tsUtc) => set((s) => ({ entries: s.entries.filter((e) => e.tsUtc !== tsUtc) })),
    }),
    {
      name: 'smartwake-mood-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ entries: s.entries }),
      onRehydrateStorage: () => () => {
        useMoodStore.setState({ hydrated: true });
      },
    },
  ),
);

/** Check-ins whose timestamp falls on `dateLocal` in `tz`, newest first. */
export function moodsOnDate(entries: MoodEntry[], dateLocal: string, tz: string): MoodEntry[] {
  return entries.filter((e) => localDateString(new Date(e.tsUtc), tz) === dateLocal);
}
