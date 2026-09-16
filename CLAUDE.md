# CLAUDE.md — Working guide for AI assistants

Read this fully before changing code. It encodes decisions and gotchas that are
NOT obvious from the code alone. When in doubt, `docs/SPEC.md` (product),
`docs/ARCHITECTURE.md` (design), and `docs/INTEGRATIONS.md` (external APIs) are
the source of truth; `docs/ROADMAP.md` tells you exactly what to build next.

## What this app is

Wakes a Muslim user for prayer (primarily Fajr) at the easiest physiological
moment: during **light sleep**, inside a window before the prayer time, using
Google Fitbit Air sleep data + daily Aladhan prayer times — with alarms that
ring until stopped, custom wake times, and a backup chain. TypeScript monorepo:

- `packages/core/` — **the engine** (pure TS, no platform APIs): decision rule,
  scheduler, alarm planner, mock Fitbit Air, Aladhan client, tz helpers. Tests live here.
- `mobile/` — **the primary product**: standalone Expo/React Native iPhone app
  (iOS 26 AlarmKit). See `docs/MOBILE.md`.
- `server/` + `web/` — optional Fastify API + React PWA sharing the same engine;
  the server is also the future AI-agent (MCP) surface.

## Commands

```bash
npm install        # root — installs all workspaces (npm workspaces)
npm test           # engine tests in packages/core (vitest) — MUST pass before commit
npm run build      # core → server → web builds + mobile type-check — MUST pass before commit
npm run dev        # (web path) builds core, starts server :3001 + web :5173
npm run vapid -w server   # Web Push VAPID keys for server/.env (web client only)

# iPhone app — only on a Mac with Xcode 26 (see docs/MOBILE.md):
npm run build -w packages/core && cd mobile && npx expo prebuild --platform ios && npx expo run:ios --device
# iPhone app — what CAN be verified on Linux/CI:
cd mobile && npx tsc --noEmit && npx expo export --platform ios && npx expo prebuild --platform ios --no-install
```

Requires **Node >= 22.5** (server uses built-in `node:sqlite`; the
"SQLite is an experimental feature" warning at startup is expected — ignore it).
**Build order matters:** `packages/core` must be built (`dist/`) before the
server, web or mobile app can resolve `@fitbit-air-tracker/core`.

## Hard invariants — never break these

1. **The alarm always fires by the hard deadline**, even with zero sleep data,
   no network, or a dead provider. Every code path in `server/src/wake/` must
   preserve this. `decide()` checks the deadline FIRST for this reason.
2. **Nothing outside a provider module may import a concrete provider.**
   All sleep data flows through the `SleepDataProvider` interface
   (`packages/core/src/providers/types.ts`). This keeps every client runnable
   without Google API access (mock mode) — the default and CI mode.
3. **All stored timestamps are ISO-8601 UTC** (`...Z`). Local wall time is
   derived at the edge via the user's IANA `tz`. Prayer times are stored as
   resolved UTC instants (`prayer_timetable.time_utc`).
4. **All SQL lives in `server/src/db/index.ts`** (the DAL). Business logic
   never touches SQLite directly. Schema is `server/src/db/schema.sql`
   (CREATE TABLE IF NOT EXISTS style — additive migrations only for now).
   On the phone the equivalent is `mobile/src/store.ts` (persisted JSON with
   the same shapes/event vocabulary) — keep them aligned.
5. **`packages/core` stays platform-neutral and `decide()` stays pure.** No
   Node (`node:*`), React Native or DOM-only APIs in core (its tsconfig has
   `types: []` on purpose — the build fails if you slip). No IO, clocks or
   randomness in `decide()`. Time comes from the injectable `Clock`
   (`packages/core/src/types.ts`); tests use a fake clock to simulate whole
   nights in milliseconds. Never call `new Date()` / `Date.now()` inside engine
   or provider logic — use the injected clock. Planning is pure too
   (`alarms/plan.ts`): the phone/server just executes the plan.
