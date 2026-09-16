# Google Health API (Fitbit Air data) — setup, contract, day-one experiment

Everything Google-side is **already implemented**; this page is what you do
when the band arrives. Source of truth for the API shapes: Google's official v4
discovery document (`https://health.googleapis.com/$discovery/rest?version=v4`)
and Google's open-source CLI (`github.com/Google-Health-API/google-health-cli`).

## 1. Google Cloud Console (≈10 minutes, same recipe as a Calendar script)

1. https://console.cloud.google.com → create a project (e.g. `smartwake`).
2. **APIs & Services ▸ Library** → search **Google Health API** → Enable.
3. **APIs & Services ▸ OAuth consent screen** → External → fill name/email →
   **Publishing status: Testing** → **Test users: add your own Gmail** (the
   account you use in the Google Health app). No verification needed for
   personal use; the "Restricted scopes" review only applies if you publish.
4. **Credentials ▸ Create credentials ▸ OAuth client ID**, one per client:
   - **iOS** (for the iPhone app): bundle ID = `ios.bundleIdentifier` in
     `mobile/app.json` (`com.smartwake.prayer` unless you changed it). Copy
     the **Client ID** (there is no secret for iOS clients — PKCE is used).
   - **Web application** (for the server / web app / Raspberry Pi):
     Authorized redirect URI = `http://localhost:3001/api/v1/auth/google/callback`
     (or your server's public URL). Copy **Client ID + Client secret**.

## 2. Connect

**iPhone app:** put the iOS Client ID in `mobile/.env` as
`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=…` (copy `mobile/.env.example`), then rebuild
once (`npx expo prebuild --platform ios && npx expo run:ios --device`) — this
registers the redirect URL scheme Google requires for iOS clients
(`com.googleusercontent.apps.<id>`). In the app: Settings ▸ *Sleep data* ▸
**Connect Google** ▸ sign in ▸ accept the two read-only scopes. The source
switches to **Google Health (Fitbit Air)** automatically. Tokens live in the
iOS Keychain (SecureStore) and refresh automatically.

**Server / web:** put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (and
`GOOGLE_REDIRECT_URI` if not localhost) in `server/.env`, optionally
`PROVIDER=google_health`, restart, open the web app ▸ **Device** ▸ **Connect
Google**. Tokens live in the `oauth_tokens` table. `npm run google:probe -w server`
prints the freshness report from the command line (works on a Pi).

Scopes requested (read-only): `googlehealth.sleep.readonly`,
`googlehealth.activity_and_fitness.readonly` (heart rate).

## 3. API contract we implement (`packages/core/src/providers/googleHealth/`)

| Item | Value |
|------|-------|
| Endpoint | `GET https://health.googleapis.com/v4/users/me/dataTypes/{sleep\|heart-rate}/dataPoints` |
| Params | `filter` (AIP-160; only `>=` and `<`), `pageSize`, `pageToken` → `{dataPoints[], nextPageToken}` |
| Sleep filter | **end time only**: `sleep.interval.end_time >= "2026-07-04T00:00:00Z"` |
| Sleep page size | **max 25** (we paginate) |
| Heart-rate filter | `heart_rate.sample_time.physical_time >= "…Z"` (default page 1440, max 10000) |
| Sleep point | `sleep.interval{startTime,endTime,startUtcOffset:"10800s"}`, `type: CLASSIC\|STAGES`, `stages[{type,startTime,endTime}]`, `summary{minutesAsleep,…}` (int64 → **strings**), `metadata{processed,nap,mainSleep,stagesStatus}` |
| Stage enum → ours | AWAKE→awake, LIGHT→light, DEEP→deep, REM→rem, ASLEEP→light (classic), RESTLESS→awake |
| Heart-rate point | `heartRate.sampleTime.physicalTime`, `beatsPerMinute` (string) |
| OAuth | `accounts.google.com/o/oauth2/v2/auth` + `oauth2.googleapis.com/token`, PKCE S256, `access_type=offline&prompt=consent` for a refresh token |
| Poll floor | provider caches 60 s (never hammer the API; the band syncs ~15 min anyway) |
| Webhooks | project-level `projects/{p}/subscribers` (need `cloud-platform` IAM) — not needed for personal use; later |

`metadata.processed = false` means "sleep period detected, stages still
processing" — the field that tells us whether **tonight's** sleep is visible
before you wake up.

## 4. Files
```
packages/core/src/providers/googleHealth/
  types.ts     schema subset · api.ts client + filters · oauth.ts URL/exchange/refresh/TokenManager
  mapping.ts   → SleepSession / per-minute SleepSample · provider.ts GoogleHealthProvider + probe()
  __fixtures__/ realistic responses built from the schema · *.test.ts
mobile/src/services/googleAuth.ts   PKCE sign-in (expo-auth-session) + SecureStore tokens
server/src/providers/googleHealth/  DbTokenStore + factory · server/scripts/google-probe.ts
server/src/api/routes.ts            /api/v1/auth/google/{start,callback,status}, DELETE /api/v1/auth/google,
                                    GET /api/v1/google/probe, POST /api/v1/google/sync
```

## 5. Day-one experiment (decides how "smart" the wake can be)

Wear the band, sleep 2–3 hours, then — without getting up more than needed —
run the probe (iPhone: Settings ▸ *Test Google sleep fetch now*; server:
`npm run google:probe -w server`). Repeat once more before Fajr.

| Probe shows | Meaning | What the app does |
|-------------|---------|-------------------|
| `anyUnprocessedSession: true` and `stageLagMin` ≲ 20 | Tonight's stages are visible mid-night | Full smart wake from real stages in Bedside mode (`decide()` light-sleep rule) |
| Stages absent/stale but `heartRateLagMin` ≲ 20 | Only heart rate is live | Bedside wakes on the **HR-rise** rule; stages fill in for history/insights |
| Both stale (only completed nights appear) | Cloud data is post-hoc only | Use the band's own **Smart Wake** alarm for the wrist + our AlarmKit deadline alarm; app owns prayer times, custom alarms, history |

Record the result as an event (the probe logs `google.probe`) and update
`docs/ROADMAP.md` M2.1 with the outcome.

## 6. Troubleshooting
- `access_denied` / "app not verified": your Gmail isn't in **Test users**, or
  the consent screen isn't in Testing mode.
- `redirect_uri_mismatch` (server): the Web client's redirect URI must equal
  `GOOGLE_REDIRECT_URI` exactly.
- iPhone sign-in returns but stays disconnected: the iOS client's bundle ID
  must match `app.json`; the redirect is `smartwake:/oauth2redirect` (scheme
  `smartwake` is in `app.json`).
- 401 loops: tokens revoked → Disconnect and sign in again.
- Empty sleep list: the band uploads a night only after sync; open the Google
  Health app to force a sync, then probe again.
