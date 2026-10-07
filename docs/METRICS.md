# Metric engine (`packages/core/src/metrics/`)

Pure, platform-neutral metrics computed from the shared `NightData` contract
(`packages/core/src/health/types.ts`). We don't know yet which Fitbit Air data
will reliably arrive, so **every metric has several methods**; each method
declares the `NightData` fields it needs, methods whose inputs are missing are
skipped, and the engine picks `best` per metric by **confidence first, then
method priority** (the order in the tables below). A method that ran but could
not produce a value returns `value: null` (e.g. moodLink before 7 mood
nights); `best` prefers non-null results.

All outputs are **wellness signals, not diagnoses**. Anything that flags a
breathing / SpO2 / temperature value says so in its explanation.

## Public API

```ts
computeNightMetrics(night: NightData, history: NightData[], opts?: {
  sleepNeedMin?: number;   // default 480
  nowUtc?: string;         // marks an in-progress night; hides fajrWakeEase until the window ends
  fajrUtc?: string;        // enables fajrWakeEase
  baselineNights?: number; // default 30
}): MetricsReport          // history = previous nights, oldest first / newest last

computeBaselines(history: NightData[], opts?: { nights?: number }): Baselines   // medians, last N (30)

estimateStages(night: NightData):
  { method: 'hr-motion-v1' | 'hr-only-v1' | 'motion-only-v1'; confidence; segments } | null

summarizeStages(segments, windowStartUtc?): StageSummary | null   // totals, WASO, awakenings, latency
METRIC_IDS, DEFAULT_SLEEP_NEED_MIN, DEFAULT_BASELINE_NIGHTS
```

Purity: no clock reads, no IO, no randomness; the same input gives a
byte-identical report (tested). "Now" only comes from `opts.nowUtc`.

## Shared per-night sources

Each night is reduced to features through a fixed source chain, so every
metric sees the same numbers:

| Feature | Source chain (first available wins) |
|---|---|
| Minutes asleep | Google stages (high) → session span × `efficiencyPct` (medium) → own staging (its confidence) → raw session span (low) |
| Bed / wake time | Google stages onset/final wake → session bounds → own staging |
| Resting HR | `restingHrBpm` → `dailyHrv.nonRemHrBpm` → lowest 30-min rolling mean of `heartRate` |
| HRV (rMSSD) | `dailyHrv.rmssdMs` → median of `hrv[].rmssdMs` (SDNN is ignored) |
| Breathing rate | `respiratory.fullSleepBrpm` → mean of light/deep/REM rates |
| SpO2 average | `dailySpo2.avgPct` → mean of `spo2` samples |

Google stages are ignored while `stagesProcessed === false` (night still
processing); the night is then marked in-progress and sleep metrics say "so far".

## Own staging (`estimateStages`)

Used when Google stages are missing (and reported alongside them for comparison).
Window = session bounds if present, else the span of HR/steps/still/phone data
(1 h – 18 h).

| Method | Inputs | Confidence | How | Basis |
|---|---|---|---|---|
| `hr-motion-v1` | heartRate (≥60 % minute coverage) + steps / stillPeriods / phoneMotion | medium | Motion → sleep/wake via Cole–Kripke weights + Webster rescoring; inside sleep, HR rules: deep = 5-min HR ≤ night P25 and 10-min HR SD ≤ median; REM = HR ≥ P55, SD ≥ P60 and ≥ 60 min after onset; else light. Runs < 3 min absorbed. | Cole et al. 1992 (*Sleep* 15:461); Webster et al. 1982; autonomic HR patterns by stage (Somers 1993; HR-based staging lit., e.g. Walch 2019) |
| `hr-only-v1` | heartRate | low | Same HR rules; wake = HR ≥ median + max(10 bpm, 2.5 × robust SD). | as above |
| `motion-only-v1` | steps and/or stillPeriods (or phoneMotion) | low | Actigraphy sleep/wake only; every sleep minute labelled `light`. | Cole–Kripke / Sadeh-style actigraphy, adapted |

Activity proxy per minute = 25 × steps + 40 if not inside a still period (+ phone
counts), capped at 400 — scaled so ≥3 steps in a minute, or ~4 consecutive
non-still minutes, score as wake.

**Limits (be honest in UI):** the API has **no raw accelerometer**; steps and
"still" periods are far coarser than the activity counts these algorithms were
validated on. Lying awake without moving looks like sleep (actigraphy's known
over-estimation of sleep). HR-only 4-stage agreement in the literature is
roughly 50–65 % epoch-by-epoch; ours is uncalibrated against PSG — treat deep/REM
minutes as rough. Without a session, the in-bed time is unknown, so latency is
not scored. If the band reports the whole night as one still period, motion-only
can't see awakenings at all. Validated only on synthetic nights so far.

## Metrics

