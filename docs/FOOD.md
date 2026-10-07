# Food — on-phone calorie + protein checker

Snap a meal → an **on-device** vision-language model lists the foods and
estimates grams → you confirm/edit portions → macros come from a **bundled
food database** → the Food tab shows today's kcal and protein vs your target.

User decisions this is built on (docs/BUILD_PLAN.md): **on-phone only, photos
never leave the device, no cloud fallback.** The manual path (search + portion)
works with no model at all.

## 1. Runtime + model decision

**Runtime: [`llama.rn`](https://github.com/mybigday/llama.rn) 0.12.9** (llama.cpp
+ `mtmd` multimodal, Metal GPU, JSI; MIT). **Model: Gemma 4 E2B-it, Q4_0 GGUF +
Q8_0 vision projector** from
[`ggml-org/gemma-4-E2B-it-GGUF`](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF)
(Apache-2.0), with **Qwen3-VL-2B-Instruct Q8_0** from
[`ggml-org/Qwen3-VL-2B-Instruct-GGUF`](https://huggingface.co/ggml-org/Qwen3-VL-2B-Instruct-GGUF)
(Apache-2.0) as a lighter alternative selectable in the app.

Why:

| Candidate | Verdict |
|---|---|
| **llama.rn** | ✅ Chosen. Runs offline on iOS from RN, takes image + prompt via OpenAI-style `messages` (`image_url` = local file), returns text; supports `response_format: json_schema` (grammar-constrained decoding) so the model *must* emit our JSON shape. Ships an Expo config plugin, prebuilt `rnllama.xcframework` (no 20-min C++ compile). **Gemma 4 vision is in its bundled llama.cpp**: I checked the published 0.12.9 tarball — `cpp/tools/mtmd/models/gemma4v.cpp` and `PROJECTOR_TYPE_GEMMA4V` are present (upstream added Gemma 4 vision in [llama.cpp PR #21309](https://github.com/ggml-org/llama.cpp/pull/21309), Apr 2026). Qwen3-VL (`PROJECTOR_TYPE_QWEN3VL`) is present too. 0.12.9 is the newest non-RC release (npm `latest` currently points at 0.13.0-rc.7; RCs avoided). |
| react-native-executorch | ❌ VLM support centres on LFM2-VL (v0.8 release notes); no Gemma 4 vision; model export pipeline is heavier. [blog](https://swmansion.com/blog/react-native-executorch-v0.8.0-a-library-milestone) |
| Cactus | ❌ for now: lists Gemma 4 vision in its v1.x core, but its React Native package is the legacy v0 binding ("RN bindings for v1 coming soon"). [docs](https://cactuscompute.com/docs/react-native) |
| MediaPipe / LiteRT-LM custom module | ❌ would need a hand-written Swift Expo module around a C++ runtime + `.litertlm` bundles; more native code to maintain on a free team with weekly re-signs. Revisit if llama.rn lags. |
| Apple Foundation Models (image input) | ❌ not primary: image input needs iOS 27; the phone is on iOS 26. |

Why llama.cpp-based wrappers need checking: wrappers that vendor an older
llama.cpp can't load newer architectures (e.g. a
[LocalLLMClient issue](https://github.com/tattn/LocalLLMClient/issues/90) where
the bundled llama.cpp stopped at gemma3n). That is why the vendored sources of
the *exact* pinned version were inspected rather than trusting release notes.

### Files, sizes, integrity (verified by HTTP HEAD + HF API only — nothing downloaded here)

| Model | File | Bytes | SHA-256 (HF LFS oid) |
|---|---|---|---|
| Gemma 4 E2B | `gemma-4-E2B-it-Q4_0.gguf` | 2,841,481,184 | `8e30dff3…ad7e6a52` |
| | `mmproj-gemma-4-E2B-it-Q8_0.gguf` | 557,368,064 | `9406f99c…30d04b292` |
| Qwen3-VL 2B | `Qwen3-VL-2B-Instruct-Q8_0.gguf` | 1,834,427,296 | `b7802e29…81813c39` |
| | `mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf` | 445,053,056 | `69066c8f…bca9e7b` |

URLs are pinned to repo commits (`b4243c15…` / `ea6a1105…`), both return
`200`, `accept-ranges: bytes` (resumable). Full hashes live in
`models.ts` and are checked after download.

**Download size:** Gemma 4 E2B = **3.40 GB**; Qwen3-VL 2B = **2.28 GB**.

### Memory (estimate — must be confirmed on the iPhone)

The free Personal Team can't use `increased-memory-limit`, so the llama.rn
Expo plugin is configured with `enableEntitlements: false` (otherwise it adds
that entitlement for production builds and signing fails).

| | Gemma 4 E2B Q4_0 | Qwen3-VL 2B Q8_0 |
|---|---|---|
| weights (mmap'd, Metal no-copy) | 2.84 GB | 1.83 GB |
| vision projector | 0.56 GB | 0.45 GB |
| KV cache (n_ctx 2048) + compute buffers (n_ubatch 512) | ~0.3–0.6 GB | ~0.3–0.5 GB |
| **peak while analysing** | **≈ 3.7–4.0 GB** | **≈ 2.6–2.8 GB** |

iPhone 17 Pro has 12 GB RAM. Apple doesn't publish the default per-app limit;
it's commonly observed around half of physical RAM on recent devices, so
Gemma 4 E2B *should* fit — **unverified**. If iOS kills the app during
analysis, switch to Qwen3-VL 2B in Food ▸ Manage model. The model is loaded
only for one analysis and `release()`d right after.

### Inference settings
`n_ctx 2048, n_batch = n_ubatch = 512` (Gemma's image tokens attend
non-causally, so the whole image must fit one ubatch; llama.cpp caps Gemma 4
images at 280 tokens), `n_gpu_layers 99`, `ctx_shift false`, `jinja: true`,
`enable_thinking: false`, `temperature 0.1`, `n_predict 384`,
`response_format: json_schema` (schema `MEAL_ANALYSIS_SCHEMA` in core). Photo
downscaled to 896 px long side (JPEG 85) in the cache dir and deleted after.

## 2. Flow

```
Food tab ─ "Add meal from photo" ─▶ food/photo   (camera / library via expo-image-picker)
                                      │ model installed?  no ─▶ "Get the model" / "Enter manually"
                                      ▼ yes
             analyzeMeal(photo) — foreground only, model loaded → analysed → released
                  prompt (strict JSON) → parseMealAnalysis → retry once with stricter prompt
                  → still unusable ⇒ AnalysisFailedError ⇒ manual fallback
                                      ▼
             draftFromAnalysis: core matchLabel() each label → FoodItem + natural unit
                  unmatched labels listed separately ("Find a match")
                                      ▼
             food/review — edit portions (stepper + units), swap food via food/search,
                  add/remove items, ±40% caveat → Save → foodStore (AsyncStorage)
"Add manually" ─▶ food/review (empty draft) ─▶ food/search ─▶ …   (no model needed)
```

## 3. Engine (`packages/core/src/nutrition`, pure + tested)

- `types.ts` — `FoodItem` (per-100 g macros, portions, density, `source`),
  `MealEntry`, `LoggedFood` (macro snapshot), `DetectedFood`.
- `match.ts` — fuzzy matcher: Arabic normalisation (أ/إ/آ→ا, ة→ه, ى→ي,
  tashkeel, "ال"), plural stemming, English synonyms (yoghurt, aubergine,
  fries…), prefix + edit-distance + vowel-insensitive consonant skeleton for
  transliterations (kabsa/kebsa/kabsah; foul/ful/fuul; shawarma/shawerma),
  priority boost for everyday foods. `searchFoods`, `matchLabel` (threshold 0.6).
- `portions.ts` — g, kg, oz, ml, cup, tbsp, tsp, piece, slice, plate, bowl,
  palm, fist, handful, thumb → grams: food's own USDA household measure first,
  then density (from its cup portion), then category heuristics (hand-portion
  rules: palm ≈ 90 g cooked protein, fist ≈ 1 cup, thumb ≈ 1 tbsp).
- `macros.ts` — `macrosFor`, `sumMacros`, `dailyTotals`, `proteinTarget`
  (g/kg × weight, default **1.6 g/kg**), `macroProgress`.
- `parse.ts` — tolerant JSON extraction (fences, prose, trailing commas,
  single quotes, "150 g", "high"/"85%", truncated output), prompt + schema.

Tests: `nutrition.test.ts` (23 unit tests) + `foods-db.test.ts` (42 tests
against the real bundled DB: size, sanity, halal filter, 25 regional and 13
everyday lookups, VLM-style labels, portions).

## 4. Food database (`mobile/assets/nutrition/foods.json`)

**1,349 foods, 556 KB** (one item per line). Built reproducibly:

```bash
node mobile/assets/nutrition/build/build-foods.mjs          # downloads + sha256-checks the USDA zips
node mobile/assets/nutrition/build/build-foods.mjs --sr <sr.json> --fndds <survey.json>
```

| Layer | Count | Source (`source.kind`) |
|---|---|---|
| Regional recipe estimates (kabsa ×3, mandi ×2, saleeg, jareesh, harees, marqooq, shawarma ×3, toum, tahini sauce, foul, mutabbaq ×2, kunafa, basbousa, luqaimat, qatayef, umm ali, ma'amoul, halawa, masoub, balaleet, shakshuka, kibbeh, fattoush, Arabic salad, mutabbal, muhammara, mujaddara, molokhia, bamya, kofta, shish tawook, shorba, karak, manakish, fatayer, samboosa ×2, maqluba, thareed, labneh) | 46 | `recipe`: typical recipe in grams of USDA ingredients ÷ cooked yield, computed by the script (`curated.mjs` holds every recipe). **Estimates**, not lab values; notes say where an ingredient is a stand-in (bulgur for jareesh wheat, phyllo for kataifi, honey for date syrup…). |
| Regional proxies (laban, dates Sukkari/Khalas/Ajwa/Sagai/rutab, tamees, qahwa) | 8 | `proxy`: closest USDA record + an explicit note (e.g. laban ≈ cultured whole buttermilk; rutab overestimates kcal). Per-date weights are typical estimates. |
| Everyday foods with friendly names + Arabic + transliterations (hummus, falafel, Arabic bread/khubz, rice, eggs, laban-adjacent dairy, chicken, lamb, fish, fruit, drinks…) | 126 | `usda`: USDA FNDDS 2021-2023 |
| Raw/dry staples (raw chicken/beef, dry rice/oats, flour, whey isolate, ghee, tahini, Medjool/Deglet Noor dates…) | 20 | `usda`: USDA SR Legacy |
| Bulk FNDDS layer (generic items first, capped per WWEIA category) | 1,149 | `usda`: USDA FNDDS 2021-2023 |

USDA FoodData Central data are U.S. Government works in the public domain
(<https://fdc.nal.usda.gov>). Datasets: SR Legacy (2018-04) and FNDDS
"Survey foods" (2024-10-31). **Halal by default:** pork, ham, bacon, lard and
alcoholic items are excluded from the bundle (a test enforces this).

## 5. Phone files

```
mobile/app/(tabs)/food.tsx            Food tab: protein vs target, kcal/carbs/fat/fiber, meals, targets, model status
mobile/app/food/photo.tsx             camera/library → analyze (stages, errors) → review
mobile/app/food/review.tsx            edit detected items, unmatched labels, ±40% caveat, save
mobile/app/food/search.tsx            DB search (English / transliteration / Arabic)
mobile/app/food/model.tsx             download / pause / resume / cancel / delete / choose model
mobile/src/foodStore.ts               zustand+AsyncStorage: meals per local date, settings, installed model, resume state
mobile/src/services/food/models.ts    model registry (URLs pinned to commits, sizes, SHA-256)
mobile/src/services/food/modelManager.ts  DownloadTask (resumable), disk-space + Wi-Fi checks, verify, backup exclusion
mobile/src/services/food/analyzeMeal.ts   downscale → llama.rn → parse → retry → release
mobile/src/services/food/draft.ts     labels → matched LoggedFood lines
mobile/src/services/food/foodDb.ts    bundled DB + search
mobile/src/services/food/ui.tsx       ProgressBar, PortionEditor, MacroLine
mobile/modules/food-file-utils/       local Expo module (Swift): streaming SHA-256 + isExcludedFromBackup
```

Storage: models in `<Documents>/models/<id>/`, directory **and** files flagged
`isExcludedFromBackup` via the local module (expo-file-system has no API for
it). Downloads use `expo-file-system` `DownloadTask`; pausing persists
`savable()` resume data so a pause survives an app restart; a file already
complete on disk is never re-downloaded; checksum mismatch deletes the file.

Config added: `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
`expo-image-picker` plugin (no microphone), `llama.rn` plugin
(`enableEntitlements: false`, `enableOpenCLAndHexagon: false`; it also forces
C++20 on Pods, as llama.rn requires). New deps (pinned to SDK 57's
`bundledNativeModules.json` where listed): `expo-file-system ~57.0.7`,
`expo-image-picker ~57.0.18`, `expo-image-manipulator ~57.0.18`,
`expo-network ~57.0.2`, `llama.rn 0.12.9` (exact).

## 6. Verified so far

- `npm run build && npm test` (102 tests, 65 of them nutrition), mobile
  `tsc --noEmit`, `expo export --platform ios`, `expo prebuild --platform ios --no-install`.
- Full dev build in the iOS 26.5 **iPhone 17 simulator** (pods incl. `llama-rn 0.12.9`
  and the local `FoodFileUtils` Swift module compile and link). Manual flow
  exercised: search (kabsa, laban) → portions/units → save → daily totals and
  protein target. Screenshots: `docs/screenshots/food-tab.png`,
  `food-search.png`, `food-review.png`, `food-model.png`.
- The food screens sit on the root stack (per-screen `Stack.Screen` options),
  so no change to `app/_layout.tsx` was needed; only the Food tab line was
  added to `app/(tabs)/_layout.tsx`.

## 7. What still needs the real iPhone

- Real inference (model load time, analysis latency, memory headroom of
  Gemma 4 E2B without the increased-memory entitlement, JSON quality on Saudi
  dishes). The simulator can't meaningfully run a 3 GB Metal model.
- A full 3.4 GB download over Wi-Fi incl. pause/resume and the SHA-256 step.
- Accuracy: photo portion estimates are rough (the UI says ±40%); macros for
  regional dishes are recipe estimates.
