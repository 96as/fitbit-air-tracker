import type { DetectedFood, MealAnalysis } from './types.js';

/**
 * Robust parser for the on-device vision model's reply.
 *
 * Small VLMs often wrap JSON in ```json fences, add prose, use trailing
 * commas, single quotes, "150 g" strings or "high"/"85%" confidences. This
 * accepts all of those and returns a clean `MealAnalysis`, or `null` when no
 * usable item list can be recovered (the caller then retries once and finally
 * falls back to manual entry).
 */

export const MAX_ITEMS = 12;
const MIN_GRAMS = 1;
const MAX_GRAMS = 2500;

function stripFences(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fenced ? fenced[1]! : text;
}

/** First balanced {...} or [...] block, respecting strings. */
export function extractJsonBlock(text: string): string | undefined {
  const s = stripFences(text);
  const start = s.search(/[[{]/);
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inStr: string | null = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return undefined;
      if (stack.length === 0) return s.slice(start, i + 1);
    }
  }
  // Truncated output (ran out of tokens): close what is open so we can salvage complete items.
  if (stack.length > 0) {
    let partial = s.slice(start).replace(/,\s*$/, '');
    // drop a dangling incomplete object at the end
    const lastClose = Math.max(partial.lastIndexOf('}'), partial.lastIndexOf(']'));
    if (lastClose > 0) partial = partial.slice(0, lastClose + 1);
    const opens: string[] = [];
    let q: string | null = null;
    for (let i = 0; i < partial.length; i++) {
      const ch = partial[i]!;
      if (q) {
        if (ch === '\\') i++;
        else if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '{' || ch === '[') opens.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') opens.pop();
    }
    return partial + opens.reverse().join('');
  }
  return undefined;
}

function lenientJsonParse(block: string): unknown {
  try {
    return JSON.parse(block);
  } catch {
    // trailing commas, single-quoted strings, unquoted keys
    const fixed = block
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => JSON.stringify(inner))
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    try {
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /-?\d+(?:\.\d+)?/.exec(v.replace(',', '.'));
    if (m) {
      let n = Number(m[0]);
      if (/\bkg\b/i.test(v)) n *= 1000;
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

function toConfidence(v: unknown): number {
  if (typeof v === 'string') {
    const w = v.trim().toLowerCase();
    if (w.startsWith('high')) return 0.8;
    if (w.startsWith('med')) return 0.55;
    if (w.startsWith('low')) return 0.3;
  }
  let n = toNumber(v);
  if (n === undefined) return 0.5;
  if (n > 1) n = n / 100;
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function toItem(raw: unknown): DetectedFood | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const labelRaw = pick(o, ['label', 'name', 'food', 'item', 'dish']);
  const label = typeof labelRaw === 'string' ? labelRaw.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
  if (!label) return undefined;
  const g = toNumber(pick(o, ['estGrams', 'est_grams', 'grams', 'weight_g', 'weightGrams', 'weight', 'portion_g', 'amount_g']));
  const estGrams = Math.round(Math.max(MIN_GRAMS, Math.min(MAX_GRAMS, g ?? 100)));
  return { label, estGrams, confidence: toConfidence(pick(o, ['confidence', 'conf', 'certainty', 'probability'])) };
}

/** Parse a model reply into detected foods; `null` if nothing usable. */
export function parseMealAnalysis(text: string): MealAnalysis | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const block = extractJsonBlock(text);
  if (!block) return null;
  const data = lenientJsonParse(block);
  let list: unknown[] | undefined;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    const inner = pick(o, ['items', 'foods', 'food_items', 'dishes']);
    if (Array.isArray(inner)) list = inner;
    else if (pick(o, ['label', 'name', 'food'])) list = [o];
  }
  if (!list) return null;
  const items: DetectedFood[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const it = toItem(raw);
    if (!it) continue;
    const key = it.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
    if (items.length >= MAX_ITEMS) break;
  }
  // An explicit empty list is a valid answer ("no food in photo").
  if (items.length === 0 && !(Array.isArray(list) && list.length === 0)) return null;
  return { items };
}

/** JSON schema handed to the runtime's constrained decoding (when supported). */
export const MEAL_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          estGrams: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['label', 'estGrams', 'confidence'],
      },
    },
  },
  required: ['items'],
} as const;

/** The instruction given to the vision model with the photo. */
export const MEAL_ANALYSIS_PROMPT = [
  'You are a nutrition assistant. Identify each distinct food or drink visible in this photo.',
  'Use short common names (e.g. "chicken kabsa", "white rice", "hummus", "arabic bread", "laban", "dates").',
  'Estimate the edible weight in grams of each item as served, using plate size, utensils and hands for scale.',
  'Give a confidence from 0 to 1 for each identification.',
  'Reply with JSON only, no prose, exactly in this shape:',
  '{"items":[{"label":"string","estGrams":number,"confidence":number}]}',
  'If there is no food, reply {"items":[]}.',
].join('\n');

/** Stricter prompt for the one retry after an unparseable reply. */
export const MEAL_ANALYSIS_RETRY_PROMPT = [
  'Return ONLY valid JSON. No markdown, no explanation.',
  'List the foods in the photo as {"items":[{"label":"food name","estGrams":150,"confidence":0.7}]}.',
].join('\n');
