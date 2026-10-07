/**
 * Nutrition domain types (calorie + protein checker).
 *
 * Everything here is plain data so the same shapes work in the bundled food
 * database (mobile/assets/nutrition/foods.json), the phone's persisted store
 * and any future server/agent surface. Macro values are always **per 100 g**
 * of the food as eaten (cooked, prepared) unless the food name says "raw"/"dry".
 */

/** kcal + grams of each macro. */
export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}

export type FoodCategory =
  | 'grain'
  | 'bread'
  | 'protein'
  | 'dairy'
  | 'legume'
  | 'vegetable'
  | 'fruit'
  | 'fat'
  | 'sweet'
  | 'snack'
  | 'sauce'
  | 'beverage'
  | 'mixed'
  | 'other';

/** A USDA FoodData Central record (public domain, U.S. Government work). */
export interface UsdaRef {
  dataset: 'FNDDS 2021-2023' | 'SR Legacy';
  fdcId: number;
  description: string;
}

/**
 * Where a food's numbers come from — kept per item so the app can be honest
 * about precision:
 * - `usda`: values copied from one USDA FDC record.
 * - `proxy`: values of a similar USDA record (e.g. Gulf *laban* ≈ cultured
 *   buttermilk); `note` explains the approximation.
 * - `recipe`: computed by the build script from a typical recipe of USDA
 *   ingredients (grams) divided by the cooked yield. An estimate, not a lab value.
 */
export type FoodSource =
  | ({ kind: 'usda' } & UsdaRef)
  | { kind: 'proxy'; of: UsdaRef; note: string }
  | { kind: 'recipe'; ingredients: { fdcId: number; description: string; grams: number }[]; yieldGrams: number; note?: string };

/** A named household portion for one food, e.g. `{ label: '1 cup', grams: 158 }`. */
export interface FoodPortion {
  label: string;
  grams: number;
}

export interface FoodItem {
  /** Stable id: `fndds:<fdcId>`, `sr:<fdcId>` or `me:<slug>` (regional). */
  id: string;
  /** Display name (English). */
  name: string;
  /** Arabic display name, when known. */
  nameAr?: string;
  /** Extra search terms: common names, transliterations, Arabic spellings. */
  aliases?: string[];
  category: FoodCategory;
  /** Macros per 100 g. */
  per100g: Macros;
  /** USDA/household portions, most typical first. */
  portions?: FoodPortion[];
  /** g per ml, for volume units. Defaults are derived from a cup portion or the category. */
  density?: number;
  /** 0..1 search boost for everyday/curated items (ties go to common foods). */
  priority?: number;
  source: FoodSource;
}

export interface FoodDb {
  version: string;
  generatedFrom: string[];
  items: FoodItem[];
}

/** Units a user (or the photo model) can log a portion in. */
export type PortionUnit =
  | 'g'
  | 'kg'
  | 'oz'
  | 'ml'
  | 'cup'
  | 'tbsp'
  | 'tsp'
  | 'piece'
  | 'slice'
  | 'plate'
  | 'bowl'
  | 'palm'
  | 'fist'
  | 'handful'
  | 'thumb';

/** One food on a logged meal; macros are a snapshot so later DB updates don't rewrite history. */
export interface LoggedFood {
  foodId: string;
  name: string;
  quantity: number;
  unit: PortionUnit;
  grams: number;
  macros: Macros;
  /** What the photo model called it, if the item came from a photo. */
  aiLabel?: string;
  /** Model's self-reported confidence 0..1 (photo items only). */
  aiConfidence?: number;
}

export interface MealEntry {
  id: string;
  /** Local calendar date (YYYY-MM-DD in the user's tz) the meal counts toward. */
  dateLocal: string;
  /** ISO-8601 UTC. */
  loggedAtUtc: string;
  title: string;
  source: 'photo' | 'manual';
  items: LoggedFood[];
}

/** One item the vision model thinks is on the plate (before the user confirms it). */
export interface DetectedFood {
  label: string;
  estGrams: number;
  confidence: number;
}

export interface MealAnalysis {
  items: DetectedFood[];
}
