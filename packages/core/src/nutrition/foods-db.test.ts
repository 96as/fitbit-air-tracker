/**
 * Integration test against the real bundled food database
 * (mobile/assets/nutrition/foods.json, built by build/build-foods.mjs).
 * Test-only file: reading from disk is fine here (excluded from the core build).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchLabel, searchFoods } from './match.js';
import { gramsPerUnit } from './portions.js';
import type { FoodDb } from './types.js';

const path = fileURLToPath(new URL('../../../../mobile/assets/nutrition/foods.json', import.meta.url));
const raw = readFileSync(path, 'utf8');
const db = JSON.parse(raw) as FoodDb;
const top = (q: string) => searchFoods(db, q, 5)[0]?.food;

describe('bundled food DB', () => {
  it('is compact and well-formed', () => {
    expect(raw.length).toBeLessThan(2 * 1024 * 1024);
    expect(db.items.length).toBeGreaterThanOrEqual(500);
    expect(db.items.length).toBeLessThanOrEqual(1500);
    const ids = new Set<string>();
    for (const f of db.items) {
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(f.source).toBeDefined();
      const m = f.per100g;
      for (const v of [m.kcal, m.protein, m.carbs, m.fat, m.fiber]) expect(v).toBeGreaterThanOrEqual(0);
      expect(m.kcal).toBeLessThanOrEqual(902);
      expect(m.protein + m.carbs + m.fat).toBeLessThanOrEqual(101);
      for (const p of f.portions ?? []) expect(p.grams).toBeGreaterThan(0);
    }
  });

  it('contains no pork or alcohol items (halal by default)', () => {
    const bad = db.items.filter((f) => /\b(pork|bacon|ham|beer|wine|vodka|whiskey|liquor)\b/i.test(f.name));
    expect(bad.map((f) => f.name)).toEqual([]);
  });

  it.each([
    ['kabsa', 'me:kabsa-chicken'],
    ['كبسة', 'me:kabsa-chicken'],
    ['kebsa', 'me:kabsa-chicken'],
    ['lamb kabsa', 'me:kabsa-lamb'],
    ['mandi', 'me:mandi-chicken'],
    ['saleeg', 'me:saleeg'],
    ['jareesh', 'me:jareesh'],
    ['harees', 'me:harees'],
    ['laban', 'me:laban'],
    ['لبن', 'me:laban'],
    ['labneh', 'me:labneh'],
    ['ful', 'me:foul-medames'],
    ['foul medames', 'me:foul-medames'],
    ['shawarma', 'me:shawarma-chicken'],
    ['shawerma', 'me:shawarma-chicken'],
    ['شاورما', 'me:shawarma-chicken'],
    ['mutabbaq', 'me:mutabbaq-meat'],
    ['kunafa', 'me:kunafa'],
    ['knafeh', 'me:kunafa'],
    ['luqaimat', 'me:luqaimat'],
    ['sukkari dates', 'me:dates-sukkari'],
    ['ajwa', 'me:dates-ajwa'],
    ['tamees', 'me:tamees'],
    ['qahwa', 'me:qahwa'],
    ['karak', 'me:karak'],
  ])('regional: %s → %s', (q, id) => {
    expect(top(q)?.id).toBe(id);
  });

  it.each([
    ['hummus', /hummus/i],
    ['falafel', /falafel/i],
    ['arabic bread', /arabic bread/i],
    ['khubz', /arabic bread/i],
    ['white rice', /white rice/i],
    ['rice', /white rice/i],
    ['grilled chicken breast', /chicken breast, grilled/i],
    ['boiled egg', /egg, boiled/i],
    ['dates', /dates/i],
    ['tahini', /tahini/i],
    ['french fries', /french fries/i],
    ['greek yogurt', /greek yogurt/i],
    ['banana', /banana/i],
  ])('everyday: %s', (q, re) => {
    expect(top(q)?.name).toMatch(re);
  });

  it('matches typical VLM labels', () => {
    for (const label of ['chicken kabsa', 'white rice', 'hummus', 'arabic bread', 'laban', 'dates', 'grilled chicken', 'green salad', 'fried egg']) {
      expect(matchLabel(db, label).food, label).toBeDefined();
    }
  });

  it('has sensible regional portions', () => {
    const kabsa = db.items.find((f) => f.id === 'me:kabsa-chicken')!;
    expect(gramsPerUnit(kabsa, 'plate')).toBe(450);
    const falafel = top('falafel')!;
    expect(gramsPerUnit(falafel, 'piece')).toBeGreaterThan(10);
    expect(gramsPerUnit(falafel, 'piece')).toBeLessThan(40);
  });
});
