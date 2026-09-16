import { describe, expect, it, vi } from 'vitest';
import { GoogleHealthApiError, GoogleHealthClient, heartRateFilter, sleepFilter } from './api.js';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('filters (AIP-160, exactly what the API accepts)', () => {
  it('sleep filters on end_time only, RFC-3339 without millis', () => {
    expect(sleepFilter({ endTimeFromUtc: new Date('2026-07-04T00:00:00.000Z') })).toBe(
      'sleep.interval.end_time >= "2026-07-04T00:00:00Z"',
    );
    expect(
      sleepFilter({ endTimeFromUtc: new Date('2026-07-04T00:00:00Z'), endTimeToUtc: new Date('2026-07-05T00:00:00Z') }),
    ).toBe('sleep.interval.end_time >= "2026-07-04T00:00:00Z" AND sleep.interval.end_time < "2026-07-05T00:00:00Z"');
  });
  it('heart rate filters on sample physical_time', () => {
    expect(heartRateFilter({ fromUtc: new Date('2026-07-04T20:00:00Z') })).toBe(
      'heart_rate.sample_time.physical_time >= "2026-07-04T20:00:00Z"',
    );
  });
});

describe('GoogleHealthClient', () => {
  it('builds the v4 URL, sends the bearer token, and paginates sleep at 25/page', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      if (url.includes('pageToken=p2')) return jsonResponse({ dataPoints: [{ name: 'b' }] });
      return jsonResponse({ dataPoints: [{ name: 'a' }], nextPageToken: 'p2' });
    });
    const client = new GoogleHealthClient({ getAccessToken: async () => 'tok', fetchImpl: fetchImpl as typeof fetch, retryBaseMs: 0 });
    const points = await client.listSleep({ endTimeFromUtc: new Date('2026-07-04T00:00:00Z') });
    expect(points.map((p) => p.name)).toEqual(['a', 'b']);
    expect(calls[0]).toContain('https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints?');
    expect(calls[0]).toContain('pageSize=25');
    expect(new URL(calls[0]!).searchParams.get('filter')).toBe('sleep.interval.end_time >= "2026-07-04T00:00:00Z"');
  });

  it('refreshes once on 401 then retries', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (n++ === 0 ? jsonResponse({ error: 'expired' }, 401) : jsonResponse({ dataPoints: [] })));
    const onUnauthorized = vi.fn(async () => 'fresh');
    const client = new GoogleHealthClient({ getAccessToken: async () => 'old', onUnauthorized, fetchImpl: fetchImpl as typeof fetch, retryBaseMs: 0 });
    await client.listHeartRate({ fromUtc: new Date() });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries 5xx with backoff and finally throws a typed error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'boom' } }, 503));
    const client = new GoogleHealthClient({ getAccessToken: async () => 't', fetchImpl: fetchImpl as typeof fetch, retryBaseMs: 0 });
    await expect(client.listHeartRate({ fromUtc: new Date() })).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(4); // 1 + 3 retries
  });
});
