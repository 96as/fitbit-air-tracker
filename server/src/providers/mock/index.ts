import { randomUUID } from 'node:crypto';
import type { Clock, SleepSample, SleepSession, SleepStage, SleepStageSegment } from '../../types.js';
import type { DateRange, SleepDataProvider } from '../types.js';

export interface MockProviderOptions {
  clock: Clock;
  /** Minutes of simulated device→cloud sync lag (Fitbit Air ≈ 15). */
  syncLagMin: number;
  /** When the simulated sleeper fell asleep. Default: 4h before construction. */
  sleepStartUtc?: Date;
  /** Length of the simulated night. */
  nightHours?: number;
  /** Deterministic randomness for tests. */
  seed?: number;
}

const MINUTE_MS = 60_000;

/** Baseline heart rate per stage (bpm) — jitter is added per sample. */
const STAGE_HR: Record<SleepStage, number> = { awake: 68, light: 58, deep: 52, rem: 62 };

/**
 * Simulated Fitbit Air. Generates a physiologically plausible night as
 * per-minute samples (sleep latency, then ~90-min cycles where deep sleep
 * shrinks and REM grows toward morning), and only reveals samples older than
 * `syncLagMin` — mimicking the real BLE sync cadence so the wake engine is
 * exercised under honest conditions.
 */
export class MockSleepProvider implements SleepDataProvider {
  readonly name = 'mock' as const;
  private readonly clock: Clock;
  private readonly syncLagMin: number;
  private readonly samples: SleepSample[];
  readonly sleepStartUtc: Date;
  readonly sleepEndUtc: Date;

  constructor(opts: MockProviderOptions) {
    this.clock = opts.clock;
    this.syncLagMin = opts.syncLagMin;
    this.sleepStartUtc = opts.sleepStartUtc ?? new Date(opts.clock.now().getTime() - 4 * 60 * MINUTE_MS);
    const hours = opts.nightHours ?? 8;
    this.samples = generateNight(this.sleepStartUtc, hours, opts.seed ?? 42);
    this.sleepEndUtc = new Date(this.sleepStartUtc.getTime() + hours * 60 * MINUTE_MS);
  }

  async getLatestSamples(_userId: string, since: Date): Promise<SleepSample[]> {
    const visibleUntil = this.clock.now().getTime() - this.syncLagMin * MINUTE_MS;
    return this.samples.filter((s) => {
      const t = new Date(s.tsUtc).getTime();
      return t >= since.getTime() && t <= visibleUntil;
    });
  }

  async getSessions(userId: string, range: DateRange): Promise<SleepSession[]> {
    if (this.sleepEndUtc < range.startUtc || this.sleepStartUtc > range.endUtc) return [];
    return [samplesToSession(userId, this.samples, 'mock')];
  }
}

/** Deterministic PRNG (mulberry32) so tests and demos are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-minute samples for one night: latency, then ~90-min cycles. */
export function generateNight(startUtc: Date, hours: number, seed = 42): SleepSample[] {
  const rand = rng(seed);
  const totalMin = Math.round(hours * 60);
  const stages: SleepStage[] = [];

  const latency = 5 + Math.floor(rand() * 8);
  for (let i = 0; i < latency; i++) stages.push('awake');

  let cycle = 0;
  while (stages.length < totalMin) {
    // Deep sleep dominates early cycles; REM grows toward morning.
    const deepMin = Math.max(5, Math.round(35 - cycle * 8 + rand() * 6));
    const remMin = Math.min(45, Math.round(8 + cycle * 7 + rand() * 6));
    const push = (stage: SleepStage, n: number) => {
      for (let i = 0; i < n && stages.length < totalMin; i++) stages.push(stage);
    };
    push('light', 12 + Math.floor(rand() * 8));
    push('deep', deepMin);
    push('light', 8 + Math.floor(rand() * 6));
    push('rem', remMin);
    if (rand() < 0.3) push('awake', 1 + Math.floor(rand() * 2)); // brief arousal
    cycle++;
  }

  return stages.map((stage, i) => ({
    tsUtc: new Date(startUtc.getTime() + i * MINUTE_MS).toISOString(),
    stage,
    heartRateBpm: Math.round(STAGE_HR[stage] + (rand() - 0.5) * 6),
  }));
}

/** Collapse per-minute samples into contiguous stage segments. */
export function samplesToSegments(samples: SleepSample[]): SleepStageSegment[] {
  const segments: SleepStageSegment[] = [];
  for (const s of samples) {
    const last = segments[segments.length - 1];
    const end = new Date(new Date(s.tsUtc).getTime() + MINUTE_MS).toISOString();
    if (last && last.stage === s.stage && last.endUtc === s.tsUtc) {
      last.endUtc = end;
    } else {
      segments.push({ stage: s.stage, startUtc: s.tsUtc, endUtc: end });
    }
  }
  return segments;
}

export function samplesToSession(
  userId: string,
  samples: SleepSample[],
  source: SleepSession['source'],
): SleepSession {
  const stages = samplesToSegments(samples);
  const asleepMin = samples.filter((s) => s.stage !== 'awake').length;
  return {
    id: randomUUID(),
    userId,
    startUtc: samples[0]!.tsUtc,
    endUtc: new Date(new Date(samples[samples.length - 1]!.tsUtc).getTime() + MINUTE_MS).toISOString(),
    tzOffsetMin: 0,
    isNap: samples.length < 3 * 60,
    efficiencyPct: Math.round((asleepMin / samples.length) * 1000) / 10,
    source,
    stages,
  };
}
