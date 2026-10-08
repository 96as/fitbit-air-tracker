import { describe, expect, it, vi } from 'vitest';
import { GoogleHealthClient } from './api.js';
import { GoogleHealthProvider } from './provider.js';
import type { GhListDataPointsResponse } from './types.js';
import inProgressFixture from './__fixtures__/sleep-inprogress.json';
import hrFixture from './__fixtures__/heart-rate.json';

class FakeClock {
  constructor(public current: Date) {}
  now() {
    return new Date(this.current);
  }
}

function fakeClient(sleep: GhListDataPointsResponse, hr: GhListDataPointsResponse) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/sleep/') ? sleep : hr;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { client: new GoogleHealthClient({ getAccessToken: async () => 't', fetchImpl: fetchImpl as typeof fetch }), fetchImpl };
}

describe('GoogleHealthProvider', () => {
  it('merges sleep stages + heart rate into per-minute samples usable by the engine', async () => {
    const { client } = fakeClient(inProgressFixture as GhListDataPointsResponse, hrFixture as GhListDataPointsResponse);
    const clock = new FakeClock(new Date('2026-07-04T23:50:00Z'));
    const provider = new GoogleHealthProvider({ client, clock });
    const samples = await provider.getLatestSamples('u1', new Date('2026-07-04T23:00:00Z'));
    expect(samples.length).toBe(45); // 23:00 → 23:44 inclusive
    expect(samples.at(-1)).toMatchObject({ tsUtc: '2026-07-04T23:44:00.000Z', stage: 'light', heartRateBpm: 58 });
  });

  it('never polls the API more often than once per 60 s (platform invariant)', async () => {
    const { client, fetchImpl } = fakeClient(inProgressFixture as GhListDataPointsResponse, hrFixture as GhListDataPointsResponse);
    const clock = new FakeClock(new Date('2026-07-04T23:50:00Z'));
    const provider = new GoogleHealthProvider({ client, clock });
    const since = new Date('2026-07-04T23:00:00Z');
    await provider.getLatestSamples('u1', since);
    clock.current = new Date('2026-07-04T23:50:30Z');
    await provider.getLatestSamples('u1', since);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // sleep + hr, once
    clock.current = new Date('2026-07-04T23:51:01Z');
    await provider.getLatestSamples('u1', since);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('probe() reports freshness and the unprocessed (in-progress) flag', async () => {
    const { client } = fakeClient(inProgressFixture as GhListDataPointsResponse, hrFixture as GhListDataPointsResponse);
    const clock = new FakeClock(new Date('2026-07-04T23:50:00Z'));
    const provider = new GoogleHealthProvider({ client, clock });
    const report = await provider.probe('u1');
    expect(report).toMatchObject({
      sessionsLast48h: 1,
      newestStageEndUtc: '2026-07-04T23:45:00.000Z',
      newestHeartRateUtc: '2026-07-04T23:44:00.000Z',
      anyUnprocessedSession: true,
      stageLagMin: 5,
      heartRateLagMin: 6,
    });
  });

  it('getSessions returns mapped sessions newest-first', async () => {
    const { client } = fakeClient(inProgressFixture as GhListDataPointsResponse, hrFixture as GhListDataPointsResponse);
    const provider = new GoogleHealthProvider({ client, clock: new FakeClock(new Date()) });
    const sessions = await provider.getSessions('u1', { startUtc: new Date('2026-07-01T00:00:00Z'), endUtc: new Date('2026-07-05T00:00:00Z') });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.source).toBe('google_health');
  });
});