6. **The Google Health webhook receiver must ACK in < 5 s** (platform rule).
   It responds 204 immediately and does work via `setImmediate` — keep it that way.
7. **REST API = agent API.** The web frontend uses the same `/api/v1` endpoints
   a future AI agent will use (MCP tool definitions in `server/src/mcp/index.ts`
   map onto the same services). Don't add frontend-only backdoors.
8. **iPhone alarm tiers must all keep working** after any mobile change:
   AlarmKit deadline alarm (rings until stopped, app closed), Bedside in-app
   alarm (sound + haptics until "I'm awake"), backup notification chain.
   `replan()` in `mobile/src/services/replan.ts` is idempotent (cancel-all then
   re-arm) — keep it that way; call it after any change to alarms/settings.

## Platform facts (researched, do not re-litigate)

- Fitbit Air syncs device→cloud **~every 15 min**; there is NO real-time sleep
  stream. Hence the wake-window design (poll freshest data, hard-deadline
  fallback). Don't attempt streaming; don't poll providers faster than 60 s.
- The legacy Fitbit Web API (`api.fitbit.com`) **shuts down Sept 2026**. Only
  target the **Google Health API** (Phase 2, see docs/INTEGRATIONS.md §1).
- Aladhan API is called with **`iso8601=true`** so timings arrive with UTC
  offsets — never do manual timezone math on prayer times.
- Web pages can't ring native alarms on locked phones. Web delivery is tiered:
  Web Push (escalating repeats) + Bedside Mode (client-side deadline countdown
  + Web Audio, works offline). Both must keep working after any change.
- **iOS 26 AlarmKit** is the only way a third-party iPhone app gets alarms that
  ring until stopped with the app closed. It needs Xcode 26, iOS 26, the
  `NSAlarmKitUsageDescription` Info.plist key, and a dev build (not Expo Go).
- **Free Apple ID (personal team):** 7-day re-sign, **no push notifications**,
  **no App Groups** → that's why `react-native-nitro-ios-alarm-kit` was chosen
  over `expo-alarm-kit` (which needs App Groups), and why the smart early wake
  runs in the foreground (Bedside mode) instead of via push.
- iOS caps pending local notifications at 64 → the backup chain (21
  notifications) is attached to the *next* alarm only (`planAlarms`).

## Code conventions

- `packages/core` and `server` are **ESM with NodeNext resolution**: relative
  imports MUST end in `.js` (e.g. `import { decide } from './decide.js'` — yes,
  `.js` even though the file is `.ts`). Forgetting this breaks the build.
  Mobile/web import the package by name: `@fitbit-air-tracker/core`.
- Mobile: Expo SDK 57 / React 19 / TypeScript 6. `useRef<T>()` needs an initial
  value (`useRef<T | undefined>(undefined)`). Metro can't resolve `.js`-suffixed
  relative imports to `.ts` — that's why core is consumed via its built `dist/`.
  `npx expo install` may fail behind proxies; pin versions from
  `mobile/node_modules/expo/bundledNativeModules.json` and use plain `npm install -w mobile`.
- Server build copies `schema.sql` into `dist/db/` (see `server/package.json`
  build script). If you add non-TS assets under `src/`, extend that copy step.
- `server/tsconfig.json` **excludes `*.test.ts`** from the build; tests run via
  vitest only. Put tests next to the code as `<name>.test.ts`.
- Web: TypeScript 5.7 typed-array generics are strict — if you pass bytes to
  DOM APIs, build them on a real `ArrayBuffer` (see `urlBase64ToUint8Array` in
  `web/src/pages/Connect.tsx` for the pattern).
- Single-user scaffold: the demo user is seeded in `Db.seedDemoUser()` and its
  id flows through `ApiContext.userId`. Multi-user auth is out of scope until
  the roadmap says otherwise.
