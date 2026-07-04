# Product Specification — Prayer-Aware Smart Wake

## 1. Vision

Wake the user for prayer at the physiologically easiest moment. Classic alarm
clocks fire at a fixed time regardless of sleep stage; being pulled out of deep
sleep makes waking for Fajr genuinely hard. This app combines:

- **Sleep telemetry** from the Google Fitbit Air (sleep stages, heart rate, HRV, SpO₂)
- **Prayer times** computed daily for the user's location (Aladhan API)
- **A smart wake engine** that fires the alarm during light sleep inside a
  window before the prayer — never later than a hard deadline

and stores every data point in an AI-agent-ready form for future automation.

## 2. Personas & primary flow

**Primary persona:** a Muslim who wears a Fitbit Air to bed and wants to wake
reliably and gently for Fajr (and optionally Qiyam/Suhoor).

**Happy path (nightly):**
1. Evening: app fetches tomorrow's prayer times for the user's location; the
   dashboard shows *tonight's plan* — suggested bedtime, wake window, Fajr time.
2. User opens **Bedside Mode** (or relies on push notifications) and sleeps.
3. During the wake window the engine evaluates the freshest synced data on every
   webhook/poll tick. Light sleep detected → alarm fires early. No usable data →
   alarm fires at the hard deadline.
4. User dismisses via a **confirm-awake** interaction. The outcome (fired-at
   stage, snoozes, time-to-dismiss) is logged for the personalization loop.

## 3. Features

### 3.1 MVP

| # | Feature | Notes |
|---|---------|-------|
| F1 | Device connection | Google OAuth → Google Health API; token refresh; connection status; **mock mode** works with zero setup |
| F2 | Sleep ingestion | Webhook subscription + polling fallback; normalized sessions/stages/HR/HRV/SpO₂; UTC timestamps + tz offset |
| F3 | Prayer timetable | Aladhan by lat/lng; calculation method + madhab settings; daily fetch at ~00:30 local + on-demand; cached per (location, date, method) |
| F4 | Smart wake engine | Per-prayer **alarm policy**: enabled, window minutes, latest-wake offset before prayer time. Decision loop described in §4 |
| F5 | Alarm delivery | Tier 1: Web Push (sound/vibrate, escalating repeats until acknowledged). Tier 2: Bedside Mode page — full-screen clock, guaranteed Web-Audio alarm, works offline. Snooze (configurable) + confirm-awake dismiss |
| F6 | Dashboard | Tonight's plan; last night's hypnogram + stats; 7/30-day history; prayer timetable |
| F7 | Settings | Location (geolocation or manual), calculation method, per-prayer policies, snooze length, escalation preferences |

### 3.2 Post-MVP (value-add, in priority order)

1. **Bedtime advisor** — suggest bedtime so an integer number of personal sleep
   cycles (~90 min default, learned from history) completes just before the wake
   window opens.
2. **Qiyam/Tahajjud mode** — wake during the last third of the night
   (Maghrib→Fajr interval / 3, final segment).
3. **Ramadan/Suhoor mode** — wake target = Fajr − suhoor duration (configurable,
   e.g. 40 min); auto-enabled during Ramadan (Hijri calendar aware).
4. **Back-to-sleep detection** — if post-dismiss telemetry shows sleep resumed
   before the prayer deadline, re-fire the alarm.
5. **Wake-ease feedback loop** — one-tap "was waking easy?" each morning; tunes
   window length and stage threshold per user. (This is the first AI-agent use
   case — see §5.)
6. **Nap awareness** — Fitbit Air records naps ≥ 20 min; qailulah (midday nap)
   suggestions and sleep-debt accounting.
7. **Daytime prayer reminders** — plain scheduled notifications for Dhuhr/Asr/
   Maghrib/Isha (no sleep logic).
8. **Escalation channel** — Telegram/email ping if an alarm is unacknowledged
   N minutes past the deadline.
9. **Hijri calendar** display + Ramadan awareness (Aladhan returns Hijri dates).

## 4. Alarm policy & decision rules

An **AlarmPolicy** (per prayer, per user):

```jsonc
{
  "prayer": "fajr",            // fajr | qiyam | suhoor | dhuhr | asr | maghrib | isha
  "enabled": true,
  "windowMinutes": 45,          // wake window opens at deadline − windowMinutes
  "deadlineOffsetMinutes": 20,  // hard deadline = prayerTime − offset (time to pray before adhan passes)
  "preferredStages": ["light", "awake"],
  "snoozeMinutes": 5,
  "maxSnoozes": 2
}
```

**Decision loop** (every tick inside the window — tick = webhook arrival or poll,
target ≤ 60 s cadence):

1. `deadline = prayerTime − deadlineOffsetMinutes`. If `now ≥ deadline` → **FIRE (deadline)**.
2. Fetch freshest samples. If newest sample is older than `stalenessLimit`
   (default 20 min) → keep waiting (data too old to trust), go to 1 next tick.
3. If current stage ∈ `preferredStages` → **FIRE (light-sleep)**.
4. Else if heart rate trend over the last 10 min rises above the user's sleeping
   baseline by a threshold (proxy for imminent natural wake) → **FIRE (hr-rise)**.
5. Else wait.

Invariant: **the alarm always fires by the deadline**, even with zero data.
Every decision is appended to the event log with its inputs (for audit +
agent training).

## 5. AI-agent readiness (requirement, not afterthought)

- All ingested data normalized to documented JSON shapes (see ARCHITECTURE §Data
  model): ISO-8601 UTC instants + `tzOffset`, stable IDs, explicit units.
- The frontend consumes the same `/api/v1` REST API that agents will use — full
  parity, no hidden endpoints.
- **MCP server** exposing typed tools: `get_sleep_sessions`, `get_tonight_plan`,
  `get_prayer_times`, `get_wake_outcomes`, `set_alarm_policy`. An agent can
  read history and *act* (adjust policies) through the same guarded services.
- **Append-only event log**: `sync.received`, `alarm.scheduled`, `alarm.fired`
  (with reason + stage), `alarm.snoozed`, `alarm.dismissed`, `wake.feedback`.
  This is the substrate for a future agent that optimizes wake timing per user.

## 6. Non-functional requirements

- **Reliability first:** the deadline alarm must not depend on network, third
  parties, or fresh data. Bedside Mode alarms are scheduled client-side and work
  offline once the page is open.
- **Privacy:** health data stays in the user's own deployment; export + delete
  endpoints; no third-party analytics.
- **Latency budget:** window ticks ≤ 60 s apart; push delivery assumed ≤ 30 s;
  therefore `deadlineOffsetMinutes` defaults keep ≥ 2 min slack.
- **Timezones:** all storage UTC; all scheduling in the user's IANA timezone
  (DST-safe); prayer times are inherently local.

## 7. Explicit non-goals (for now)

Native mobile apps, multi-user households, audio adhan streaming, iOS-grade
push reliability guarantees (documented limitation), medical use of any kind.
