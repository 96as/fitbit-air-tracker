/**
 * Rolling personal baselines: medians (and robust spreads, used internally for
 * z-scores) over the last N nights. Pure; history is ordered oldest → newest.
 */
import type { Baselines, NightData } from '../health/types.js';
import { extractFeatures, type NightFeatures } from './features.js';
import { bedtimeMinutes, isNum, localMinuteOfDay, median, robustSd } from './util.js';

export const DEFAULT_BASELINE_NIGHTS = 30;

export interface BaselineOptions {
  /** How many of the most recent nights to use (default 30). */
  nights?: number;
}

export interface BaselineStats {
  baselines: Baselines;
  /** Nights that contributed a value, per field. */
  counts: { rhr: number; rmssd: number; resp: number; spo2: number; sleep: number; timing: number };
  rhrSd?: number;
  /** Robust SD of ln(rMSSD) — the scale HRV-guided training literature uses. */
  lnRmssdSd?: number;
  respSd?: number;
  spo2Sd?: number;
}

export function baselineStats(history: NightFeatures[], opts: BaselineOptions = {}): BaselineStats {
  const win = Math.max(1, Math.floor(opts.nights ?? DEFAULT_BASELINE_NIGHTS));
  const feats = history.slice(-win);
  const vals = (pick: (f: NightFeatures) => number | undefined) => feats.map(pick).filter(isNum);
  const rhr = vals((f) => f.rhr?.value);
  const rmssd = vals((f) => f.rmssd?.value).filter((x) => x > 0);
  const resp = vals((f) => f.respBrpm?.value);
  const spo2 = vals((f) => f.spo2Avg?.value);
  const sleep = vals((f) => f.asleep?.value);
  const timings = feats.map((f) => ({ t: f.timing, tz: f.night.tz })).filter((x) => x.t);
  const bed = timings.map((x) => bedtimeMinutes(x.t!.value.bedUtc, x.tz));
  const wake = timings.map((x) => localMinuteOfDay(x.t!.value.wakeUtc, x.tz));

  const baselines: Baselines = { nights: feats.length };
  const set = <K extends keyof Baselines>(k: K, v: number | undefined, d = 1) => {
    if (isNum(v)) (baselines as unknown as Record<string, number>)[k] = Math.round(v * 10 ** d) / 10 ** d;
  };
  set('restingHrBpm', median(rhr));
  set('rmssdMs', median(rmssd));
  set('respiratoryBrpm', median(resp));
  set('spo2AvgPct', median(spo2));
  set('sleepMinutes', median(sleep), 0);
  set('bedtimeMin', median(bed), 0);
  set('waketimeMin', median(wake), 0);

  return {
    baselines,
    counts: { rhr: rhr.length, rmssd: rmssd.length, resp: resp.length, spo2: spo2.length, sleep: sleep.length, timing: timings.length },
    rhrSd: robustSd(rhr),
    lnRmssdSd: robustSd(rmssd.map(Math.log)),
    respSd: robustSd(resp),
    spo2Sd: robustSd(spo2),
  };
}

/** Medians over the last `opts.nights` (default 30) nights of `history`. */
export function computeBaselines(history: NightData[], opts: BaselineOptions = {}): Baselines {
  const win = Math.max(1, Math.floor(opts.nights ?? DEFAULT_BASELINE_NIGHTS));
  return baselineStats(history.slice(-win).map((n) => extractFeatures(n)), opts).baselines;
}
