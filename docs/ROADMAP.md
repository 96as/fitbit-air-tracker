# Roadmap — ordered, self-contained tasks

Work top-to-bottom; each task is designed to be completable in one session
without re-deriving design decisions. Before starting any task: read
`CLAUDE.md` (invariants!) and the relevant SPEC/ARCHITECTURE sections. After
any task: `npm run build && npm test` must pass, and update the checkbox here.

Conventions for every task:
- New endpoints go in `server/src/api/routes.ts`, typed client methods in
  `web/src/api.ts`, SQL only in `server/src/db/index.ts` (+ `schema.sql`,
  additive `CREATE TABLE IF NOT EXISTS` / new columns via `ALTER TABLE` guarded
  by a try/catch, since there is no migration tool yet).
- Log every user-relevant occurrence to `event_log` via `db.logEvent(kind, …)`
  — this is the AI-agent substrate; skipping it loses training signal.

---

## Phase M — iPhone app (primary product; see docs/MOBILE.md)

### [x] M1 Standalone Expo app with AlarmKit, custom wake times, Bedside smart wake, backup chain
Done: `mobile/` + shared `packages/core`. Verified by type-check, Metro bundle
and prebuild; needs a first real run on a Mac (`npx expo run:ios --device`).

### [ ] M1.1 First device run + fixes
Run on the iPhone per docs/MOBILE.md §1. Expected rough edges to check and fix:
AlarmKit permission prompt appears; a custom alarm 2 min ahead rings with the
phone locked and keeps ringing until Stop; Bedside "Demo night" rings in-app
and "I'm awake" stops sound+haptics; Settings ▸ Use my location updates prayer
times. Record anything broken as tasks here.
**Accept:** all four behaviors confirmed on device; screenshots in the PR.

### [ ] M2 Real Fitbit Air data on the phone (Google Health API, on-device OAuth)
**Gate: user confirms Google Health API developer access.** Implement
`mobile/src/services/googleHealthProvider.ts` behind `SleepDataProvider`:
OAuth 2.0 with PKCE via `expo-auth-session` (no client secret on device),
tokens in `expo-secure-store`, `getLatestSamples` polling the intraday
sleep-stage + heart-rate endpoints (≥ 60 s apart) while Bedside mode is armed;
`getSessions` for history into `store.sessions`. Provider choice in Settings.
Field mapping notes: `server/src/providers/googleHealth/index.ts` + docs/INTEGRATIONS.md §1.
**Accept:** recorded-fixture unit test for the mapping (fixtures committed);
a real night visible in Tonight; Bedside fires from real stages.

### [ ] M3 Back-to-sleep detection + wake-ease feedback on the phone
After "I'm awake", keep the provider polling for 30 min (Bedside stays armed);
new sleep onset → re-ring once. Add the 👍/👎 "was waking easy?" card on
Tonight the morning after a dismissed alarm → `events[]` (`wake.feedback`).
**Accept:** simulation test in core (mock night resumes after dismiss → one
re-fire); feedback appears in events.

### [ ] M4 Apple Watch / HealthKit sleep as an alternative provider
For users without a Fitbit: read sleep stages from HealthKit (`react-native-health`
or an Expo module; free personal team allows the HealthKit capability).
Same `SleepDataProvider` interface.

### [ ] M5 Export + sync
"Export data" (share sheet, JSON of settings/alarms/sessions/events) and
optional sync of `events[]`/sessions to the server's `event_log`/tables so the
MCP/agent surface (Phase 4) sees phone data.

### [ ] M6 Android build
Alarm tier 1 on Android = `AlarmManager` exact alarms + full-screen intent
(`expo-alarm` or a small native module); notification channel already exists.

---

## Phase 1 — Web client: harden alarms & complete the MVP UX (no external access needed)

