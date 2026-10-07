import type { FoodDb, FoodItem } from './types.js';

/**
 * Fuzzy label → food matching for the photo model's labels and the search box.
 *
 * Works on English (incl. USDA "Chicken, breast, grilled" style), Latin
 * transliterations of Arabic (kabsa/kebsa/kabsah, foul/ful/fool…) and Arabic
 * script (كبسة, الكبسة, فول). Three layers per word:
 *   exact → prefix → edit-distance ratio, plus a vowel-insensitive
 *   "consonant skeleton" so transliteration variants still meet.
 * Pure and dependency-free; the index is cached per database object.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'with', 'and', 'or', 'in', 'on', 'for', 'some', 'plate', 'bowl', 'piece', 'pieces',
  'serving', 'portion', 'side', 'ns', 'nfs', 'as', 'to', 'type', 'from', 'made', 'style', 'food', 'dish',
  'و', 'مع', 'في', 'من', 'طبق', 'صحن',
]);

/** Single-word synonyms (British/regional English → USDA wording). */
const WORD_SYNONYMS: Record<string, string> = {
  yoghurt: 'yogurt',
  yogourt: 'yogurt',
  omelette: 'omelet',
  aubergine: 'eggplant',
  brinjal: 'eggplant',
  courgette: 'zucchini',
  capsicum: 'pepper',
  coriander: 'cilantro',
  prawn: 'shrimp',
  mince: 'ground',
  minced: 'ground',
  biscuit: 'cookie',
  crisps: 'chips',
  chilli: 'chili',
  chile: 'chili',
  porridge: 'oatmeal',
  oats: 'oatmeal',
  soda: 'soft drink',
  coke: 'cola',
  fries: 'french fries',
  mutton: 'lamb',
  flatbread: 'pita',
  barbecue: 'bbq',
  broiled: 'grilled',
  sunny: 'fried',
  beefsteak: 'beef steak',
  burger: 'hamburger',
  chickpea: 'chickpeas',
  garbanzo: 'chickpeas',
};

const AR_DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g; // tashkeel + tatweel

/** Lowercase, strip Latin accents + Arabic diacritics, unify Arabic letter variants, drop punctuation. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/['’`ʿʾ]/g, '')
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();
}

function stem(t: string): string {
  if (/[؀-ۿ]/.test(t)) {
    // Arabic definite article: الكبسة → كبسه
    return t.length > 4 && t.startsWith('ال') ? t.slice(2) : t;
  }
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(ches|shes|xes|oes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return t.slice(0, -1);
  return t;
}

/** Normalized, stemmed, synonym-mapped tokens without stopwords. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(s).split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const syn = WORD_SYNONYMS[raw];
    for (const w of (syn ?? raw).split(' ')) {
      const t = stem(w);
      if (t && !STOPWORDS.has(t)) out.push(t);
    }
  }
  return out;
}

/** Vowel-insensitive consonant skeleton for Latin transliterations ("kebsa"/"kabsah" → "kbs"). */
export function skeleton(t: string): string {
  if (/[؀-ۿ]/.test(t)) return t.replace(/[اويه]/g, '');
  return t
    .replace(/h$/, '')
    .replace(/q/g, 'k')
    .replace(/ck/g, 'k')
    .replace(/ph/g, 'f')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Similarity of two single tokens, 0..1. */
export function tokenSimilarity(q: string, t: string): number {
  if (q === t) return 1;
  if (q.length >= 3 && t.startsWith(q)) return 0.9 - Math.min(0.2, (t.length - q.length) * 0.03);
  if (t.length >= 4 && q.startsWith(t)) return 0.8;
  const maxLen = Math.max(q.length, t.length);
  let best = 0;
  if (maxLen >= 4) {
    const maxEdits = maxLen >= 8 ? 2 : 1;
    const d = editDistance(q, t, maxEdits);
    if (d <= maxEdits) best = 1 - d / maxLen;
  }
  const sq = skeleton(q);
  if (sq.length >= 3 && sq === skeleton(t)) {
    const d = editDistance(q, t, 4);
    best = Math.max(best, 0.8 + 0.1 * Math.max(0, 1 - d / maxLen));
  }
  return best;
}

/** How well `query` tokens are covered by one candidate string's tokens, 0..1. */
function phraseScore(q: string[], qNorm: string, cand: { norm: string; tokens: string[] }): number {
  if (q.length === 0 || cand.tokens.length === 0) return 0;
  if (qNorm === cand.norm) return 1;
  let sum = 0;
  const used = new Set<number>();
  for (const qt of q) {
    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < cand.tokens.length; i++) {
      const s = tokenSimilarity(qt, cand.tokens[i]!);
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    }
    if (best >= 0.75 && bestIdx >= 0) used.add(bestIdx);
    sum += best;
  }
  const coverage = sum / q.length;
  if (coverage < 0.5) return 0;
  const precision = used.size / cand.tokens.length;
  // Word order: reward when the first query word leads the candidate ("rice, white…" for "rice").
  const lead = tokenSimilarity(q[0]!, cand.tokens[0]!) >= 0.8 ? 0.04 : 0;
  return Math.min(0.99, coverage * (0.72 + 0.28 * precision) + lead);
}

interface IndexedFood {
  food: FoodItem;
  strings: { norm: string; tokens: string[] }[];
}

const INDEX = new WeakMap<object, IndexedFood[]>();

function indexOf(db: FoodDb | readonly FoodItem[]): IndexedFood[] {
  const key = db as object;
  const cached = INDEX.get(key);
  if (cached) return cached;
  const items = Array.isArray(db) ? (db as readonly FoodItem[]) : (db as FoodDb).items;
  const built = items.map((food) => ({
    food,
    strings: [food.name, food.nameAr, ...(food.aliases ?? [])]
      .filter((s): s is string => !!s)
      .map((s) => ({ norm: tokenize(s).join(' '), tokens: tokenize(s) })),
  }));
  INDEX.set(key, built);
  return built;
}

export interface FoodMatch {
  food: FoodItem;
  /** 0..1 (+ a small priority bonus). ≥ 0.6 is a confident match. */
  score: number;
}

/** Ranked foods for a free-text query (English, transliteration or Arabic). */
export function searchFoods(db: FoodDb | readonly FoodItem[], query: string, limit = 20): FoodMatch[] {
  const q = tokenize(query);
  if (q.length === 0) return [];
  const qNorm = q.join(' ');
  const out: FoodMatch[] = [];
  for (const entry of indexOf(db)) {
    let best = 0;
    for (const s of entry.strings) {
      const sc = phraseScore(q, qNorm, s);
      if (sc > best) best = sc;
      if (best === 1) break;
    }
    if (best >= 0.5) out.push({ food: entry.food, score: best + 0.06 * (entry.food.priority ?? 0) });
  }
  out.sort((a, b) => b.score - a.score || a.food.name.length - b.food.name.length);
  return out.slice(0, limit);
}

/** Confidence threshold for auto-accepting a photo label's match. */
export const MATCH_THRESHOLD = 0.6;

/**
 * Best database food for a vision-model label. `food` is undefined when
 * nothing clears the threshold — the UI then asks the user to search.
 */
export function matchLabel(
  db: FoodDb | readonly FoodItem[],
  label: string,
): { food?: FoodItem; score: number; alternatives: FoodMatch[] } {
  const ranked = searchFoods(db, label, 6);
  const top = ranked[0];
  if (top && top.score >= MATCH_THRESHOLD) return { food: top.food, score: top.score, alternatives: ranked.slice(1) };
  return { food: undefined, score: top?.score ?? 0, alternatives: ranked };
}
