# Fitbit Air Tracker — Prayer-Aware Smart Wake

An **iPhone app** (plus a web client) that connects to the **Google Fitbit Air**
tracker, follows the wearer's sleep as closely as the platform allows, and wakes
them for prayer **at the moment they can wake most easily** — during light sleep,
inside a configurable window before the prayer time (primarily Fajr) — with
system alarms that **ring until you stop them** (iOS 26 AlarmKit), custom wake
times, and a backup chain of alarms. Prayer times are fetched daily from the
free [Aladhan API](https://aladhan.com/prayer-times-api) based on the user's
location. All ingested health data is stored in a normalized, documented form so
AI agents can consume it later (REST API + MCP server).

## How the smart wake works

```
        wake window (e.g. 45 min)          hard deadline
  ─────┃━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┃─────────┃──────▶ time
       ┃  poll freshest sleep data        ┃         ┃
       ┃  fire alarm at light sleep ⏰    ┃  Fajr − offset   Fajr
```

The Fitbit Air syncs to the cloud roughly every 15 minutes — there is **no true
real-time stream**. So the engine opens a *wake window* before the prayer, polls
the freshest synced sleep/heart-rate data (webhook notifications + polling), and
fires the alarm as soon as the user is in light sleep. If no fresh data arrives,
the alarm **always** fires at the hard deadline — a missed sync can never mean a
missed prayer.

## Repository layout

```
CLAUDE.md              Working guide for AI assistants: invariants, gotchas, verify steps
docs/SPEC.md           Product spec: features, user flows, alarm policies
docs/ARCHITECTURE.md   System design, data model, sequence diagrams
docs/INTEGRATIONS.md   Google Health API, Aladhan, Web Push — auth, limits, deadlines
docs/ROADMAP.md        Ordered next tasks with acceptance criteria — start here to contribute
docs/MOBILE.md         iPhone app: install with a free Apple ID, alarm tiers, files
packages/core/         Shared engine: wake decision, scheduler, alarm planner, mock Fitbit Air, Aladhan client
mobile/                Expo (React Native) iPhone app — standalone, AlarmKit alarms, Bedside smart wake
server/                Fastify + TypeScript backend (REST, DB, MCP stub) — optional; for web + AI agents
web/                   React + Vite PWA (dashboard, settings, bedside mode alarm)
```

## Quickstart

```bash
npm install          # installs all workspaces
npm test             # engine unit tests, incl. accelerated full-night simulations
npm run build        # builds core + server + web, type-checks the iPhone app

# iPhone (needs a Mac with Xcode 26 — see docs/MOBILE.md)
npm run build -w packages/core && cd mobile && npx expo prebuild --platform ios && npx expo run:ios --device

# Web client + server (optional)
npm run dev          # server http://localhost:3001 + web http://localhost:5173
```

The app runs out of the box in **mock mode**: a simulated Fitbit Air generates a
realistic sleep-stage stream (with configurable sync lag and time acceleration),
and prayer times come live from Aladhan. No Google credentials required until
you're ready to connect a real device (see `docs/INTEGRATIONS.md`).

## Status / roadmap

- [x] Phase 0 — Spec + scaffold
- [x] Phase M1 — Standalone iPhone app: AlarmKit alarms, custom wake times, Bedside smart wake, backup chain (mock sleep data)
- [ ] Phase 1 — Harden alarms & complete the MVP UX
- [ ] Phase 2 — Google Health API OAuth + real sleep ingestion
- [ ] Phase 3 — Smarter waking: autotuning, back-to-sleep, bedtime advisor, Ramadan mode
- [ ] Phase 4 — AI-agent surface: MCP server + data export

Task-level breakdown with acceptance criteria: [docs/ROADMAP.md](docs/ROADMAP.md).

## Key platform constraints (why the design looks like this)

1. The legacy **Fitbit Web API shuts down September 2026** — everything targets
   its replacement, the **Google Health API**.
2. Sleep data is **near-real-time at best** (~15 min sync cadence) — hence the
   wake-window design instead of stage streaming.
3. Google Health API access requires **developer registration/approval** — hence
   the `SleepDataProvider` interface with a first-class mock implementation.
4. A website **cannot ring a native alarm on a locked phone** — hence tiered
   delivery: Web Push with escalating repeats, plus a Bedside Mode page with
   guaranteed full-volume audio. A thin native companion app remains a
   documented future option.
