# CLAUDE.md — Working guide for AI assistants

Read this fully before changing code. It encodes decisions and gotchas that are
NOT obvious from the code alone. When in doubt, `docs/SPEC.md` (product),
`docs/ARCHITECTURE.md` (design), and `docs/INTEGRATIONS.md` (external APIs) are
the source of truth; `docs/ROADMAP.md` tells you exactly what to build next.

## What this app is

Wakes a Muslim user for prayer (primarily Fajr) at the easiest physiological
moment: during **light sleep**, inside a window before the prayer time, using
Google Fitbit Air sleep data + daily Aladhan prayer times. TypeScript monorepo:
`server/` (Fastify API + wake engine) and `web/` (React PWA).

## Commands

```bash
npm install        # root — installs both workspaces (npm workspaces)
npm run dev        # starts server :3001 + web :5173 (vite proxies /api → 3001)
npm test           # server unit tests (vitest) — MUST pass before commit
npm run build      # tsc for both + vite build — MUST pass before commit
npm run vapid -w server   # generate Web Push VAPID keys for server/.env
```

Requires **Node >= 22.5** (uses built-in `node:sqlite`; the
"SQLite is an experimental feature" warning at startup is expected — ignore it).

## Hard invariants — never break these

1. **The alarm always fires by the hard deadline**, even with zero sleep data,
   no network, or a dead provider. Every code path in `server/src/wake/` must
   preserve this. `decide()` checks the deadline FIRST for this reason.
2. **Nothing outside `server/src/providers/` may import a concrete provider.**
   All sleep data flows through the `SleepDataProvider` interface
   (`server/src/providers/types.ts`). This keeps the app runnable without
   Google API access (mock mode) — the default and CI mode.
3. **All stored timestamps are ISO-8601 UTC** (`...Z`). Local wall time is
   derived at the edge via the user's IANA `tz`. Prayer times are stored as
   resolved UTC instants (`prayer_timetable.time_utc`).
4. **All SQL lives in `server/src/db/index.ts`** (the DAL). Business logic
   never touches SQLite directly. Schema is `server/src/db/schema.sql`
   (CREATE TABLE IF NOT EXISTS style — additive migrations only for now).
5. **`decide()` in `server/src/wake/decide.ts` stays a pure function** — no IO,
   no clocks, no randomness. The injectable `Clock` (`server/src/types.ts`) is
   how the scheduler and mock provider see time; tests use a fake clock to
   simulate whole nights in milliseconds. Never call `new Date()` /
   `Date.now()` inside engine or provider logic — use the injected clock.
6. **The Google Health webhook receiver must ACK in < 5 s** (platform rule).
   It responds 204 immediately and does work via `setImmediate` — keep it that way.
7. **REST API = agent API.** The frontend uses the same `/api/v1` endpoints a
   future AI agent will use (MCP tool definitions in `server/src/mcp/index.ts`
   map onto the same services). Don't add frontend-only backdoors.

## Platform facts (researched, do not re-litigate)

- Fitbit Air syncs device→cloud **~every 15 min**; there is NO real-time sleep
  stream. Hence the wake-window design (poll freshest data, hard-deadline
  fallback). Don't attempt streaming; don't poll providers faster than 60 s.
- The legacy Fitbit Web API (`api.fitbit.com`) **shuts down Sept 2026**. Only
  target the **Google Health API** (Phase 2, see docs/INTEGRATIONS.md §1).
- Aladhan API is called with **`iso8601=true`** so timings arrive with UTC
  offsets — never do manual timezone math on prayer times.
- Web pages can't ring native alarms on locked phones. Delivery is tiered:
  Web Push (escalating repeats) + Bedside Mode (client-side deadline countdown
  + Web Audio, works offline). Both must keep working after any change.

## Code conventions

- Server is **ESM with NodeNext resolution**: relative imports MUST end in
  `.js` (e.g. `import { decide } from './decide.js'` — yes, `.js` even though
  the file is `.ts`). Forgetting this breaks the build.
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
server/src/
  index.ts          bootstrap: config → db → provider → scheduler → cron → fastify
  types.ts          shared domain types + Clock
  config.ts, env.ts env/config loading (.env is optional)
  db/               schema.sql + Db class (ALL SQL lives here)
  providers/        types.ts (the seam) · mock/ (simulator) · googleHealth/ (Phase-2 stub)
  prayer/           aladhan.ts (HTTP client) · timetable.ts (cache + nextOccurrence)
  wake/             decide.ts (PURE decision rule) · scheduler.ts (windows + ticks)
                    decide.test.ts · simulation.test.ts (accelerated full nights)
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
2. Engine changes: the two tests in `server/src/wake/simulation.test.ts` are
   the safety net — they simulate full nights (light-sleep fire AND
   deadline-fallback). Extend them when you change engine behavior.
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
