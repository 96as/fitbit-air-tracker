import { planAlarms, type PlannedAlarm } from '@fitbit-air-tracker/core';
import { useStore } from '../store';
import { alarmKit } from './alarmKit';
import { cancelAllChains, scheduleChain } from './notificationChain';
import { PRAYER_LABELS } from '../theme';

/**
 * Turn configured alarms + cached prayer times into device alarms:
 *   1. AlarmKit fixed alarm at every deadline for the next 7 days (rings until stopped)
 *   2. Backup notification chain after the NEXT deadline (if enabled)
 * Idempotent: cancels everything it scheduled before and re-arms from scratch.
 * Alarms the user already confirmed awake for (dismissed) are skipped.
 */
export async function replan(): Promise<PlannedAlarm[]> {
  const s = useStore.getState();
  const now = new Date();
  const planned = planAlarms({
    alarms: s.alarms,
    timings: s.timings,
    tz: s.settings.tz,
    now,
    daysAhead: 7,
  }).filter((p) => s.dismissed[p.alarmId] !== p.deadlineUtc);

  // Re-attach the backup chain to whatever is next after filtering.
  const next = planned[0];
  if (next && next.chainTimesUtc.length === 0) {
    const first = planAlarms({ alarms: s.alarms, timings: s.timings, tz: s.settings.tz, now: new Date(new Date(next.deadlineUtc).getTime() - 1), daysAhead: 0 })[0];
    if (first && first.alarmId === next.alarmId) next.chainTimesUtc = first.chainTimesUtc;
  }

  await alarmKit.stopAll();
  await cancelAllChains();

  const alarmKitIds: string[] = [];
  for (const p of planned) {
    const id = await alarmKit.scheduleAt(labelFor(p), new Date(p.deadlineUtc), snoozeFor(p.alarmId));
    if (id) alarmKitIds.push(id);
  }
  let notificationIds: string[] = [];
  if (next && s.settings.chainBackup && s.permissions.notifications === 'granted') {
    notificationIds = await scheduleChain(labelFor(next), next.chainTimesUtc);
  }

  s.setPlanned(planned, { alarmKitIds, notificationIds, scheduledAtUtc: now.toISOString() });
  s.logEvent('alarm.scheduled', {
    count: planned.length,
    alarmKit: alarmKitIds.length,
    chain: notificationIds.length,
    next: next?.deadlineUtc,
  });
  return planned;
}

export function labelFor(p: Pick<PlannedAlarm, 'kind' | 'label'>): string {
  return p.kind === 'prayer' ? (PRAYER_LABELS[p.label] ?? p.label) : p.label;
}

function snoozeFor(alarmId: string): number {
  return useStore.getState().alarms.find((a) => a.id === alarmId)?.snoozeMinutes ?? 5;
}

/** User confirmed awake for a planned alarm: never re-arm that deadline, cancel backups. */
export async function confirmAwake(p: Pick<PlannedAlarm, 'alarmId' | 'deadlineUtc'>): Promise<void> {
  const s = useStore.getState();
  s.markDismissed(p.alarmId, p.deadlineUtc);
  s.logEvent('alarm.dismissed', { alarmId: p.alarmId, deadlineUtc: p.deadlineUtc });
  await replan();
}
