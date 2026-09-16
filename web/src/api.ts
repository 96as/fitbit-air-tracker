export interface AlarmPolicy {
  id: string;
  userId: string;
  prayer: string;
  enabled: boolean;
  windowMinutes: number;
  deadlineOffsetMinutes: number;
  preferredStages: string[];
  snoozeMinutes: number;
  maxSnoozes: number;
}

export interface User {
  id: string;
  email: string;
  tz: string;
  lat: number;
  lng: number;
  calcMethod: number;
  madhab: 0 | 1;
}

export interface PlanEntry {
  prayer: string;
  prayerTimeUtc: string;
  deadlineUtc: string;
  windowStartUtc: string;
  policy: AlarmPolicy;
}

export interface TonightPlan {
  nowUtc: string;
  tz: string;
  plans: PlanEntry[];
}

export interface StageSegment {
  stage: 'awake' | 'light' | 'deep' | 'rem';
  startUtc: string;
  endUtc: string;
}

export interface SleepSession {
  id: string;
  startUtc: string;
  endUtc: string;
  isNap: boolean;
  efficiencyPct?: number;
  source: string;
  stages: StageSegment[];
}

export interface AlarmEvent {
  id: string;
  policyId: string;
  type: 'scheduled' | 'fired' | 'snoozed' | 'dismissed';
  reason?: string;
  tsUtc: string;
}

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  active: boolean;
  redirectUri: string;
}

export interface ProbeReport {
  checkedAtUtc: string;
  sessionsLast48h: number;
  newestSessionEndUtc?: string;
  newestStageEndUtc?: string;
  newestHeartRateUtc?: string;
  anyUnprocessedSession: boolean;
  stageLagMin?: number;
  heartRateLagMin?: number;
}

export interface Status {
  provider: string;
  mockMode: boolean;
  pushConfigured: boolean;
  scheduledAlarms: {
    prayer: string;
    windowStartUtc: string;
    deadlineUtc: string;
    prayerTimeUtc: string;
    fired: boolean;
  }[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  status: () => request<Status>('/api/v1/status'),
  settings: () => request<{ user: User; policies: AlarmPolicy[] }>('/api/v1/settings'),
  saveSettings: (body: Partial<User>) =>
    request<{ user: User }>('/api/v1/settings', { method: 'PUT', body: JSON.stringify(body) }),
  savePolicy: (body: Partial<AlarmPolicy> & { prayer: string }) =>
    request<{ policy: AlarmPolicy }>('/api/v1/alarms/policy', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  timetable: (date?: string) =>
    request<{ date: string; timesUtc: Record<string, string> }>(
      `/api/v1/prayer/timetable${date ? `?date=${date}` : ''}`,
    ),
  tonight: () => request<TonightPlan>('/api/v1/plan/tonight'),
  sessions: (limit = 14) =>
    request<{ sessions: SleepSession[] }>(`/api/v1/sleep/sessions?limit=${limit}`),
  pendingAlarm: () => request<{ pending: AlarmEvent | null }>('/api/v1/alarms/pending'),
  ack: (snooze: boolean) =>
    request<{ ok: boolean }>('/api/v1/alarms/ack', {
      method: 'POST',
      body: JSON.stringify({ snooze }),
    }),
  pushKey: () => request<{ publicKey: string | null }>('/api/v1/push/key'),
  subscribePush: (sub: PushSubscriptionJSON) =>
    request<{ ok: boolean }>('/api/v1/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }),
    }),
  fireTest: () => request<{ ok: boolean }>('/api/v1/demo/fire-test', { method: 'POST' }),
  googleStatus: () => request<GoogleStatus>('/api/v1/auth/google/status'),
  googleDisconnect: () => request<{ ok: boolean }>('/api/v1/auth/google', { method: 'DELETE' }),
  googleProbe: () => request<ProbeReport>('/api/v1/google/probe'),
  googleSync: () => request<{ saved: number }>('/api/v1/google/sync', { method: 'POST' }),
};

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
