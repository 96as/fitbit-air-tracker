import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { WakeScheduler, type Clock, type FireDecision, type ScheduledAlarm } from '@fitbit-air-tracker/core';
import { useStore } from '../../src/store';
import { Button, Card, Muted, Screen } from '../../src/components/ui';
import { colors, fmtTime } from '../../src/theme';
import { keepScreenAwake, prepareAudioSession, startRinging, stopRinging } from '../../src/services/inAppAlarm';
import { makeSleepProvider, usingRealData } from '../../src/services/sleep';
import { confirmAwake, labelFor } from '../../src/services/replan';
import { alarmKit } from '../../src/services/alarmKit';

/** Real-time clock, or an accelerated one for the demo. */
class BedsideClock implements Clock {
  private readonly startedReal = Date.now();
  private readonly startedSim = Date.now();
  constructor(private readonly accel: number) {}
  now(): Date {
    return new Date(this.startedSim + (Date.now() - this.startedReal) * this.accel);
  }
}

const REAL_TICK_MS = 30_000;
const DEMO_TICK_MS = 1_000;
const DEMO_ACCEL = 60; // 1 real second = 1 simulated minute

/**
 * Bedside mode = the smart part. Keep the phone on the nightstand with this
 * open: every 30 s it reads the freshest (mock, for now) sleep data and runs
 * the shared decide() rule; light sleep inside the window → ring now.
 * The AlarmKit system alarm at the deadline stays armed as the guarantee.
 */
