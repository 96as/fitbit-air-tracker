import { describe, expect, it } from 'vitest';
import {
  dailyTotals,
  macroProgress,
  macrosFor,
  mealTotals,
  proteinTarget,
  sumMacros,
} from './macros.js';
import { gramsPerUnit, suggestUnit, toGrams } from './portions.js';
import { matchLabel, normalizeText, searchFoods, skeleton, tokenize } from './match.js';
import { extractJsonBlock, parseMealAnalysis } from './parse.js';
import type { FoodItem, MealEntry } from './types.js';

const usda = (fdcId: number, description: string) => ({ kind: 'usda' as const, dataset: 'FNDDS 2021-2023' as const, fdcId, description });

const RICE: FoodItem = {
  id: 'fndds:1',
  name: 'Rice, white, cooked, NS as to fat',
  aliases: ['white rice', 'rice', 'ruz', 'رز', 'أرز'],
  category: 'grain',
  per100g: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4 },
  portions: [{ label: '1 cup', grams: 158 }],
  priority: 1,
  source: usda(1, 'Rice, white, cooked, NS as to fat'),
};
const RICE_FLOUR: FoodItem = {
  id: 'fndds:2',
  name: 'Rice flour',
  category: 'grain',
  per100g: { kcal: 366, protein: 6, carbs: 80, fat: 1.4, fiber: 2.4 },
  source: usda(2, 'Rice flour'),
};
const KABSA: FoodItem = {
  id: 'me:kabsa-chicken',
  name: 'Chicken kabsa',
  nameAr: 'كبسة دجاج',
  aliases: ['kabsa', 'kabsah', 'machboos', 'majboos', 'مكبوس'],
  category: 'mixed',
  per100g: { kcal: 170, protein: 10, carbs: 18, fat: 6, fiber: 0.8 },
  priority: 1,
  source: { kind: 'recipe', ingredients: [], yieldGrams: 1000 },
};
const LABAN: FoodItem = {
  id: 'me:laban',
  name: 'Laban (fermented milk drink)',
  nameAr: 'لبن',
  aliases: ['laban', 'leben', 'buttermilk drink'],
  category: 'beverage',
  per100g: { kcal: 62, protein: 3.2, carbs: 4.9, fat: 3.3, fiber: 0 },
  portions: [{ label: '1 cup', grams: 245 }],
  priority: 1,
  source: { kind: 'proxy', of: { dataset: 'SR Legacy', fdcId: 3, description: 'Milk, buttermilk, fluid, whole' }, note: 'x' },
};
const LABNEH: FoodItem = {
  id: 'me:labneh',
  name: 'Labneh (strained yogurt)',
  nameAr: 'لبنة',
  aliases: ['labneh', 'labna', 'labaneh'],
  category: 'dairy',
  per100g: { kcal: 160, protein: 8, carbs: 4, fat: 12, fiber: 0 },
  portions: [{ label: '1 tbsp', grams: 20 }],
  source: { kind: 'recipe', ingredients: [], yieldGrams: 100 },
};
const FOUL: FoodItem = {
  id: 'me:foul',
  name: 'Foul medames (stewed fava beans)',
  nameAr: 'فول مدمس',
  aliases: ['foul', 'ful', 'fool', 'ful medames'],
  category: 'legume',
  per100g: { kcal: 140, protein: 7, carbs: 16, fat: 5, fiber: 5 },
  source: { kind: 'recipe', ingredients: [], yieldGrams: 100 },
};
const SHAWARMA: FoodItem = {
  id: 'me:shawarma-chicken',
  name: 'Chicken shawarma sandwich',
  nameAr: 'شاورما دجاج',
  aliases: ['shawarma', 'shawerma', 'shwarma', 'chicken shawarma'],
  category: 'mixed',
  per100g: { kcal: 230, protein: 14, carbs: 22, fat: 9, fiber: 1.5 },
  portions: [{ label: '1 sandwich', grams: 220 }],
  source: { kind: 'recipe', ingredients: [], yieldGrams: 220 },
};
const FALAFEL: FoodItem = {
  id: 'fndds:3',
  name: 'Falafel',
  nameAr: 'فلافل',
  aliases: ['taameya', 'طعمية'],
  category: 'legume',
  per100g: { kcal: 333, protein: 13, carbs: 32, fat: 18, fiber: 4.9 },
  portions: [{ label: '1 patty (2-1/4" dia)', grams: 17 }, { label: '3 patties', grams: 51 }],
  source: usda(3, 'Falafel'),
};
const CHICKEN_BREAST: FoodItem = {
  id: 'fndds:4',
  name: 'Chicken breast, grilled without sauce, skin not eaten',
  aliases: ['grilled chicken breast'],
  category: 'protein',
  per100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0 },
  source: usda(4, 'Chicken breast, grilled without sauce, skin not eaten'),
};
const OIL: FoodItem = {
  id: 'fndds:5',
  name: 'Olive oil',
  category: 'fat',
  per100g: { kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0 },
  portions: [{ label: '1 tablespoon', grams: 13.5 }],
  source: usda(5, 'Olive oil'),
};
const DB = [RICE, RICE_FLOUR, KABSA, LABAN, LABNEH, FOUL, SHAWARMA, FALAFEL, CHICKEN_BREAST, OIL];

