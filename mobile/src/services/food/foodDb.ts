import { searchFoods, type FoodDb, type FoodItem, type FoodMatch } from '@fitbit-air-tracker/core';

/**
 * The bundled food database (built by mobile/assets/nutrition/build/build-foods.mjs
 * from USDA FoodData Central + curated regional dishes). Bundled in the JS
 * bundle — no network, works offline and without the vision model.
 */
// require() keeps TypeScript from inferring a literal type for ~1,300 items.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const FOOD_DB: FoodDb = require('../../../assets/nutrition/foods.json') as FoodDb;

const byId = new Map<string, FoodItem>(FOOD_DB.items.map((f) => [f.id, f]));

export function foodById(id: string): FoodItem | undefined {
  return byId.get(id);
}

export function searchFoodDb(query: string, limit = 30): FoodMatch[] {
  return searchFoods(FOOD_DB, query, limit);
}

/** Shown when the search box is empty: everyday + regional foods first. */
export const POPULAR_FOODS: FoodItem[] = FOOD_DB.items.filter((f) => (f.priority ?? 0) >= 0.9).slice(0, 40);

/** One-line provenance for the UI ("USDA FNDDS #2708403", "Recipe estimate", …). */
export function sourceLabel(food: FoodItem): string {
  const s = food.source;
  if (s.kind === 'usda') return `USDA ${s.dataset === 'SR Legacy' ? 'SR Legacy' : 'FNDDS'} #${s.fdcId}`;
  if (s.kind === 'proxy') return `Approximation via USDA #${s.of.fdcId}`;
  return 'Recipe estimate (USDA ingredients)';
}