| Metric (unit) | Methods (priority order) | Inputs | Confidence rules | Basis / notes |
|---|---|---|---|---|
| `sleepDuration` (min) | `stages-v1` | session (processed stages) | high (medium if in progress) | Σ non-awake stage minutes |
| | `session-bounds-v1` | session | medium with `efficiencyPct`, else low | span × efficiency; without efficiency it overcounts |
| | `own-staging-v1` | heartRate / steps / stillPeriods (+session window) | staging confidence | see Own staging |
| `sleepScore` (0–100) | `stages-v1` | session | high | Weighted: duration vs need 40 %, deep share 15 % (100 at ≥15 %), REM share 15 % (100 at ≥20 %), continuity 20 % (WASO 10→90 min, awakenings ≥3 min beyond 2), latency 10 % (100 ≤15 min, 0 ≥60). Heuristic modelled on Fitbit/Oura score structure + AASM/NSF norms. `components` = sub-scores. |
| | `own-staging-v1` | own-staging inputs | medium for hr-motion, else low | same formula; deep/REM (and latency without a session) dropped and weights renormalised |
| | `duration-only-v1` | any duration source | low | 100 at ≥ need, 0 at need − 4 h, small penalty beyond need + 2.5 h |
| `recovery` (0–100) | `hrv-rhr-v1` | HRV + RHR (+ sleepScore, skinTempDeltaC) | min of HRV/RHR part confidence: baseline ≥14 nights high, ≥3 medium, else low (absolute population ranges) | HRV 50 %, RHR 30 %, sleep 20 %. Part score = 50 + 20·z, z = (ln rMSSD − ln baseline)/robust SD (floor 0.08) and (baseline RHR − RHR)/robust SD (floor 1.5 bpm). Plews et al. 2013; Kiviniemi 2007; Buchheit 2014. |
| | `rhr-v1` | RHR (+ sleep) | as above, capped at medium | RHR 70 %, sleep 30 % |
| | `hrv-v1` | HRV (+ sleep) | as above, capped at medium | HRV 70 %, sleep 30 % |
| | `sleep-only-v1` | best sleepScore | low | sleep score only |
| | (all) skin-temp penalty | skinTempDeltaC | — | −0…25 pts for +0.3…+1.2 °C. Explanation ends `Recommendation: train hard` (≥67) / `train light` (34–66) / `rest` (<34 or temp ≥ +1.0 °C). `components.recommendation` = 2/1/0. |
| `sleepDebt` (min) | `rolling-7-v1` | per-night duration chain | high: 7 nights & ≥70 % from stages; medium ≥5 nights; else low | max(0, Σ(need − slept)) over nights in the last 7 dates (surplus nights repay). Need = `sleepNeedMin` ?? 480. Not extrapolated for missing nights. Van Dongen et al. 2003 (cumulative restriction). |
| `consistency` (0–100) | `timing-sd-v1` | bed/wake times, last 14 dates (≥3 nights) | high ≥12 nights, medium ≥7, low ≥3 | mean of SD(bedtime), SD(wake time); 100 at ≤15 min, 0 at ≥120 min |
| | `sri-v1` | sleep intervals on consecutive dates (≥3 day pairs) | medium ≥7 pairs, else low | Sleep Regularity Index (Phillips et al. 2017) on an 18:00→14:00 local window, clamped 0–100 |
| `breathing` (brpm / %) | `respiratory-v1` | respiratory | high ≥14 baseline nights, medium ≥7, else low | Unusual if \|Δ\| ≥ max(2 brpm, 3 robust SD) vs baseline (no baseline: outside 10–22). Value = brpm. |
| | `spo2-v1` | dailySpo2 and/or spo2 | medium with samples (time-below-90 computed), else low | Unusual if avg < 92 %, ≥10 min below 90 %, or ≥2 pts under baseline. Wrist SpO2 is noisy; never diagnostic (no apnea claims). |
| `skinTemp` (°C) | `nightly-delta-v1` | skinTempDeltaC | medium | Google's delta vs personal baseline: <±0.5 normal; ≥+0.5 warmer (cold, alcohol, late meal, warm room, cycle); ≥+1.0 notably warmer |
| | `trend-3-v1` | skinTempDeltaC over last 3 dates (≥2) | low | mean delta; "sustained" when every night ≥ +0.5 °C |
| `moodLink` (r, −1…1) | `pearson-v1` | mood + duration / sleepScore / recovery | null below 7 mood nights; low 7–13; medium ≥14 | Pearson r of the night's mood score vs sleepDuration, recovery (recomputed per night from its own prior baseline) and sleepScore; reports the strongest \|r\| with n. `components`: `r_*`, `n_*`, `strongest` (0 duration, 1 recovery, 2 sleepScore). Correlation, not cause — explanation says so. |
| `fajrWakeEase` (0–100) | `stages-v1` | session + `opts.fajrUtc` | high (medium in progress) | Stage minutes in [Fajr − 30, Fajr + 15]; ease = mean of awake 100 / light 85 / REM 55 / deep 10. Needs ≥50 % of the window known; minutes after final wake count as awake. Sleep inertia is worst from N3 (Tassi & Muzet 2000). |
| | `own-staging-v1` | own-staging inputs + fajrUtc | staging confidence (one step lower for motion-only) | motion-only can't tell light from deep — says so |

Skipped entirely (no entry in `all`) when inputs are missing; `fajrWakeEase`
is also skipped when `opts.nowUtc` is before Fajr + 15 min.

## Baselines

`computeBaselines` / `MetricsReport.baselines`: medians over the last
`nights` (default 30) history nights — resting HR, rMSSD, breathing rate,
SpO2, minutes asleep, bedtime (minutes from local midnight, negative = before
midnight) and wake time. The engine also keeps robust SDs (1.4826 × MAD)
internally for z-scores. A per-field baseline needs ≥3 contributing nights
before relative scoring kicks in. Sources can mix across nights (e.g. a night
with `restingHrBpm` vs one using lowest sleeping HR), which can bias a
baseline by a few bpm — another reason to keep the source chain stable.

## Tests

`metrics.test.ts` (data tiers: everything / stages only / HR only / steps+still
only / HR+steps no stages / nothing / single night no history / 30-night
history; method sets, best selection, ranges, no NaN, non-empty one-line
explanations, determinism, behaviour of each metric) and `staging.test.ts`
(own staging vs synthetic ground truth, Cole–Kripke/Webster). Fixtures:
`__fixtures__/nights.ts` (seeded synthetic nights driven by a true hypnogram).
