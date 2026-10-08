import { useEffect, useRef, useState } from 'react';
import { api, fmtTime, type PlanEntry } from '../api';

/**
 * Bedside Mode — the network-independent alarm guarantee (tier 2).
 * Once armed: screen wake-lock, a local countdown to the hard deadline that
 * rings with no server involvement, plus polling so a server-side early fire
 * (light sleep detected) rings here too.
 */
export default function Bedside() {
  const [now, setNow] = useState(new Date());
  const [plan, setPlan] = useState<PlanEntry>();
  const [armed, setArmed] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [localDeadline, setLocalDeadline] = useState<Date>();
  const audioCtx = useRef<AudioContext>();
  const beeper = useRef<ReturnType<typeof setInterval>>();
  const wakeLock = useRef<WakeLockSentinel>();

  useEffect(() => {
    api.tonight().then((t) => {
      const next = t.plans[0];
      setPlan(next);
      if (next) setLocalDeadline(new Date(next.deadlineUtc));
    });
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clock);
  }, []);

  // Local deadline guarantee — rings even if the server/network is gone.
  useEffect(() => {
    if (armed && !ringing && localDeadline && now >= localDeadline) startRinging();
  }, [now, armed, ringing, localDeadline]);

  // Early fire: the server detected light sleep and fired inside the window.
  useEffect(() => {
    if (!armed || ringing) return;
    const poll = setInterval(async () => {
      try {
        const { pending } = await api.pendingAlarm();
        if (pending) startRinging();
      } catch {
        /* offline: local deadline still covers us */
      }
    }, 10_000);
    return () => clearInterval(poll);
  }, [armed, ringing]);

  function beep() {
    const ctx = audioCtx.current;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  }

  function startRinging() {
    setRinging(true);
    beep();
    beeper.current = setInterval(beep, 800);
    if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
  }

  function stopRinging() {
    setRinging(false);
    if (beeper.current) clearInterval(beeper.current);
  }

  async function arm() {
    // Must run in a user gesture: unlock audio + keep the screen on.
    audioCtx.current = audioCtx.current ?? new AudioContext();
    await audioCtx.current.resume();
    try {
      wakeLock.current = await navigator.wakeLock?.request('screen');
    } catch {
      /* wake lock unsupported — alarm still works */
    }
    setArmed(true);
  }

  function disarm() {
    stopRinging();
    setArmed(false);
    void wakeLock.current?.release();
  }

  async function dismiss() {
    stopRinging();
    try {
      await api.ack(false);
    } catch {
      /* offline ack is fine to lose */
    }
    setLocalDeadline(undefined); // done for tonight
  }

  async function snooze() {
    stopRinging();
    const mins = plan?.policy.snoozeMinutes ?? 5;
    setLocalDeadline(new Date(Date.now() + mins * 60_000));
    try {
      await api.ack(true);
    } catch {
      /* offline */
    }
  }

  return (
    <div className={`bedside ${ringing ? 'ringing' : ''}`}>
      <div className="clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      {plan ? (
        <div className="sub">
          <span style={{ textTransform: 'capitalize' }}>{plan.prayer}</span> at{' '}
          {fmtTime(plan.prayerTimeUtc)} · window opens {fmtTime(plan.windowStartUtc)} · latest wake{' '}
          {localDeadline ? fmtTime(localDeadline.toISOString()) : '—'}
        </div>
      ) : (
        <div className="sub">No alarm planned — enable one in Settings.</div>
      )}

      {ringing ? (
        <>
          <h1>Time to wake for prayer 🕌</h1>
          <div className="actions">
            <button onClick={dismiss}>I'm awake ✓</button>
            <button className="secondary" onClick={snooze}>
              Snooze {plan?.policy.snoozeMinutes ?? 5} min
            </button>
          </div>
        </>
      ) : armed ? (
        <>
          <p className="ok">Armed — keep this page open on your nightstand.</p>
          <div className="actions">
            <button className="secondary" onClick={disarm}>
              Disarm
            </button>
            <button
              className="secondary"
              onClick={() => api.fireTest().then(() => startRinging())}
            >
              Test alarm now
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="notice">
            Arming unlocks audio and keeps the screen awake, so the alarm rings even with no
            network.
          </p>
          <div className="actions">
            <button onClick={arm}>Arm bedside alarm</button>
          </div>
        </>
      )}
    </div>
  );
}
