import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { newId, type PlannedAlarm, type ProbeReport, type SleepSession, type TimingsByDate, type WakeAlarm } from '@fitbit-air-tracker/core';

/**
 * On-device state. Everything the server's tables held lives here as JSON
 * (settings, alarms, cached timetable, sleep sessions, append-only events)
 * — same shapes and vocabulary, so an AI agent or a later sync can consume it.
 */

export interface Settings {
  lat: number;
  lng: number;
  locationLabel: string;
  tz: string;
  calcMethod: number;
  madhab: 0 | 1;
  /** Also schedule the backup notification chain after each deadline. */
  chainBackup: boolean;
  /** Where sleep data comes from: the simulator or the real Fitbit Air via Google Health. */
  sleepSource: 'mock' | 'google';
  /** iOS OAuth client ID (not a secret). Prefilled from EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID. */
  googleIosClientId: string;
}

export interface AppEvent {
  id: string;
  kind: string;
  tsUtc: string;
  payload?: Record<string, unknown>;
}

export interface DeviceSchedule {
  alarmKitIds: string[];
  notificationIds: string[];
  scheduledAtUtc?: string;
}

export interface ActiveRing {
  alarmId: string;
  label: string;
  deadlineUtc: string;
  firedAtUtc: string;
  reason: string;
  snoozes: number;
}

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unavailable';

export interface AppState {
  hydrated: boolean;
  settings: Settings;
  alarms: WakeAlarm[];
  timings: TimingsByDate;
  hijriByDate: Record<string, string>;
  planned: PlannedAlarm[];
  device: DeviceSchedule;
  /** alarmId → deadlineUtc the user already confirmed awake for (don't re-arm). */
  dismissed: Record<string, string>;
  events: AppEvent[];
  sessions: SleepSession[];
  permissions: { alarmKit: PermissionState; notifications: PermissionState };
  activeRing?: ActiveRing;
  /** Mirror of "tokens exist in SecureStore" for the UI (tokens themselves never live here). */
  googleConnected: boolean;
  googleLastProbe?: ProbeReport;

  setSettings(patch: Partial<Settings>): void;
  upsertAlarm(alarm: WakeAlarm): void;
  removeAlarm(id: string): void;
  setTimings(dateLocal: string, times: Record<string, string>, hijri?: string): void;
  setPlanned(planned: PlannedAlarm[], device: DeviceSchedule): void;
  markDismissed(alarmId: string, deadlineUtc: string): void;
  logEvent(kind: string, payload?: Record<string, unknown>): void;
  setSessions(sessions: SleepSession[]): void;
  setPermission(key: keyof AppState['permissions'], value: PermissionState): void;
  setActiveRing(ring?: ActiveRing): void;
  setGoogleConnected(connected: boolean): void;
  setGoogleLastProbe(report?: ProbeReport): void;
}

const deviceTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

export const DEFAULT_SETTINGS: Settings = {
  lat: 21.4225,
  lng: 39.8262,
  locationLabel: 'Makkah (default — set yours in Settings)',
  tz: deviceTz,
  calcMethod: 4,
  madhab: 0,
  chainBackup: true,
  sleepSource: 'mock',
  googleIosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '',
};

export function defaultAlarms(): WakeAlarm[] {
  const base = {
    userId: 'me',
    preferredStages: ['light', 'awake'] as WakeAlarm['preferredStages'],
    snoozeMinutes: 5,
    maxSnoozes: 2,
  };
  return [
    { ...base, id: 'fajr', kind: 'prayer', prayer: 'fajr', enabled: true, windowMinutes: 45, deadlineOffsetMinutes: 20 },
    { ...base, id: 'qiyam', kind: 'prayer', prayer: 'qiyam', enabled: false, windowMinutes: 30, deadlineOffsetMinutes: 0 },
    { ...base, id: 'dhuhr', kind: 'prayer', prayer: 'dhuhr', enabled: false, windowMinutes: 0, deadlineOffsetMinutes: 0 },
    { ...base, id: 'asr', kind: 'prayer', prayer: 'asr', enabled: false, windowMinutes: 0, deadlineOffsetMinutes: 0 },
    { ...base, id: 'maghrib', kind: 'prayer', prayer: 'maghrib', enabled: false, windowMinutes: 0, deadlineOffsetMinutes: 0 },
    { ...base, id: 'isha', kind: 'prayer', prayer: 'isha', enabled: false, windowMinutes: 0, deadlineOffsetMinutes: 0 },
  ];
}

const MAX_EVENTS = 500;

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      hydrated: false,
      settings: DEFAULT_SETTINGS,
      alarms: defaultAlarms(),
      timings: {},
      hijriByDate: {},
      planned: [],
      device: { alarmKitIds: [], notificationIds: [] },
      dismissed: {},
      events: [],
      sessions: [],
      permissions: { alarmKit: 'unknown', notifications: 'unknown' },
      activeRing: undefined,
      googleConnected: false,
      googleLastProbe: undefined,

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      upsertAlarm: (alarm) =>
        set((s) => ({
          alarms: s.alarms.some((a) => a.id === alarm.id)
            ? s.alarms.map((a) => (a.id === alarm.id ? alarm : a))
            : [...s.alarms, alarm],
        })),
      removeAlarm: (id) => set((s) => ({ alarms: s.alarms.filter((a) => a.id !== id) })),
      setTimings: (dateLocal, times, hijri) =>
        set((s) => {
          // keep a rolling window: drop anything older than 2 days ago
          const cutoff = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
          const timings: TimingsByDate = {};
          const hijriByDate: Record<string, string> = {};
          for (const [d, t] of Object.entries({ ...s.timings, [dateLocal]: times })) {
            if (d >= cutoff) timings[d] = t;
          }
          for (const [d, h] of Object.entries({ ...s.hijriByDate, ...(hijri ? { [dateLocal]: hijri } : {}) })) {
            if (d >= cutoff) hijriByDate[d] = h;
          }
          return { timings, hijriByDate };
        }),
      setPlanned: (planned, device) => set({ planned, device }),
      markDismissed: (alarmId, deadlineUtc) =>
        set((s) => ({ dismissed: { ...s.dismissed, [alarmId]: deadlineUtc } })),
      logEvent: (kind, payload) =>
        set((s) => ({
          events: [{ id: newId(), kind, tsUtc: new Date().toISOString(), payload }, ...s.events].slice(0, MAX_EVENTS),
        })),
      setSessions: (sessions) => set({ sessions }),
      setPermission: (key, value) => set((s) => ({ permissions: { ...s.permissions, [key]: value } })),
      setActiveRing: (ring) => set({ activeRing: ring }),
      setGoogleConnected: (googleConnected) => set({ googleConnected }),
      setGoogleLastProbe: (googleLastProbe) => set({ googleLastProbe }),
    }),
    {
      name: 'smartwake-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        settings: s.settings,
        alarms: s.alarms,
        timings: s.timings,
        hijriByDate: s.hijriByDate,
        planned: s.planned,
        device: s.device,
        dismissed: s.dismissed,
        events: s.events,
        sessions: s.sessions,
        permissions: s.permissions,
        googleConnected: s.googleConnected,
        googleLastProbe: s.googleLastProbe,
      }),
      onRehydrateStorage: () => () => {
        useStore.setState({ hydrated: true });
      },
    },
  ),
);
