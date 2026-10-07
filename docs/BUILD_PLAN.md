# Build plan — full personal app (Oct 2026)

Goal (user's words): the full app — metrics from all the data (several methods,
because we don't yet know which Fitbit Air data arrives in time), an on-device
calorie/protein checker, prayer-time alarms that set themselves, and dashboards
that are easy to understand. User focus: sleep, mood, breathing, gym recovery,
and above all waking for Fajr.

Decisions already made by the user (do not re-ask):
- Prayer calc: **Umm al-Qura** (Aladhan method 4). Location from GPS.
- Fajr: latest wake **15 min after adhan**, smart window from 30 min before
  (`windowMinutes: 45, deadlineOffsetMinutes: -15`; deadline = prayer − offset).
- Calorie AI: **on-phone only**. Photos never leave the device. No cloud fallback.
- Data path: **Google Health API** (no live BLE heart-rate for now). There is
  **no raw accelerometer** in the API; motion = per-minute `steps`,
  `sedentary-period` intervals, and `heartRate.metadata.motionContext`.
- Phone: iPhone 17 Pro, iOS 26, Xcode 26 on the Mac. Free Apple ID (no App
  Groups, no push, increased-memory-limit entitlement probably unavailable).

## Shared contract (already committed — build against it, don't fork it)
`packages/core/src/health/types.ts`: `NightData` (every field optional),
`MetricResult`, `MetricsReport`, `Baselines`, `MoodEntry`. If you truly need a
change, make it additive (new optional field) and say so in your report.

## Workstreams and file ownership
Each agent touches ONLY its files. The lead integrates (tab layout, barrel
exports conflicts, package-lock) after review.

| WS | Owner files | Deliverable |
|----|-------------|-------------|
| A metrics | `packages/core/src/metrics/**` | Pure metric engine: several methods per metric, choose best, baselines. Tests. |
| B data + wake | `packages/core/src/providers/**`, `packages/core/src/wake/**`, `mobile/src/services/health.ts`, `mobile/src/healthStore.ts` | Google fetchers for all Air data types → `NightData`; mock `NightData` generator; predictive light-sleep wake for ~15-min-late data; phone-side daily sync + persistence. |
| C food | `packages/core/src/nutrition/**`, `mobile/src/services/food/**`, `mobile/src/foodStore.ts`, `mobile/app/food/**`, `mobile/app/(tabs)/food.tsx`, `mobile/assets/nutrition/**` | Photo → on-device VLM identifies foods → user confirms portion → macros from bundled USDA subset. Daily totals vs protein target. |
| D dashboards | `mobile/app/(tabs)/index.tsx`, `mobile/app/(tabs)/trends.tsx`, `mobile/app/mood/**`, `mobile/src/components/charts/**`, `mobile/src/moodStore.ts` | Today (Fajr plan + sleep + recovery + breathing + mood), Trends (7/30 days), one-tap mood check-in. Built against `MetricsReport` fixtures until A lands. |

## Hard rules (from CLAUDE.md — breaking these fails review)
- Core stays pure/platform-neutral; `.js` suffix on relative imports; no
  `new Date()`/`Date.now()` in engine logic (take `now`/`Clock` as input).
- The AlarmKit deadline alarm must keep working; `replan()` stays idempotent.
- Never poll Google faster than 60 s.
- `npm run build && npm test` green; mobile `npx tsc --noEmit` and
  `npx expo export --platform ios` green.
- Medical honesty: breathing/SpO2/HRV outputs are wellness signals, never
  diagnoses; wording must say so where it flags anything.
