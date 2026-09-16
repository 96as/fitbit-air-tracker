import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { refreshTimetable } from './prayerTimes';
import { replan } from './replan';

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
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundRefresh(): Promise<void> {
  try {
    const registered = await TaskManager.isTaskRegisteredAsync(REFRESH_TASK);
    if (!registered) await BackgroundTask.registerTaskAsync(REFRESH_TASK, { minimumInterval: 12 * 60 });
  } catch {
    /* background tasks unavailable (simulator / Expo Go) */
  }
}
