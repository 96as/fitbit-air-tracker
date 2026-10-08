import { useEffect, useState } from 'react';
import {
  api,
  fmtDate,
  fmtTime,
  type SleepSession,
  type StageSegment,
  type TonightPlan,
} from '../api';

const STAGE_LABELS: Record<string, string> = {
  awake: 'Awake',
  light: 'Light',
  deep: 'Deep',
  rem: 'REM',
};

function minutes(seg: StageSegment): number {
  return (new Date(seg.endUtc).getTime() - new Date(seg.startUtc).getTime()) / 60_000;
}

function Hypnogram({ session }: { session: SleepSession }) {
  const total = session.stages.reduce((s, seg) => s + minutes(seg), 0);
  return (
    <div className="hypnogram" title="Sleep stages through the night">
      {session.stages.map((seg, i) => (
        <div
          key={i}
          className={`seg-${seg.stage}`}
          style={{ width: `${(minutes(seg) / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [plan, setPlan] = useState<TonightPlan>();
  const [timetable, setTimetable] = useState<Record<string, string>>();
  const [sessions, setSessions] = useState<SleepSession[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.tonight().then(setPlan).catch((e) => setError(String(e)));
    api.timetable().then((t) => setTimetable(t.timesUtc)).catch(() => undefined);
    api.sessions().then((s) => setSessions(s.sessions)).catch(() => undefined);
  }, []);

  const lastNight = sessions.find((s) => !s.isNap) ?? sessions[0];
  const stageTotals =
    lastNight &&
    lastNight.stages.reduce<Record<string, number>>((acc, seg) => {
      acc[seg.stage] = (acc[seg.stage] ?? 0) + minutes(seg);
      return acc;
    }, {});

  return (
    <div>
      <h1>Tonight's plan</h1>
      {error && <p className="warn">Server unreachable — is `npm run dev` running? ({error})</p>}
      {plan && plan.plans.length === 0 && (
        <p className="notice">No enabled alarms. Enable a prayer alarm in Settings.</p>
      )}
      {plan?.plans.map((p) => (
        <div className="card" key={p.prayer}>
          <strong style={{ textTransform: 'capitalize' }}>{p.prayer}</strong>
          <div className="grid" style={{ marginTop: '0.5rem' }}>
            <div className="stat">
              <div className="label">Wake window opens</div>
              <div className="value">{fmtTime(p.windowStartUtc)}</div>
            </div>
            <div className="stat">
              <div className="label">Latest wake (deadline)</div>
              <div className="value">{fmtTime(p.deadlineUtc)}</div>
            </div>
            <div className="stat">
              <div className="label">Prayer time</div>
              <div className="value">{fmtTime(p.prayerTimeUtc)}</div>
            </div>
          </div>
          <p className="notice">
            The alarm fires as soon as light sleep is detected inside the window — and always by
            the deadline.
          </p>
        </div>
      ))}

      <h2>Last night</h2>
      {lastNight ? (
        <div className="card">
          <div className="notice">
            {fmtDate(lastNight.startUtc)} · {fmtTime(lastNight.startUtc)} –{' '}
            {fmtTime(lastNight.endUtc)}
            {lastNight.efficiencyPct != null && <> · efficiency {lastNight.efficiencyPct}%</>}
            {lastNight.source === 'mock' && <> · simulated data</>}
          </div>
          <Hypnogram session={lastNight} />
          <div className="legend">
            {Object.entries(stageTotals ?? {}).map(([stage, mins]) => (
              <span key={stage}>
                <span className="dot" style={{ background: `var(--stage-${stage})` }} />
                {STAGE_LABELS[stage] ?? stage}: {Math.round(mins)} min
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="notice">No sleep sessions yet.</p>
      )}

      <h2>Prayer times today</h2>
      {timetable && (
        <div className="card">
          <table>
            <tbody>
              {['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha', 'lastthird'].map(
                (key) =>
                  timetable[key] && (
                    <tr key={key}>
                      <th style={{ textTransform: 'capitalize' }}>
                        {key === 'lastthird' ? 'Last third of night' : key}
                      </th>
                      <td>{fmtTime(timetable[key])}</td>
                    </tr>
                  ),
              )}
            </tbody>
          </table>
        </div>
      )}

      <h2>Recent nights</h2>
      {sessions.slice(0, 7).map((s) => (
        <div className="card" key={s.id}>
          <div className="notice">
            {fmtDate(s.startUtc)} · {fmtTime(s.startUtc)}–{fmtTime(s.endUtc)}
            {s.isNap ? ' · nap' : ''}
          </div>
          <Hypnogram session={s} />
        </div>
      ))}
    </div>
  );
}
