import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { refreshTimetable } from './prayerTimes';
import { replan } from './replan';
import { startHealthAutoSync, syncNights } from './health';

/**
 * Opportunistic daily refresh while the app is backgrounded (iOS decides
 * when; typically once or twice a day). Alarms are pre-armed a week ahead so
 * nothing breaks if iOS never runs this — it just keeps the horizon full.
 */
export const REFRESH_TASK = 'smartwake-refresh';

TaskManager.defineTask(REFRESH_TASK, async () => {
  try {
    await refreshTimetable();
    await replan();
    // Health sync is best-effort, after alarms are re-armed, capped at 20 s of the task's budget.
    await Promise.race([syncNights().catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))]);
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundRefresh(): Promise<void> {
  // Foreground health sync (now + on every app foreground); 60 s floor inside.
  startHealthAutoSync();
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(REFRESH_TASK);
    if (!registered) await BackgroundTask.registerTaskAsync(REFRESH_TASK, { minimumInterval: 12 * 60 });
  } catch {
    /* background tasks unavailable (simulator / Expo Go) */
  }
}
