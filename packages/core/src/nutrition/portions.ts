import type { FoodCategory, FoodItem, PortionUnit } from './types.js';

/**
 * Portion units → grams for a specific food.
 *
 * Order of preference for each unit:
 *  1. a matching named portion on the food itself (USDA household measures,
 *     e.g. "1 cup" = 158 g of cooked rice);
 *  2. a volume conversion using the food's density (from its cup portion, or
 *     an explicit `density`, or a category default);
 *  3. a category heuristic (plates, pieces, hand portions).
 *
 * Hand portions follow the widely used "hand-size portion" heuristics
 * (palm ≈ one cooked protein serving ~85–100 g, fist ≈ 1 cup, cupped hand ≈
 * ½ cup / ~30 g nuts, thumb ≈ 1 tbsp). They are deliberately rough — the UI
 * says so and suggests weighing for accuracy.
 */

export const ML_PER_CUP = 236.6;
export const ML_PER_TBSP = 14.79;
export const ML_PER_TSP = 4.93;
export const G_PER_OZ = 28.35;

export const PORTION_UNITS: readonly PortionUnit[] = [
  'g', 'kg', 'oz', 'ml', 'cup', 'tbsp', 'tsp', 'piece', 'slice', 'plate', 'bowl', 'palm', 'fist', 'handful', 'thumb',
];

export const UNIT_LABELS: Record<PortionUnit, string> = {
  g: 'g',
  kg: 'kg',
  oz: 'oz',
  ml: 'ml',
  cup: 'cup',
  tbsp: 'tbsp',
  tsp: 'tsp',
  piece: 'piece',
  slice: 'slice',
  plate: 'plate',
  bowl: 'bowl',
  palm: 'palm',
  fist: 'fist',
  handful: 'handful',
  thumb: 'thumb',
};

/** Typical g/ml when a food has no cup portion. */
const CATEGORY_DENSITY: Record<FoodCategory, number> = {
  grain: 0.75,
  bread: 0.3,
  protein: 0.6,
  dairy: 1.03,
  legume: 0.75,
  vegetable: 0.55,
  fruit: 0.6,
  fat: 0.92,
  sweet: 0.6,
  snack: 0.3,
  sauce: 1.0,
  beverage: 1.0,
  mixed: 0.8,
  other: 0.8,
};

/** A "plate" / "piece" when the food has no named portion. */
const CATEGORY_PLATE_G: Record<FoodCategory, number> = {
  grain: 250,
  bread: 90,
  protein: 200,
  dairy: 200,
  legume: 250,
  vegetable: 150,
  fruit: 150,
  fat: 15,
  sweet: 120,
  snack: 60,
  sauce: 60,
  beverage: 250,
  mixed: 350,
  other: 250,
};

const CATEGORY_PIECE_G: Record<FoodCategory, number> = {
  grain: 50,
  bread: 60,
  protein: 100,
  dairy: 30,
  legume: 20,
  vegetable: 80,
  fruit: 120,
  fat: 5,
  sweet: 40,
  snack: 25,
  sauce: 15,
  beverage: 250,
  mixed: 150,
  other: 50,
};

const PALM_G = 90; // cooked meat/fish/chicken, adult palm (thickness + area)
const HANDFUL_G_DENSE = 30; // nuts, dried fruit, snacks
const THUMB_ML = ML_PER_TBSP;

const PIECE_RE = /\b(piece|medium|each|item|whole|sandwich|patty|ball|date|fruit|egg|roll|wrap|bar|cookie|pastry|slice|large|small)\b/i;

function portionGrams(food: FoodItem, re: RegExp): number | undefined {
  const p = food.portions?.find((x) => re.test(x.label) && x.grams > 0);
  if (!p) return undefined;
  // Labels like "2 pieces" → per-piece grams.
  const m = /^(\d+(?:\.\d+)?)\s/.exec(p.label.trim());
  const count = m ? Number(m[1]) : 1;
  return count > 0 ? p.grams / count : p.grams;
}

