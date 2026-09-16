import { useEffect } from 'react';
import { AppState } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { useStore } from '../src/store';
import { configureNotificationHandling, ensureNotificationPermission } from '../src/services/notificationChain';
import { refreshTimetable } from '../src/services/prayerTimes';
import { replan } from '../src/services/replan';
import { seedSleepHistory, syncGoogleHistory } from '../src/services/sleep';
import { isGoogleConnected } from '../src/services/googleAuth';
import { registerBackgroundRefresh } from '../src/services/background';
import { alarmKit } from '../src/services/alarmKit';
import { colors } from '../src/theme';

configureNotificationHandling();

/** Boot: hydrate store → permissions → prayer times → arm device alarms. */
async function bootstrap(): Promise<void> {
  const s = useStore.getState();
  if (s.sessions.length === 0) seedSleepHistory();
  s.setPermission('notifications', await ensureNotificationPermission());
  if (s.permissions.alarmKit === 'unknown') s.setPermission('alarmKit', await alarmKit.requestPermission());
  try {
    await refreshTimetable();
  } catch (err) {
    s.logEvent('timetable.failed', { error: String(err) });
  }
  await replan();
  await registerBackgroundRefresh();
  s.setGoogleConnected(await isGoogleConnected());
  await syncGoogleHistory().catch((err) => s.logEvent('google.sync-failed', { error: String(err) }));
}

export default function RootLayout() {
  const hydrated = useStore((s) => s.hydrated);
  const router = useRouter();

  useEffect(() => {
    if (!hydrated) return;
    void bootstrap();
    // Foreground: keep the timetable horizon full + re-arm (cheap, idempotent).
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshTimetable().then(() => replan()).catch(() => undefined);
        void syncGoogleHistory().catch(() => undefined);
      }
    });
    return () => sub.remove();
  }, [hydrated]);

  useEffect(() => {
    // Tapping a backup-chain notification opens Bedside so the in-app alarm
    // keeps ringing until the user explicitly confirms awake.
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as { kind?: string } | undefined;
      if (data?.kind === 'chain') router.push({ pathname: '/(tabs)/bedside', params: { ring: '1' } });
    });
    return () => sub.remove();
  }, [router]);

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
      </Stack>
    </>
  );
}
