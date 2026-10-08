export const colors = {
  bg: '#0f172a',
  panel: '#1e293b',
  border: '#334155',
  text: '#e2e8f0',
  muted: '#94a3b8',
  accent: '#fbbf24',
  accent2: '#38bdf8',
  danger: '#f87171',
  ok: '#4ade80',
  stage: { awake: '#f87171', light: '#38bdf8', deep: '#1d4ed8', rem: '#a78bfa' } as Record<string, string>,
};

export function fmtTime(iso: string | Date, tz?: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz });
}

export function fmtDate(iso: string | Date, tz?: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
}

export const PRAYER_LABELS: Record<string, string> = {
  fajr: 'Fajr',
  sunrise: 'Sunrise',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
  lastthird: 'Last third of night',
  qiyam: 'Qiyam (last third)',
  suhoor: 'Suhoor',
};

export const CALC_METHODS: [number, string][] = [
  [3, 'Muslim World League'],
  [2, 'ISNA'],
  [5, 'Egyptian'],
  [4, 'Umm al-Qura'],
  [1, 'Karachi'],
  [8, 'Gulf'],
  [13, 'Diyanet'],
];