/** g/ml for volume units. */
export function densityOf(food: FoodItem): number {
  if (food.density && food.density > 0) return food.density;
  const cup = portionGrams(food, /^1 cup\b|^\d+(\.\d+)? cups?\b/i);
  if (cup) return cup / ML_PER_CUP;
  return CATEGORY_DENSITY[food.category] ?? 0.8;
}

/** Grams of ONE unit of `unit` for `food`. */
export function gramsPerUnit(food: FoodItem, unit: PortionUnit): number {
  switch (unit) {
    case 'g':
      return 1;
    case 'kg':
      return 1000;
    case 'oz':
      return G_PER_OZ;
    case 'ml':
      return densityOf(food);
    case 'cup':
      return portionGrams(food, /\bcup\b|\bcups\b/i) ?? round(ML_PER_CUP * densityOf(food));
    case 'tbsp':
      return portionGrams(food, /\btbsp\b|tablespoon/i) ?? round(ML_PER_TBSP * densityOf(food));
    case 'tsp':
      return portionGrams(food, /\btsp\b|teaspoon/i) ?? round(ML_PER_TSP * densityOf(food));
    case 'slice':
      return portionGrams(food, /\bslice\b/i) ?? portionGrams(food, PIECE_RE) ?? CATEGORY_PIECE_G[food.category];
    case 'piece':
      return portionGrams(food, PIECE_RE) ?? CATEGORY_PIECE_G[food.category];
    case 'plate':
      return portionGrams(food, /\bplate\b|\bserving\b|\bplatter\b/i) ?? CATEGORY_PLATE_G[food.category];
    case 'bowl':
      return portionGrams(food, /\bbowl\b/i) ?? round(1.5 * ML_PER_CUP * densityOf(food));
    case 'palm':
      // A palm is a protein portion; for other foods treat it as ~½ cup-ish flat serving.
      return food.category === 'protein' || food.category === 'mixed' ? PALM_G : round(0.5 * ML_PER_CUP * densityOf(food));
    case 'fist':
      return gramsPerUnit(food, 'cup');
    case 'handful':
      return food.category === 'snack' || food.category === 'fat' || food.category === 'sweet'
        ? HANDFUL_G_DENSE
        : round(0.5 * ML_PER_CUP * densityOf(food));
    case 'thumb':
      return round(THUMB_ML * densityOf(food));
  }
}

/** Grams for `quantity` × `unit` of `food` (rounded to 1 g, never negative). */
export function toGrams(food: FoodItem, quantity: number, unit: PortionUnit): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.max(0, Math.round(quantity * gramsPerUnit(food, unit)));
}

/**
 * The most natural unit to show for a food, with the quantity that matches
 * `grams` — e.g. 2 pieces of falafel rather than 34 g. Falls back to grams.
 */
export function suggestUnit(food: FoodItem, grams: number): { quantity: number; unit: PortionUnit } {
  // Only units backed by the food's own household measures — never a category guess.
  const candidates: [PortionUnit, RegExp][] = [
    ['piece', PIECE_RE],
    ['plate', /\bplate\b|\bplatter\b/i],
    ['bowl', /\bbowl\b/i],
    ['cup', /\bcup\b|\bcups\b/i],
    ['slice', /\bslice\b/i],
  ];
  for (const [unit, re] of candidates) {
    const per = portionGrams(food, re);
    if (!per || per <= 0) continue;
    const q = grams / per;
    const half = Math.round(q * 2) / 2;
    if (half >= 0.5 && half <= 12 && Math.abs(half * per - grams) / Math.max(grams, 1) < 0.2) return { quantity: half, unit };
  }
  return { quantity: Math.max(1, Math.round(grams)), unit: 'g' };
}

/** Step size for the +/- stepper in a given unit. */
export function stepFor(unit: PortionUnit): number {
  switch (unit) {
    case 'g':
    case 'ml':
      return 10;
    case 'kg':
      return 0.1;
    case 'oz':
      return 1;
    case 'plate':
    case 'bowl':
    case 'cup':
    case 'piece':
    case 'slice':
    case 'palm':
    case 'fist':
    case 'handful':
      return 0.5;
    case 'tbsp':
    case 'tsp':
    case 'thumb':
      return 1;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
