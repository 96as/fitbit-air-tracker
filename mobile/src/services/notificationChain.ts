import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Tier-3 backup: a chain of local notifications with sound after the deadline
 * (the user's "chain of alarms" idea). iOS plays each sound for up to 30 s with
 * vibration, so a 30 s cadence keeps the phone buzzing until the user opens
 * the app and confirms awake (which cancels the rest of the chain).
 */

export function configureNotificationHandling(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('alarm', {
      name: 'Prayer alarms',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'alarm.wav',
      vibrationPattern: [0, 500, 250, 500],
      bypassDnd: true,
    });
  }
}

export async function ensureNotificationPermission(): Promise<'granted' | 'denied'> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return 'granted';
  const asked = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false, allowCriticalAlerts: false },
  });
  return asked.granted ? 'granted' : 'denied';
}

export async function scheduleChain(label: string, timesUtc: string[]): Promise<string[]> {
  const ids: string[] = [];
  const now = Date.now();
  for (const [i, iso] of timesUtc.entries()) {
    const at = new Date(iso);
    if (at.getTime() <= now) continue;
    ids.push(
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `⏰ ${label}`,
          body: i === 0 ? 'Time to wake up — open the app to stop the alarm.' : `Still asleep? Wake up for ${label}.`,
          sound: 'alarm.wav',
          interruptionLevel: 'timeSensitive',
          data: { kind: 'chain', label, deadlineUtc: timesUtc[0] },
        },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: 'alarm' },
      }),
    );
  }
  return ids;
}

export async function cancelAllChains(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
  await Notifications.dismissAllNotificationsAsync().catch(() => undefined);
}