describe('normalize/tokenize', () => {
  it('unifies Arabic letter variants and strips diacritics + article', () => {
    expect(normalizeText('أَرُزّ')).toBe('ارز');
    expect(normalizeText('كبسة')).toBe('كبسه');
    expect(tokenize('الكبسة')).toEqual(['كبسه']);
    expect(normalizeText('Crème brûlée')).toBe('creme brulee');
  });
  it('stems plurals, maps synonyms and drops stopwords', () => {
    expect(tokenize('a plate of Dates')).toEqual(['date']);
    expect(tokenize('yoghurt with berries')).toEqual(['yogurt', 'berry']);
    expect(tokenize('fries')).toEqual(['french', 'fry']);
  });
  it('builds vowel-insensitive skeletons for transliterations', () => {
    expect(skeleton('kebsa')).toBe(skeleton('kabsa'));
    expect(skeleton('kabsah')).toBe('kbs');
    expect(skeleton('mutabbaq')).toBe(skeleton('motabbak'));
  });
});

describe('matcher', () => {
  const top = (q: string) => searchFoods(DB, q, 3)[0]?.food.id;
  it('matches exact aliases and Arabic script', () => {
    expect(top('kabsa')).toBe('me:kabsa-chicken');
    expect(top('كبسة')).toBe('me:kabsa-chicken');
    expect(top('الكبسة')).toBe('me:kabsa-chicken');
    expect(top('machboos')).toBe('me:kabsa-chicken');
    expect(top('رز')).toBe('fndds:1');
    expect(top('أرز')).toBe('fndds:1');
  });
  it('tolerates transliteration variants and typos', () => {
    expect(top('kebsa')).toBe('me:kabsa-chicken');
    expect(top('shawurma')).toBe('me:shawarma-chicken');
    expect(top('felafel')).toBe('fndds:3');
    expect(top('fuul')).toBe('me:foul');
  });
  it('keeps laban and labneh apart', () => {
    expect(top('laban')).toBe('me:laban');
    expect(top('labneh')).toBe('me:labneh');
    expect(top('labna')).toBe('me:labneh');
    expect(top('leben')).toBe('me:laban');
  });
  it('prefers the everyday food over a niche one with the same word', () => {
    expect(top('rice')).toBe('fndds:1');
    expect(top('white rice')).toBe('fndds:1');
    expect(top('rice flour')).toBe('fndds:2');
  });
  it('matches multi-word VLM labels against USDA comma-style names', () => {
    expect(top('grilled chicken breast')).toBe('fndds:4');
    expect(top('chicken breast grilled')).toBe('fndds:4');
  });
  it('matchLabel returns undefined below threshold, with alternatives', () => {
    expect(matchLabel(DB, 'chicken kabsa').food?.id).toBe('me:kabsa-chicken');
    const none = matchLabel(DB, 'spaceship');
    expect(none.food).toBeUndefined();
    expect(searchFoods(DB, '   ')).toEqual([]);
  });
});

describe('portions', () => {
  it('uses the food’s own household measure when present', () => {
    expect(gramsPerUnit(RICE, 'cup')).toBe(158);
    expect(toGrams(RICE, 1.5, 'cup')).toBe(237);
    expect(gramsPerUnit(OIL, 'tbsp')).toBe(13.5);
    expect(gramsPerUnit(SHAWARMA, 'piece')).toBe(220);
  });
  it('derives per-piece grams from "3 patties" style labels', () => {
    expect(gramsPerUnit(FALAFEL, 'piece')).toBe(17);
  });
  it('converts volume with density from the cup portion', () => {
    expect(toGrams(LABAN, 250, 'ml')).toBe(Math.round(250 * (245 / 236.6)));
    expect(gramsPerUnit(RICE, 'tbsp')).toBeCloseTo((158 / 236.6) * 14.79, 0);
  });
  it('falls back to category heuristics for plates and hand portions', () => {
    expect(gramsPerUnit(KABSA, 'plate')).toBe(350);
    expect(gramsPerUnit(CHICKEN_BREAST, 'palm')).toBe(90);
    expect(gramsPerUnit(RICE, 'fist')).toBe(158);
    expect(toGrams(RICE, 2, 'g')).toBe(2);
    expect(toGrams(RICE, 0.2, 'kg')).toBe(200);
    expect(toGrams(RICE, -1, 'cup')).toBe(0);
  });
  it('suggests a natural unit for a gram estimate', () => {
    expect(suggestUnit(FALAFEL, 50)).toEqual({ quantity: 3, unit: 'piece' });
    expect(suggestUnit(RICE, 160)).toEqual({ quantity: 1, unit: 'cup' });
    expect(suggestUnit({ ...KABSA, portions: [{ label: '1 plate', grams: 450 }] }, 450)).toEqual({ quantity: 1, unit: 'plate' });
    expect(suggestUnit(CHICKEN_BREAST, 123)).toEqual({ quantity: 123, unit: 'g' });
  });
});

