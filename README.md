# Fitbit Air Tracker — Prayer-Aware Smart Wake

A web app that connects to the **Google Fitbit Air** tracker, follows the wearer's
sleep as closely as the platform allows, and wakes them for prayer **at the moment
they can wake most easily** — during light sleep, inside a configurable window
before the prayer time (primarily Fajr). Prayer times are fetched daily from the
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
docs/SPEC.md           Product spec: features, user flows, alarm policies
docs/ARCHITECTURE.md   System design, data model, sequence diagrams
docs/INTEGRATIONS.md   Google Health API, Aladhan, Web Push — auth, limits, deadlines
server/                Fastify + TypeScript backend (wake engine, providers, REST, MCP stub)
web/                   React + Vite PWA (dashboard, settings, bedside mode alarm)
```

## Quickstart

```bash
npm install          # installs both workspaces
npm run dev          # starts server (http://localhost:3001) + web (http://localhost:5173)
npm test             # unit tests, incl. accelerated wake-engine simulation
npm run build        # typecheck + production builds for both workspaces
```

The app runs out of the box in **mock mode**: a simulated Fitbit Air generates a
realistic sleep-stage stream (with configurable sync lag and time acceleration),
and prayer times come live from Aladhan. No Google credentials required until
you're ready to connect a real device (see `docs/INTEGRATIONS.md`).

## Status / roadmap

- [x] Phase 0 — Spec + scaffold (this)
- [ ] Phase 1 — Prayer timetable + reliable PWA alarms (push + bedside mode)
- [ ] Phase 2 — Google Health API OAuth + real sleep ingestion
- [ ] Phase 3 — Smart wake engine hardened with real-device data
- [ ] Phase 4 — Insights, bedtime advisor, Qiyam/Ramadan modes, MCP server for AI agents

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