export default function BedsideScreen() {
  const params = useLocalSearchParams<{ ring?: string }>();
  const { planned, settings, activeRing, setActiveRing, logEvent, alarms } = useStore();
  const [armed, setArmed] = useState(false);
  const [demo, setDemo] = useState(false);
  const [now, setNow] = useState(new Date());
  const [status, setStatus] = useState('');
  const scheduler = useRef<WakeScheduler | undefined>(undefined);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const snoozeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snoozeBackupId = useRef<string | undefined>(undefined);
  const next = planned[0];

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Opened from a backup notification: ring until the user confirms awake.
  useEffect(() => {
    if (params.ring === '1' && !activeRing && next) {
      void prepareAudioSession().then(() => fire({ alarmId: next.alarmId, label: labelFor(next), deadlineUtc: next.deadlineUtc }, 'chain'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.ring]);

  useEffect(() => () => disarm(), []); // cleanup on unmount

  function fire(target: { alarmId: string; label: string; deadlineUtc: string }, reason: string) {
    startRinging();
    setActiveRing({ ...target, firedAtUtc: new Date().toISOString(), reason, snoozes: activeRing?.snoozes ?? 0 });
    logEvent('alarm.fired', { alarmId: target.alarmId, reason, deadlineUtc: target.deadlineUtc });
  }

  async function arm(isDemo: boolean) {
    if (!next && !isDemo) return;
    await prepareAudioSession();
    await keepScreenAwake(true);
    const clock = new BedsideClock(isDemo ? DEMO_ACCEL : 1);
    const provider = makeSleepProvider(clock, clock.now(), isDemo ? 7 : undefined, isDemo);
    const s = new WakeScheduler({
      clock,
      provider,
      onFire: (alarm: ScheduledAlarm, decision: FireDecision) => {
        setStatus(`Fired: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ''}`);
        fire(
          {
            alarmId: alarm.policy.id,
            label: isDemo ? 'Demo alarm' : labelFor(next!),
            deadlineUtc: alarm.deadlineUtc.toISOString(),
          },
          decision.reason,
        );
      },
    });
    if (isDemo) {
      // Simulated night: deadline 90 sim-minutes away, 45-minute window → fires
      // on the first light-sleep sample after ~45 real seconds.
      const policy = { ...alarms[0]!, id: 'demo', windowMinutes: 45, deadlineOffsetMinutes: 0 };
      s.scheduleDeadline(policy, new Date(clock.now().getTime() + 90 * 60_000));
    } else {
      const policy = alarms.find((a) => a.id === next!.alarmId)!;
      s.scheduleDeadline(policy, new Date(next!.deadlineUtc), next!.prayerTimeUtc ? new Date(next!.prayerTimeUtc) : undefined);
    }
    scheduler.current = s;
    tick.current = setInterval(() => {
      void s.tick().then(async () => {
        const a = s.scheduled[0];
        if (a && !a.fired) {
          const simNow = clock.now();
          let freshness = '';
          try {
            // Cached by the provider (≤ 1 API call/min) — shows the real sync lag.
            const samples = await provider.getLatestSamples('me', new Date(simNow.getTime() - 3 * 60 * 60_000));
            const newest = samples.at(-1);
            freshness = newest
              ? ` · data ${Math.max(0, Math.round((simNow.getTime() - new Date(newest.tsUtc).getTime()) / 60_000))} min old (${newest.stage})`
              : ' · no sleep data yet';
          } catch (err) {
            freshness = ` · data error: ${String(err).slice(0, 60)}`;
          }
          setStatus(
            (simNow < a.windowStartUtc
              ? `Window opens ${fmtTime(a.windowStartUtc, settings.tz)}${isDemo ? ` (sim clock ${fmtTime(simNow, settings.tz)})` : ''}`
              : `In window — watching sleep stages${isDemo ? ` (sim clock ${fmtTime(simNow, settings.tz)})` : ''}`) + freshness,
          );
        }
      });
    }, isDemo ? DEMO_TICK_MS : REAL_TICK_MS);
    setDemo(isDemo);
    setArmed(true);
    setStatus(isDemo ? 'Demo night started (60× speed)' : usingRealData() ? 'Armed — reading your Fitbit Air via Google Health' : 'Armed — simulated sleep data');
  }

  function disarm() {
    if (tick.current) clearInterval(tick.current);
    if (snoozeTimer.current) clearTimeout(snoozeTimer.current);
    scheduler.current?.clear();
    stopRinging();
    void keepScreenAwake(false);
    setArmed(false);
    setDemo(false);
    setStatus('');
  }

  async function awake() {
    const ring = activeRing;
    stopRinging();
    if (snoozeTimer.current) clearTimeout(snoozeTimer.current);
    if (snoozeBackupId.current) await alarmKit.stop(snoozeBackupId.current);
    setActiveRing(undefined);
    if (ring && !demo && ring.alarmId !== 'demo') await confirmAwake(ring);
    else logEvent('alarm.dismissed', { alarmId: ring?.alarmId ?? 'demo', demo: true });
    disarm();
  }

  async function snooze() {
    const ring = activeRing;
    if (!ring) return;
    const mins = alarms.find((a) => a.id === ring.alarmId)?.snoozeMinutes ?? 5;
    stopRinging();
    logEvent('alarm.snoozed', { alarmId: ring.alarmId, minutes: mins });
    setActiveRing(undefined);
    const again = { ...ring, snoozes: ring.snoozes + 1 };
    snoozeTimer.current = setTimeout(() => fire(again, 'snooze'), (demo ? 5 : mins * 60) * 1000);
    if (!demo) snoozeBackupId.current = await alarmKit.scheduleTimer(ring.label, mins * 60); // rings even if the app is closed
  }

  return (
    <Screen title="Bedside">
      <View style={{ alignItems: 'center', paddingVertical: 16 }}>
        <Text style={{ color: colors.text, fontSize: 64, fontWeight: '200', fontVariant: ['tabular-nums'] }}>
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
        {next ? (
          <Muted>
            {labelFor(next)} · window {fmtTime(next.windowStartUtc, settings.tz)} · latest wake {fmtTime(next.deadlineUtc, settings.tz)}
          </Muted>
        ) : (
          <Muted>No alarm planned — enable one in Alarms.</Muted>
        )}
      </View>

      {activeRing ? (
        <Card style={{ borderColor: colors.danger, borderWidth: 2 }}>
          <Text style={{ color: colors.text, fontSize: 24, fontWeight: '700', textAlign: 'center' }}>Time to wake up 🕌</Text>
          <Text style={{ color: colors.muted, textAlign: 'center', marginTop: 4 }}>
            {activeRing.label} · {activeRing.reason === 'light-sleep' ? 'light sleep detected' : activeRing.reason}
          </Text>
          <Button title="I'm awake ✓" onPress={() => void awake()} />
          <Button title="Snooze" kind="secondary" onPress={() => void snooze()} />
        </Card>
      ) : armed ? (
        <Card>
          <Text style={{ color: colors.ok, fontWeight: '600' }}>{demo ? 'Demo running' : 'Armed — keep this screen open on your nightstand.'}</Text>
          <Muted>{status}</Muted>
          <Muted>
            {demo
              ? 'A simulated night plays at 60× speed; the alarm fires when the sleeper enters light sleep inside the window.'
              : 'Sleep data is read every 30 s. Light sleep inside the window → alarm. Otherwise the system alarm rings at the latest-wake time, even if this app is closed.'}
          </Muted>
          <Button title="Disarm" kind="secondary" onPress={disarm} />
        </Card>
      ) : (
        <Card>
          <Muted>
            Arming unlocks audio (plays even on silent), keeps the screen awake and starts watching your sleep so you can be woken
            during light sleep — before the latest-wake alarm.
          </Muted>
          <Button title="Arm bedside mode" onPress={() => void arm(false)} disabled={!next} />
          <Button title="Demo night (60× speed)" kind="secondary" onPress={() => void arm(true)} />
        </Card>
      )}
    </Screen>
  );
}
