import type { FoodItem, LoggedFood, Macros, MealEntry } from './types.js';

export const ZERO_MACROS: Macros = Object.freeze({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

/** Default protein target for an active adult doing resistance training (ISSN position stand range 1.4–2.0 g/kg). */
export const DEFAULT_PROTEIN_G_PER_KG = 1.6;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function roundMacros(m: Macros): Macros {
  return { kcal: Math.round(m.kcal), protein: round1(m.protein), carbs: round1(m.carbs), fat: round1(m.fat), fiber: round1(m.fiber) };
}

/** Macros for `grams` of a food (per-100 g values scaled). */
export function macrosFor(food: Pick<FoodItem, 'per100g'>, grams: number): Macros {
  const g = Number.isFinite(grams) && grams > 0 ? grams : 0;
  const f = g / 100;
  const p = food.per100g;
  return roundMacros({ kcal: p.kcal * f, protein: p.protein * f, carbs: p.carbs * f, fat: p.fat * f, fiber: p.fiber * f });
}

export function sumMacros(list: readonly Macros[]): Macros {
  const total = { ...ZERO_MACROS };
  for (const m of list) {
    total.kcal += m.kcal;
    total.protein += m.protein;
    total.carbs += m.carbs;
    total.fat += m.fat;
    total.fiber += m.fiber;
  }
  return roundMacros(total);
}

export function mealTotals(meal: Pick<MealEntry, 'items'>): Macros {
  return sumMacros(meal.items.map((i: LoggedFood) => i.macros));
}

/** Totals for one local date (`YYYY-MM-DD`) across all meals. */
export function dailyTotals(meals: readonly MealEntry[], dateLocal: string): Macros {
  return sumMacros(meals.filter((m) => m.dateLocal === dateLocal).map(mealTotals));
}

/**
 * Daily protein target = g/kg × body weight, rounded to the nearest gram.
 * Returns 0 for missing/invalid weight so the UI can ask for it.
 */
export function proteinTarget(weightKg: number, gPerKg: number = DEFAULT_PROTEIN_G_PER_KG): number {
  if (!Number.isFinite(weightKg) || weightKg <= 0) return 0;
  const perKg = Number.isFinite(gPerKg) && gPerKg > 0 ? gPerKg : DEFAULT_PROTEIN_G_PER_KG;
  return Math.round(weightKg * perKg);
}

/** 0..1 (capped) progress toward a target; 0 when the target is unknown. */
export function macroProgress(value: number, target: number): number {
  if (!(target > 0)) return 0;
  return Math.max(0, Math.min(1, value / target));
}
