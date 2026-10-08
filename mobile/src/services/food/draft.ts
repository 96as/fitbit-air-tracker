import {
  macrosFor,
  matchLabel,
  suggestUnit,
  toGrams,
  type FoodItem,
  type LoggedFood,
  type MealAnalysis,
  type PortionUnit,
} from '@fitbit-air-tracker/core';
import { newDraft, type MealDraft } from '../../foodStore';
import { FOOD_DB } from './foodDb';

/** A logged line for `quantity × unit` of `food` (macros snapshotted). */
export function loggedFood(food: FoodItem, quantity: number, unit: PortionUnit, extra?: Pick<LoggedFood, 'aiLabel' | 'aiConfidence'>): LoggedFood {
  const grams = toGrams(food, quantity, unit);
  return { foodId: food.id, name: food.name, quantity, unit, grams, macros: macrosFor(food, grams), ...extra };
}

/** Same line with a new food/quantity/unit, keeping the AI provenance. */
export function relog(prev: LoggedFood, food: FoodItem, quantity: number, unit: PortionUnit): LoggedFood {
  return loggedFood(food, quantity, unit, { aiLabel: prev.aiLabel, aiConfidence: prev.aiConfidence });
}

/** Default quantity/unit for a food picked from search. */
export function defaultPortion(food: FoodItem): { quantity: number; unit: PortionUnit } {
  const first = food.portions?.[0];
  if (first) return suggestUnit(food, first.grams);
  return { quantity: 100, unit: 'g' };
}

/** Turn the model's labels into an editable draft: matched foods + leftovers to map by hand. */
export function draftFromAnalysis(analysis: MealAnalysis, dateLocal: string): MealDraft {
  const draft = newDraft('photo', dateLocal);
  for (const det of analysis.items) {
    const { food } = matchLabel(FOOD_DB, det.label);
    if (!food) {
      draft.unmatched.push(det);
      continue;
    }
    const { quantity, unit } = suggestUnit(food, det.estGrams);
    draft.items.push(loggedFood(food, quantity, unit, { aiLabel: det.label, aiConfidence: det.confidence }));
  }
  return draft;
}
