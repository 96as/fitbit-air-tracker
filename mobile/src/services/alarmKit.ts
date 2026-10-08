import { Platform } from 'react-native';
import * as AlarmKit from 'react-native-nitro-ios-alarm-kit';
import { colors } from '../theme';

/**
 * Tier-1 alarm delivery on iOS 26+: a real system alarm (AlarmKit) that rings
 * and vibrates until the user stops it — even if the app is closed, even in
 * silent mode. Everything here degrades to a no-op elsewhere (Android,
 * iOS < 26) so the notification chain + Bedside mode still cover the user.
 *
 * Note: the module is a Nitro native module — it needs a dev build
 * (`npx expo run:ios --device`), it does not work in Expo Go.
 */

function available(): boolean {
  if (Platform.OS !== 'ios') return false;
  try {
    return AlarmKit.isAvailable();
  } catch {
    return false;
  }
}

export const alarmKit = {
  isAvailable: available,

  async requestPermission(): Promise<'granted' | 'denied' | 'unavailable'> {
    if (!available()) return 'unavailable';
    try {
      return (await AlarmKit.requestAlarmPermission()) ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  },

  /** Schedule a fixed alarm; resolves to the AlarmKit id, or undefined if unavailable. */
  async scheduleAt(title: string, at: Date, snoozeMinutes: number): Promise<string | undefined> {
    if (!available()) return undefined;
    try {
      return await AlarmKit.scheduleFixedAlarm(
        title.slice(0, 15), // keep short for Dynamic Island
        { text: 'Stop', textColor: '#0f172a', icon: 'stop.fill' },
        colors.accent,
        { text: 'Snooze', textColor: '#ffffff', icon: 'zzz' },
        Math.floor(at.getTime() / 1000),
        { postAlert: Math.max(60, snoozeMinutes * 60) },
        'alarm',
      );
    } catch (err) {
      console.warn('AlarmKit scheduleFixedAlarm failed', err);
      return undefined;
    }
  },

  /** Countdown alarm (used as the backup for an in-app snooze). */
  async scheduleTimer(title: string, seconds: number): Promise<string | undefined> {
    if (!available()) return undefined;
    try {
      return await AlarmKit.scheduleTimer(
        title.slice(0, 15),
        { text: 'Stop', textColor: '#0f172a', icon: 'stop.fill' },
        colors.accent,
        Math.max(60, Math.round(seconds)),
        undefined,
        'alarm',
      );
    } catch (err) {
      console.warn('AlarmKit scheduleTimer failed', err);
      return undefined;
    }
  },

  async stop(id: string): Promise<void> {
    if (!available()) return;
    try {
      await AlarmKit.stopAlarm(id);
    } catch {
      /* already gone */
    }
  },

  async stopAll(): Promise<void> {
    if (!available()) return;
    try {
      await AlarmKit.stopAllAlarms();
    } catch {
      /* nothing scheduled */
    }
  },
};
