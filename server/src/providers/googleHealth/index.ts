import type { SleepSample, SleepSession } from '../../types.js';
import type { DateRange, SleepDataProvider } from '../types.js';

/**
 * Phase 2 stub — Google Health API provider for the Fitbit Air.
 *
 * Implementation notes (see docs/INTEGRATIONS.md §1):
 * - OAuth 2.0 auth-code flow; tokens live in the oauth_tokens table.
 * - subscribe(): register the webhook endpoint; the receiver in
 *   src/api/routes.ts already ACKs within the required 5 s and triggers an
 *   engine tick — this provider only needs to do the registration call.
 * - getLatestSamples(): fetch the intraday sleep-stage + heart-rate series
 *   since `since` and map to SleepSample (stage names normalize to
 *   awake|light|deep|rem; timestamps to ISO-8601 UTC).
 * - getSessions(): map sleep-session resources to SleepSession, preserving
 *   the provider's session ids in raw_ref for traceability.
 * - Expect data to trail wall time by ~15 min (device sync cadence) — the
 *   wake engine already tolerates this; do not busy-poll faster than 60 s.
 */
export class GoogleHealthProvider implements SleepDataProvider {
  readonly name = 'google_health' as const;

  constructor(_opts: { clientId?: string; clientSecret?: string }) {}

  async getLatestSamples(_userId: string, _since: Date): Promise<SleepSample[]> {
    throw new Error(
      'Google Health API provider is not implemented yet (Phase 2). ' +
        'Set PROVIDER=mock, or see docs/INTEGRATIONS.md to request API access.',
    );
  }

  async getSessions(_userId: string, _range: DateRange): Promise<SleepSession[]> {
    throw new Error('Google Health API provider is not implemented yet (Phase 2).');
  }

  async subscribe(_userId: string): Promise<void> {
    throw new Error('Google Health API provider is not implemented yet (Phase 2).');
  }
}