### [ ] 1.1 Server-side snooze re-fire with maxSnoozes cap
Currently snooze only re-arms the Bedside page locally; push users never get a
re-ring. Implement: when `POST /api/v1/alarms/ack {snooze:true}` is received,
schedule a re-fire at `now + policy.snoozeMinutes` (a `setTimeout` held in a
Map in `PushService` or a small `SnoozeManager` in `server/src/wake/` is fine —
it does not need to survive restarts yet). Count snoozes per fired alarm
(`alarm_events.detail_json`); at `maxSnoozes` the re-fire payload says "last
snooze". Never re-fire after a `dismissed` event.
**Accept:** unit test covering snooze→re-fire→dismiss and the cap; existing
tests stay green; `event_log` gets `alarm.snooze-refire` entries.

### [ ] 1.2 Wake-ease feedback loop (v1: capture only)
Add `POST /api/v1/alarms/feedback {easy: boolean, note?: string}` — attaches to
the most recent dismissed alarm, stored as `wake.feedback` in `event_log` and a
new `alarm_events` type is NOT needed (keep the enum stable). Dashboard: after
a dismissed alarm exists for today, show a one-tap "Was waking easy? 👍/👎" card
(hide after answering). This data later drives per-user window tuning (3.1).
**Accept:** feedback POST + retrieval via `GET /api/v1/alarms/events`; card
appears/disappears correctly; build+tests green.

### [ ] 1.3 Per-prayer policies UI + daytime reminders
Settings page currently edits only Fajr. Render ALL policies (fajr, dhuhr,
asr, maghrib, isha, qiyam) from `GET /api/v1/settings`, each with
enable/window/deadline-offset controls (daytime prayers typically use
windowMinutes=0 → pure reminder at deadline; the engine already handles this:
with an empty window the deadline rule fires). Seed disabled default policies
for the five daily prayers + qiyam in `Db.seedDemoUser()`.
**Accept:** enabling `dhuhr` produces a scheduled alarm in
`GET /api/v1/status` and it fires at its deadline (test via a policy whose
deadline is 1–2 min ahead); qiyam anchors to the `lastthird` timing
(`timingKeyForPrayer` already maps it).

### [ ] 1.4 PWA installability polish
Add real PNG icons (192px + 512px, generated from `web/public/icon.svg`) to
the manifest (Chrome requires PNG for install prompts), `apple-touch-icon`,
and an "Install app" hint on the Connect page when
`beforeinstallprompt` fires. Keep the SVG icon too.
**Accept:** Lighthouse PWA installability check passes locally; no console
errors from the manifest.

### [ ] 1.5 Escalation channel (unacknowledged alarm)
If a fired alarm is still pending N minutes past the deadline
(default 10, per-user setting), send a fallback message. v1: a generic webhook
URL (`users.escalation_webhook_url` column; POST JSON there — works for
Telegram bots, Slack, ntfy.sh). Wire into `PushService.startEscalation`.
**Accept:** with a test webhook (e.g. local echo server), the POST fires once
per alarm at the right time and never after dismiss.

---

## Phase 2 — Real Fitbit Air data via Google Health API
**Gate: do NOT start until the user confirms Google Health API developer
access is granted.** Everything below goes behind the existing
`SleepDataProvider` seam; mock stays the default (`PROVIDER=mock`).
Read `docs/INTEGRATIONS.md` §1 first.

### [ ] 2.1 OAuth 2.0 connect flow
`GET /api/v1/auth/google/start` (redirect with sleep+heart-rate scopes) and
`GET /api/v1/auth/google/callback` (code→tokens, store in `oauth_tokens`,
refresh handling in a small `server/src/providers/googleHealth/auth.ts`).
Connect page: "Connect Fitbit Air" button when `PROVIDER=google_health` and no
token; show connected account + disconnect (delete tokens) after.
**Accept:** full round-trip against the real consent screen; tokens refresh
when expired (unit-test the refresh logic with a mocked fetch).

### [ ] 2.2 Implement `GoogleHealthProvider`
Fill in `getSessions` + `getLatestSamples` in
`server/src/providers/googleHealth/index.ts` (mapping notes are in the stub).
Normalize stage names to `awake|light|deep|rem`, timestamps to ISO UTC; keep
provider session ids in `raw_ref`. Respect the ~15 min data lag; never poll
faster than 60 s (the scheduler already ticks at 30 s but provider calls may
cache for 60 s internally).
**Accept:** a recorded-fixture test (JSON fixtures of real API responses,
committed under `server/src/providers/googleHealth/__fixtures__/`) proving the
mapping; a real night's data visible on the Dashboard.

