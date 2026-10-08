# External Integrations

## 1. Google Health API (Fitbit Air data) — Phase 2

The **Fitbit Air** (2026) is a screenless tracker that pairs with the **Google
Health** app. Developer access to its data goes through the **Google Health
API** — the modernized replacement for the Fitbit Web API.

**Hard deadline:** the legacy Fitbit Web API is **turned down in September
2026** and stops syncing data. Do not build anything against
`api.fitbit.com/1.2/*` — target the Google Health API from day one.

Key facts that shape our design:

| Fact | Consequence in this app |
|------|-------------------------|
| Device→cloud sync is periodic: automatic throughout the day, ~15 min cadence when the phone app runs in background with Bluetooth | No stage streaming. Wake engine works on a window + freshest-data model with a hard-deadline fallback |
| Webhook subscriptions notify "data changed" only — you must fetch afterwards; endpoint must respond < 5 s | Webhook receiver just enqueues + 200s immediately; fetch happens async and triggers an engine tick |
| Personal use needs **no approval**: enable the API in your own Cloud project, consent screen in Testing mode, add yourself as a test user (Restricted-scope review only applies to publishing) | Implemented end-to-end; see `docs/GOOGLE_HEALTH_API.md` for the 10-minute setup |
| OAuth 2.0 user consent, sleep/heart-rate scopes | Standard auth-code flow in `server/src/api/` (Phase 2); tokens in `oauth_tokens` with refresh |
| Google Health also feeds Health Connect (Android) / HealthKit (iOS) | On-device access is a *native-app* option, not available to a website; kept as the documented future companion-app path |

**Setup (code is complete — only credentials are needed):** follow
`docs/GOOGLE_HEALTH_API.md` §1–2. Summary: Cloud project → enable Google Health
API → consent screen (Testing, your Gmail as test user) → iOS client for the
phone, Web client for the server → paste IDs → sign in. Webhooks
(`projects/{p}/subscribers`) are optional and not needed for personal use.

References: https://developers.google.com/health · release notes:
https://developers.google.com/health/release-notes · data types:
https://developers.google.com/health/data-types

## 2. Aladhan Prayer Times API — live now

Free, keyless REST API: https://aladhan.com/prayer-times-api

We use `GET https://api.aladhan.com/v1/timings/{DD-MM-YYYY}`:

| Param | Use |
|-------|-----|
| `latitude`, `longitude` | from user settings (geolocation or manual) |
| `method` | calculation method id (e.g. 3 = MWL, 4 = Umm al-Qura, 5 = Egyptian GAS, 2 = ISNA) — user setting |
| `school` | 0 = Shafi, 1 = Hanafi (affects Asr) — user setting |

Response includes all daily timings (`Fajr`, `Sunrise`, `Dhuhr`, `Asr`,
`Maghrib`, `Isha`, plus `Midnight`, `Lastthird` — the last two power
Qiyam mode) and the **Hijri date** (powers Ramadan mode).

Policy: fetch once per (user location, date, method) shortly after local
midnight; cache in `prayer_timetable`; re-fetch on settings change. Timings are
returned as local wall-clock times with the timezone — we store the resolved UTC
instant plus the local date. No auth, generous rate limits; still cache and
back off on 5xx (retry with exponential backoff, fall back to yesterday's cached
offsets + 1 day as a degraded estimate, and flag the dashboard).

## 3. Web Push (alarm delivery) — live now

Standard Web Push with **VAPID** (`web-push` npm package). No Firebase.

- Generate keys once: `npm run vapid -w server` → paste into `server/.env`.
- The PWA service worker subscribes (`PushManager.subscribe`) and POSTs the
  subscription to `/api/v1/push/subscribe`.
- Alarm firing sends a push with `urgency: high`, `renotify: true`,
  vibration pattern, and repeats every 60 s until `/api/v1/alarms/ack`.

**Platform reality:**
- Android (Chrome/Edge/Samsung): reliable, works with screen locked. This is the
  supported alarm platform.
- iOS Safari: push only for home-screen-installed PWAs, no custom sounds,
  delivery is best-effort → Bedside Mode is the recommended tier on iOS.
- Desktop: fine while the browser runs.

Bedside Mode is the network-independent guarantee on every platform: local
deadline countdown + Web Audio + screen wake-lock, armed the moment the page
opens.
