import type { Confidence, MetricResult, MetricsReport } from '@fitbit-air-tracker/core';

/**
 * Plain-English helpers shared by the Today and Trends dashboards.
 * Status colors are reserved for state (good / caution / attention) and are
 * always paired with an icon + a word, never color alone.
 */

export const status = {
  good: '#4ade80',
  caution: '#fb923c',
  attention: '#f87171',
  neutral: '#94a3b8',
} as const;
export type Tone = keyof typeof status;

export const TONE_ICON: Record<Tone, string> = { good: '●', caution: '▲', attention: '◆', neutral: '○' };

/** The one series hue for every trend chart (validated ≥3:1 on the panel surface). */
export const SERIES = '#3987e5';
export const CHART = {
  grid: '#2b3a52',
  axis: '#475569',
  ref: '#94a3b8',
  empty: '#334155',
};

export function fmtMinutes(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return '—';
  const total = Math.round(Math.abs(m));
  const h = Math.floor(total / 60);
  const mm = total % 60;
  if (h === 0) return `${mm} m`;
  return mm === 0 ? `${h} h` : `${h} h ${mm} m`;
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function fmtSigned(v: number, digits = 1): string {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Rough estimate',
};

const INPUT_LABELS: Record<string, string> = {
  session: 'sleep times',
  'session.stages': 'sleep stages',
  'session.efficiencyPct': 'sleep efficiency',
  stagesProcessed: 'stage processing status',
  heartRate: 'heart rate',
  hrv: 'heart-rate variability',
  dailyHrv: 'heart-rate variability',
  'dailyHrv.rmssdMs': 'heart-rate variability',
  restingHrBpm: 'resting heart rate',
  spo2: 'blood oxygen',
  dailySpo2: 'blood oxygen',
  respiratory: 'breathing rate',
  'respiratory.fullSleepBrpm': 'breathing rate',
  skinTempDeltaC: 'skin temperature',
  steps: 'steps',
  stillPeriods: 'stillness',
  phoneMotion: 'phone motion',
  mood: 'mood check-ins',
};

export function inputLabel(field: string): string {
  return INPUT_LABELS[field] ?? INPUT_LABELS[field.split('.')[0]!] ?? field;
}

export function inputsSentence(fields: string[]): string {
  const uniq = [...new Set(fields.map(inputLabel))];
  return uniq.length ? uniq.join(', ') : 'nothing yet';
}

/** Human method name: 'hrv-rhr-v1' → 'HRV + resting HR'. Falls back to the id. */
const METHOD_LABELS: Record<string, string> = {
  'stages-v1': 'Sleep stages',
  'session-span-v1': 'Sleep start to end',
  'duration-only-v1': 'Duration only',
  'hr-actigraphy-v1': 'Heart rate + movement',
  'hrv-rhr-v1': 'HRV + resting heart rate',
  'rhr-sleep-v1': 'Resting heart rate + sleep',
  'sleep-only-v1': 'Sleep only',
  'rolling-14d-v1': 'Last 14 nights',
  'last-7d-v1': 'Last 7 nights',
  'bedtime-spread-v1': 'Bedtime & wake spread',
  'respiratory-v1': 'Band breathing rate',
  'stage-avg-v1': 'Average across stages',
  'delta-v1': 'Change from baseline',
  'stage-at-wake-v1': 'Stage at wake-up',
  'sleep-mood-v1': 'Sleep vs. mood',
};
export function methodLabel(id: string): string {
  return METHOD_LABELS[id] ?? id;
}

/** Format a metric value by its id (see conventions in services/dashboardData.ts). */
export function fmtMetric(r: Pick<MetricResult, 'metric' | 'value' | 'unit'>): string {
  if (r.value == null) return 'no value';
  switch (r.metric) {
    case 'sleepDuration':
    case 'sleepDebt':
      return fmtMinutes(r.value);
    case 'breathing':
      return `${fmtNum(r.value, 1)} breaths/min`;
    case 'skinTemp':
      return `${fmtSigned(r.value)} °C`;
    case 'moodLink':
      return `${fmtSigned(r.value)} mood pts`;
    default:
      return r.unit && r.unit !== 'pts' ? `${fmtNum(r.value)} ${r.unit}` : `${fmtNum(r.value)}`;
  }
}

export function best(report: MetricsReport | undefined, id: string): MetricResult | undefined {
  return report?.best[id];
}

/** Best value or undefined (null values are "method ran but no answer"). */
export function bestValue(report: MetricsReport | undefined, id: string): number | undefined {
  const v = report?.best[id]?.value;
  return v == null ? undefined : v;
}

export interface Verdict {
  tone: Tone;
  /** Headline status: the engine's `MetricResult.label` when present, else ours. */
  label: string;
  meaning: string;
}

interface Tier extends Verdict {
  /** Lower bound of the value band (first matching tier wins; list high → low). */
  min: number;
  /** Lower-cased engine labels that mean this tier. */
  aliases: string[];
}

/**
 * Prefer the engine's label (and the meaning that goes with it); fall back to
 * our own value bands. An unknown engine label is still shown verbatim.
 */
function verdict(tiers: Tier[], value: number | undefined, label?: string): Verdict {
  const byValue = value != null ? tiers.find((t) => value >= t.min) ?? tiers[tiers.length - 1]! : undefined;
  const byLabel = label ? tiers.find((t) => t.aliases.includes(label.trim().toLowerCase())) : undefined;
  const t = byLabel ?? byValue ?? { tone: 'neutral' as Tone, label: label ?? '—', meaning: '' };
  return { tone: t.tone, label: label ?? t.label, meaning: t.meaning };
}

const SLEEP_TIERS: Tier[] = [
  { min: 85, tone: 'good', label: 'Great', aliases: ['great', 'excellent'], meaning: 'Excellent sleep — a strong start to the day.' },
  { min: 70, tone: 'good', label: 'Good', aliases: ['good'], meaning: 'You slept well — a solid base for the day.' },
  { min: 55, tone: 'caution', label: 'Fair', aliases: ['fair', 'ok', 'okay'], meaning: 'Okay sleep. An earlier night would help.' },
  { min: -Infinity, tone: 'attention', label: 'Poor', aliases: ['poor', 'low'], meaning: 'Short or broken sleep. Go easy today and aim for an early night.' },
];
export const sleepScoreVerdict = (score?: number, label?: string) => verdict(SLEEP_TIERS, score, label);

const RECOVERY_TIERS: Tier[] = [
  { min: 67, tone: 'good', label: 'Train hard', aliases: ['train hard', 'ready'], meaning: 'Your body looks recovered — a good day for a hard session.' },
  { min: 34, tone: 'caution', label: 'Train light', aliases: ['train light', 'moderate'], meaning: 'Partly recovered — keep the gym session light or technical.' },
  { min: -Infinity, tone: 'attention', label: 'Rest', aliases: ['rest', 'recover'], meaning: 'Recovery is low — rest, walk, stretch, and sleep early.' },
];
/** `label` is the recommendation ("Train hard" / "Train light" / "Rest"). */
export const recoveryVerdict = (score?: number, label?: string) => verdict(RECOVERY_TIERS, score, label);

const DEBT_TIERS: Tier[] = [
  // value = minutes of debt, so bands are checked low → high via negated value
  { min: -60, tone: 'good', label: 'Low', aliases: ['low', 'none', 'rested'], meaning: 'You’re close to fully rested.' },
  { min: -180, tone: 'caution', label: 'Some', aliases: ['some', 'moderate'], meaning: 'A little behind — a nap or early night will help.' },
  { min: -Infinity, tone: 'attention', label: 'High', aliases: ['high'], meaning: 'Well behind on sleep — protect your bedtime this week.' },
];
export const debtVerdict = (min?: number, label?: string) => verdict(DEBT_TIERS, min != null ? -min : undefined, label);

const CONSISTENCY_TIERS: Tier[] = [
  { min: 75, tone: 'good', label: 'Steady', aliases: ['steady', 'great', 'good', 'regular'], meaning: 'Regular bed and wake times — great for waking for Fajr.' },
  { min: 50, tone: 'caution', label: 'Uneven', aliases: ['uneven', 'fair'], meaning: 'Bedtimes drift a bit. Steadier times make Fajr easier.' },
  { min: -Infinity, tone: 'attention', label: 'Irregular', aliases: ['irregular', 'poor'], meaning: 'Bedtimes vary a lot, which makes early waking harder.' },
];
export const consistencyVerdict = (score?: number, label?: string) => verdict(CONSISTENCY_TIERS, score, label);

const FAJR_TIERS: Tier[] = [
  { min: 70, tone: 'good', label: 'Easy', aliases: ['easy'], meaning: 'You woke from light sleep — the easiest moment to get up.' },
  { min: 45, tone: 'caution', label: 'Moderate', aliases: ['moderate', 'medium'], meaning: 'You woke from dream (REM) sleep — usually okay.' },
  { min: -Infinity, tone: 'attention', label: 'Hard', aliases: ['hard'], meaning: 'You woke from deep sleep, which can feel groggy.' },
];
export const fajrEaseVerdict = (score?: number, label?: string) => verdict(FAJR_TIERS, score, label);

/** Breathing / skin temp: the engine's label drives the tone; no value bands of our own. */
const LABEL_TONES: Record<string, Tone> = {
  'normal for you': 'good',
  normal: 'good',
  unusual: 'caution',
  elevated: 'caution',
  higher: 'caution',
  cooler: 'neutral',
  lower: 'neutral',
};
export function toneForLabel(label: string | undefined, fallback: Tone): Tone {
  return (label && LABEL_TONES[label.trim().toLowerCase()]) || fallback;
}

/** Nights needed before a baseline counts as "your normal". */
export const BASELINE_NIGHTS = 14;
export type BaselineKey = keyof NonNullable<MetricsReport['baselines']['counts']>;

/** "still learning your normal (9/14 nights)" — or undefined once learned / unknown. */
export function learningNote(report: MetricsReport | undefined, key: BaselineKey): string | undefined {
  const n = report?.baselines.counts?.[key];
  if (n == null || n >= BASELINE_NIGHTS) return undefined;
  return `still learning your normal (${n}/${BASELINE_NIGHTS} nights)`;
}