describe('macros + targets', () => {
  it('scales per-100 g values', () => {
    expect(macrosFor(CHICKEN_BREAST, 150)).toEqual({ kcal: 248, protein: 46.5, carbs: 0, fat: 5.4, fiber: 0 });
    expect(macrosFor(RICE, 0).kcal).toBe(0);
    expect(macrosFor(RICE, Number.NaN).kcal).toBe(0);
  });
  it('sums meals per local date', () => {
    const item = (food: FoodItem, grams: number) => ({ foodId: food.id, name: food.name, quantity: grams, unit: 'g' as const, grams, macros: macrosFor(food, grams) });
    const meals: MealEntry[] = [
      { id: 'a', dateLocal: '2026-10-08', loggedAtUtc: '2026-10-08T05:00:00Z', title: 'Breakfast', source: 'manual', items: [item(FOUL, 200), item(FALAFEL, 51)] },
      { id: 'b', dateLocal: '2026-10-08', loggedAtUtc: '2026-10-08T11:00:00Z', title: 'Lunch', source: 'photo', items: [item(KABSA, 400)] },
      { id: 'c', dateLocal: '2026-10-07', loggedAtUtc: '2026-10-07T11:00:00Z', title: 'Old', source: 'manual', items: [item(RICE, 1000)] },
    ];
    const t = dailyTotals(meals, '2026-10-08');
    expect(t.kcal).toBe(280 + 170 + 680);
    expect(t.protein).toBeCloseTo(14 + 6.6 + 40, 1);
    expect(mealTotals(meals[2]!).kcal).toBe(1300);
    expect(sumMacros([])).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });
  });
  it('protein target = g/kg × weight (default 1.6)', () => {
    expect(proteinTarget(80)).toBe(128);
    expect(proteinTarget(72.5, 2)).toBe(145);
    expect(proteinTarget(0)).toBe(0);
    expect(proteinTarget(70, -1)).toBe(112);
    expect(macroProgress(64, 128)).toBe(0.5);
    expect(macroProgress(300, 128)).toBe(1);
    expect(macroProgress(10, 0)).toBe(0);
  });
});

describe('parseMealAnalysis', () => {
  it('parses clean JSON', () => {
    expect(parseMealAnalysis('{"items":[{"label":"chicken kabsa","estGrams":350,"confidence":0.8}]}')).toEqual({
      items: [{ label: 'chicken kabsa', estGrams: 350, confidence: 0.8 }],
    });
  });
  it('handles fences, prose, trailing commas, single quotes and loose values', () => {
    const text = "Sure! Here is the analysis:\n```json\n{ items: [ {'label': 'Hummus', 'grams': '120 g', 'confidence': 'high'}, {\"name\":\"arabic bread\",\"estGrams\":80,\"confidence\":85,}, ] }\n```\nEnjoy!";
    expect(parseMealAnalysis(text)).toEqual({
      items: [
        { label: 'Hummus', estGrams: 120, confidence: 0.8 },
        { label: 'arabic bread', estGrams: 80, confidence: 0.85 },
      ],
    });
  });
  it('accepts a bare array and clamps/dedupes', () => {
    const r = parseMealAnalysis('[{"label":"dates","estGrams":-5},{"label":"Dates","estGrams":40},{"label":"laban","estGrams":"0.3 kg","confidence":95}]');
    expect(r).toEqual({ items: [{ label: 'dates', estGrams: 1, confidence: 0.5 }, { label: 'laban', estGrams: 300, confidence: 0.95 }] });
  });
  it('salvages complete items from truncated output', () => {
    const r = parseMealAnalysis('{"items":[{"label":"rice","estGrams":200,"confidence":0.9},{"label":"chick');
    expect(r?.items).toEqual([{ label: 'rice', estGrams: 200, confidence: 0.9 }]);
  });
  it('treats an explicit empty list as "no food" and garbage as null', () => {
    expect(parseMealAnalysis('{"items": []}')).toEqual({ items: [] });
    expect(parseMealAnalysis('I cannot see any food.')).toBeNull();
    expect(parseMealAnalysis('{"items":[{"foo":1}]}')).toBeNull();
    expect(parseMealAnalysis('')).toBeNull();
  });
  it('extractJsonBlock ignores braces inside strings', () => {
    expect(extractJsonBlock('x {"a":"}{"} y')).toBe('{"a":"}{"}');
  });
});
