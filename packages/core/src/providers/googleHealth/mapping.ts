import type { SleepSample, SleepSession, SleepStage, SleepStageSegment } from '../../types.js';
import type { GhDataPoint, GhSleep, GhSleepStageType } from './types.js';

/** Pure mapping from Google Health API v4 shapes to our normalized model. */

const MINUTE_MS = 60_000;

export const STAGE_MAP: Record<GhSleepStageType, SleepStage> = {
  AWAKE: 'awake',
  LIGHT: 'light',
  DEEP: 'deep',
  REM: 'rem',
  ASLEEP: 'light', // classic (non-staged) sleep: treat "asleep" as light — the wakeable state
  RESTLESS: 'awake',
  SLEEP_STAGE_TYPE_UNSPECIFIED: 'light',
};

/** "10800s" (protobuf Duration) or "+03:00"/"-05:30" → minutes east of UTC. */
export function parseUtcOffsetMinutes(offset?: string): number {
  if (!offset) return 0;
  const dur = /^(-?\d+(?:\.\d+)?)s$/.exec(offset);
  if (dur) return Math.round(Number(dur[1]) / 60);
  const hm = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (hm) return (hm[1] === '-' ? -1 : 1) * (Number(hm[2]) * 60 + Number(hm[3]));
  const n = Number(offset);
  return Number.isFinite(n) ? Math.round(n / 60) : 0;
}

export interface GoogleSleepMeta {
  processed?: boolean;
  mainSleep?: boolean;
  stagesStatus?: string;
  sleepType?: GhSleep['type'];
}

export type GoogleSleepSession = SleepSession & { meta: GoogleSleepMeta };

export function mapSleep(dp: GhDataPoint, userId: string): GoogleSleepSession | undefined {
  const s = dp.sleep;
  if (!s?.interval?.startTime || !s.interval.endTime) return undefined;
  const stages: SleepStageSegment[] = (s.stages ?? [])
    .filter((st) => st.startTime && st.endTime)
    .map((st) => ({
      stage: STAGE_MAP[st.type] ?? 'light',
      startUtc: new Date(st.startTime).toISOString(),
      endUtc: new Date(st.endTime).toISOString(),
    }))
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  // A CLASSIC session without stages still covers its interval as "asleep".
  if (stages.length === 0) {
    stages.push({
      stage: 'light',
      startUtc: new Date(s.interval.startTime).toISOString(),
      endUtc: new Date(s.interval.endTime).toISOString(),
    });
  }
  const asleep = num(s.summary?.minutesAsleep);
  const inPeriod = num(s.summary?.minutesInSleepPeriod);
  return {
    id: dp.name ?? `google:${s.interval.startTime}`,
    userId,
    startUtc: new Date(s.interval.startTime).toISOString(),
    endUtc: new Date(s.interval.endTime).toISOString(),
    tzOffsetMin: parseUtcOffsetMinutes(s.interval.startUtcOffset),
    isNap: Boolean(s.metadata?.nap),
    efficiencyPct: asleep != null && inPeriod ? Math.round((asleep / inPeriod) * 1000) / 10 : undefined,
    source: 'google_health',
    stages,
    meta: {
      processed: s.metadata?.processed,
      mainSleep: s.metadata?.mainSleep,
      stagesStatus: s.metadata?.stagesStatus,
      sleepType: s.type,
    },
  };
}

export interface HeartRateSample {
  tsUtc: string;
  bpm: number;
}

export function mapHeartRate(dp: GhDataPoint): HeartRateSample | undefined {
  const hr = dp.heartRate;
  if (!hr?.sampleTime?.physicalTime) return undefined;
  const bpm = Number(hr.beatsPerMinute);
  if (!Number.isFinite(bpm)) return undefined;
  return { tsUtc: new Date(hr.sampleTime.physicalTime).toISOString(), bpm };
}

/**
 * Per-minute samples from stage segments + heart-rate readings, for the wake
 * engine. Each minute inside a session gets its stage; the nearest HR reading
 * within `hrToleranceMin` is attached. Minutes with HR but no session are
 * emitted as 'awake' only if `includeHrOnly` (default false).
 */
export function toSamples(
  sessions: SleepSession[],
  heartRate: HeartRateSample[],
  fromUtc: Date,
  toUtc?: Date,
  hrToleranceMin = 5,
): SleepSample[] {
  const hr = [...heartRate].sort((a, b) => a.tsUtc.localeCompare(b.tsUtc));
  const hrTimes = hr.map((h) => new Date(h.tsUtc).getTime());
  const nearestHr = (t: number): number | undefined => {
    if (hrTimes.length === 0) return undefined;
    // binary search for insertion point
    let lo = 0;
    let hi = hrTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hrTimes[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    const candidates = [lo - 1, lo].filter((i) => i >= 0 && i < hrTimes.length);
    let best: number | undefined;
    let bestDist = Infinity;
    for (const i of candidates) {
      const d = Math.abs(hrTimes[i]! - t);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best != null && bestDist <= hrToleranceMin * MINUTE_MS ? hr[best]!.bpm : undefined;
  };

  const out: SleepSample[] = [];
  const from = fromUtc.getTime();
  const to = toUtc?.getTime() ?? Infinity;
  for (const session of sessions) {
    for (const seg of session.stages) {
      const start = Math.max(new Date(seg.startUtc).getTime(), from);
      const end = Math.min(new Date(seg.endUtc).getTime(), to);
      for (let t = Math.ceil(start / MINUTE_MS) * MINUTE_MS; t < end; t += MINUTE_MS) {
        const bpm = nearestHr(t);
        out.push({ tsUtc: new Date(t).toISOString(), stage: seg.stage, ...(bpm != null ? { heartRateBpm: bpm } : {}) });
      }
    }
  }
  out.sort((a, b) => a.tsUtc.localeCompare(b.tsUtc));
  return out;
}

function num(v?: string | number): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