### [ ] 2.3 Webhook subscription + ingestion persistence
Implement `subscribe()` (register the endpoint per INTEGRATIONS §1). On each
webhook: fetch new data, persist via `db.saveSession` / sample tables, then
tick the scheduler (receiver already does the tick — extend it to ingest
before ticking, still ACKing 204 first). Handle the endpoint verification
challenge Google sends on registration.
**Accept:** webhook arrival → new rows in `sleep_sessions`/`sleep_stages` →
`sync.received` logged → scheduler tick observed; receiver still responds <1 s.

---

## Phase 3 — Smarter waking (needs sleep history; works with mock data too)

### [ ] 3.1 Personalized wake window from feedback
Heuristic v1 (no ML): if the last 5 feedbacks average 👎 and most fires were
`deadline`, widen `windowMinutes` by 10 (max 90); if consistently 👍 with
early `light-sleep` fires, narrow by 5 (min 20). Run daily inside `replan()`;
write changes to `event_log` as `policy.autotuned` with before/after.
Per-user opt-out flag (`users.autotune_enabled`, default on).
**Accept:** unit test feeding synthetic feedback histories → expected
adjustments; never crosses bounds; opt-out respected.

### [ ] 3.2 Back-to-sleep detection
After a dismiss, keep watching provider data for `prayerTime + 30 min`: if a
new sleep onset appears (≥10 consecutive non-awake minutes starting after the
dismiss), re-fire once with reason `deadline` and body "You fell back asleep".
Implement as a post-dismiss watcher in the scheduler.
**Accept:** simulation test: mock night where sleep resumes after dismiss →
exactly one re-fire; no re-fire when the user stays awake.

### [ ] 3.3 Bedtime advisor
Estimate personal cycle length: mean light→light interval across the last 14
sessions (fall back to 90 min under 5 sessions). Endpoint
`GET /api/v1/insights/bedtime` returns 2–3 suggested bedtimes such that
`n × cycle` completes 15 min before the Fajr window opens. Dashboard card
"Sleep by HH:MM for N full cycles".
**Accept:** unit test for the cycle estimator on generated mock sessions;
suggestions land before the window start, never after.

### [ ] 3.4 Ramadan / Suhoor mode
Aladhan responses already carry the Hijri date (cached in
`prayer_timetable.source_json`). Add a `suhoor` policy UI (deadline offset =
suhoor duration before Fajr); auto-suggest enabling it when the Hijri month is
Ramadan (banner, never auto-enable).
**Accept:** with a mocked Hijri date in Ramadan, the banner appears and an
enabled suhoor policy schedules `Fajr − offset` correctly.

---

## Phase 4 — AI-agent surface

### [ ] 4.1 Wire the real MCP server
Add `@modelcontextprotocol/sdk`; expose the five tools already defined in
`server/src/mcp/index.ts` over stdio (`npm run mcp -w server`) and HTTP.
Handlers call the SAME services as REST (build a small `services.ts` that both
routes.ts and MCP share — refactor routes to use it, behavior unchanged).
`set_alarm_policy` must go through the same validation as the REST route.
**Accept:** an MCP client (e.g. Claude Code `claude mcp add`) can list tools,
read tonight's plan, and change the Fajr window; REST behavior unchanged;
tests green.

### [ ] 4.2 Data export + privacy endpoints
`GET /api/v1/export` → single JSON with user, sessions+stages, timetable,
policies, alarm events, event log (documented shape, ISO UTC everywhere).
`DELETE /api/v1/data` → wipes health data + event log (keeps user + policies),
double-confirm in UI.
**Accept:** export round-trips through `JSON.parse`; delete leaves the app
functional (dashboard empty but working).

---

## Deferred / non-goals (don't build unless asked)
Native companion app, multi-user accounts + auth, Postgres migration, audio
adhan playback, iOS push parity (platform limitation — Bedside Mode is the iOS
answer), any ML beyond the 3.1 heuristic.