- No heavyweight deps without need. DB = `node:sqlite`, scheduling =
  `node-cron` + `setInterval`, env = tiny loader in `server/src/env.ts`
  (no dotenv). Keep it that way unless the roadmap task says otherwise.

## Map of the code

```
packages/core/src/
  index.ts          barrel — everything below is exported from '@fitbit-air-tracker/core'
  types.ts          domain types (AlarmPolicy, WakeAlarm, SleepSample…) + Clock
  wake/decide.ts    PURE decision rule (deadline → staleness → stage → HR-rise → wait)
  wake/scheduler.ts windows + ticks; schedule(policy, prayerTime) / scheduleDeadline(policy, deadline)
  alarms/plan.ts    PURE planner: WakeAlarm[] + timings → deadlines/windows/chain for N days
  prayer/aladhan.ts HTTP client (iso8601=true) · prayer/next.ts nextOccurrence + timingKeyForPrayer
  providers/        types.ts (the seam) · mock/ (Fitbit Air simulator)
  util/tz.ts        Intl-only timezone helpers (wallTimeToUtc, localDateString…)
  **/*.test.ts      decide, simulation (full nights), plan
mobile/             see docs/MOBILE.md §5 for the file map
server/src/
  index.ts          bootstrap: config → db → provider → scheduler → cron → fastify
  types.ts          shared domain types + Clock
  config.ts, env.ts env/config loading (.env is optional)
  db/               schema.sql + Db class (ALL SQL lives here)
  providers/googleHealth/  Phase-2 stub (server-side Google Health provider)
  prayer/timetable.ts      DB-cached timetable over the core Aladhan client
  push/webpush.ts   VAPID sender + 60 s escalation until ack
  api/routes.ts     /api/v1 REST + webhook receiver + /demo/fire-test
  mcp/index.ts      MCP tool definitions (Phase-4 wiring pending)
web/src/
  api.ts            typed client for /api/v1 (mirror server changes here)
  pages/            Dashboard · Settings · Bedside (offline alarm) · Connect
web/public/sw.js    service worker: push handler + notification actions
```

## How to verify changes (do this before committing)

1. `npm run build && npm test` — both must be clean.
2. Engine changes: `packages/core/src/wake/simulation.test.ts` is the safety
   net — it simulates full nights (light-sleep fire AND deadline-fallback);
   `alarms/plan.test.ts` covers custom/prayer planning + the chain. Extend
   them when you change engine behavior.
   Mobile changes: `cd mobile && npx tsc --noEmit && npx expo export --platform ios`
   (bundles) and `npx expo prebuild --platform ios --no-install` (config plugins);
   a real run needs the Mac steps in docs/MOBILE.md — say so in your report.
3. Runtime smoke test:
   ```bash
   npm run dev
   curl localhost:3001/health                        # {"ok":true}
   curl localhost:3001/api/v1/plan/tonight           # plans[] with window/deadline
   curl localhost:3001/api/v1/sleep/sessions?limit=1 # mock history
   curl -X POST localhost:3001/api/v1/demo/fire-test # then:
   curl localhost:3001/api/v1/alarms/pending         # pending alarm appears
   curl -X POST -H 'Content-Type: application/json' -d '{}' localhost:3001/api/v1/alarms/ack
   ```
4. UI: open http://localhost:5173 — Dashboard shows tonight's plan + hypnograms;
   Bedside → "Arm" → "Test alarm now" must ring audibly.
5. Note: some sandboxed dev environments **block api.aladhan.com** (egress
   policy). Then `/api/v1/prayer/timetable` 500s and `plan/tonight` is empty —
   that is environmental, not a bug. Tests don't depend on the network. You can
   seed `prayer_timetable` rows directly in SQLite to demo the full flow.

## What to build next

Open `docs/ROADMAP.md`. Tasks are ordered, self-contained, and carry acceptance
criteria — pick the first unchecked one. Do not start Phase-2 Google OAuth work
unless the user says API access has been granted.
