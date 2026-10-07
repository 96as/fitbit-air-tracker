import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  DEFAULT_PROTEIN_G_PER_KG,
  dailyTotals,
  localDateString,
  newId,
  proteinTarget,
  type DetectedFood,
  type LoggedFood,
  type Macros,
  type MealEntry,
} from '@fitbit-air-tracker/core';
import type { DownloadPauseState } from 'expo-file-system';

/**
 * Food log + nutrition settings, persisted on the phone only (AsyncStorage).
 * Photos are never stored here — only the confirmed foods and grams.
 * Same shapes as core's `MealEntry`, so a future sync/agent can consume it.
 */

export interface FoodSettings {
  /** Body weight for the protein target. 0 = not set yet. */
  weightKg: number;
  /** Protein g per kg body weight (default 1.6). */
  proteinGPerKg: number;
  /** Optional daily energy target (0 = none; we only show what you ate). */
  kcalTarget: number;
  /** Which on-device vision model to use (see services/food/models.ts). */
  modelId: string;
}

/** A verified, installed model on disk. */
export interface InstalledModel {
  id: string;
  installedAtUtc: string;
  /** Total bytes on disk (model + projector). */
  bytes: number;
}

/** Persisted resume state for an interrupted model download. */
export interface PendingDownload {
  modelId: string;
  /** Which file of the model (0 = weights, 1 = projector). */
  fileIndex: number;
  pause?: DownloadPauseState;
}

/** A meal being reviewed/edited before it is saved (in memory only). */
export interface MealDraft {
  /** Set when editing an existing meal. */
  mealId?: string;
  dateLocal: string;
  title: string;
  source: 'photo' | 'manual';
  items: LoggedFood[];
  /** Labels the model saw that matched nothing in the DB — the user maps them. */
  unmatched: DetectedFood[];
}

export interface FoodState {
  hydrated: boolean;
  meals: MealEntry[];
  settings: FoodSettings;
  installed: Record<string, InstalledModel>;
  pendingDownload?: PendingDownload;
  draft?: MealDraft;

  setSettings(patch: Partial<FoodSettings>): void;
  saveDraft(): MealEntry | undefined;
  removeMeal(id: string): void;
  setDraft(draft?: MealDraft): void;
  patchDraft(patch: Partial<MealDraft>): void;
  updateDraftItem(index: number, item: LoggedFood): void;
  addDraftItem(item: LoggedFood): void;
  removeDraftItem(index: number): void;
  setInstalled(model?: InstalledModel, removeId?: string): void;
  setPendingDownload(p?: PendingDownload): void;
}

export const DEFAULT_FOOD_SETTINGS: FoodSettings = {
  weightKg: 0,
  proteinGPerKg: DEFAULT_PROTEIN_G_PER_KG,
  kcalTarget: 0,
  modelId: 'gemma-4-e2b-q4',
};

const KEEP_DAYS = 400;

export const useFoodStore = create<FoodState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      meals: [],
      settings: DEFAULT_FOOD_SETTINGS,
      installed: {},
      pendingDownload: undefined,
      draft: undefined,

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
      saveDraft: () => {
        const d = get().draft;
        if (!d || d.items.length === 0) return undefined;
        const existing = d.mealId ? get().meals.find((m) => m.id === d.mealId) : undefined;
        const meal: MealEntry = {
          id: existing?.id ?? newId(),
          dateLocal: d.dateLocal,
          loggedAtUtc: existing?.loggedAtUtc ?? new Date().toISOString(),
          title: d.title.trim() || defaultMealTitle(new Date()),
          source: d.source,
          items: d.items,
        };
        const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
        set((s) => ({
          meals: [meal, ...s.meals.filter((m) => m.id !== meal.id && m.dateLocal >= cutoff)].sort((a, b) =>
            b.loggedAtUtc.localeCompare(a.loggedAtUtc),
          ),
          draft: undefined,
        }));
        return meal;
      },
      removeMeal: (id) => set((s) => ({ meals: s.meals.filter((m) => m.id !== id) })),
      setDraft: (draft) => set({ draft }),
      patchDraft: (patch) => set((s) => (s.draft ? { draft: { ...s.draft, ...patch } } : {})),
      updateDraftItem: (index, item) =>
        set((s) => (s.draft ? { draft: { ...s.draft, items: s.draft.items.map((it, i) => (i === index ? item : it)) } } : {})),
      addDraftItem: (item) => set((s) => (s.draft ? { draft: { ...s.draft, items: [...s.draft.items, item] } } : {})),
      removeDraftItem: (index) =>
        set((s) => (s.draft ? { draft: { ...s.draft, items: s.draft.items.filter((_, i) => i !== index) } } : {})),
      setInstalled: (model, removeId) =>
        set((s) => {
          const installed = { ...s.installed };
          if (removeId) delete installed[removeId];
          if (model) installed[model.id] = model;
          return { installed };
        }),
      setPendingDownload: (pendingDownload) => set({ pendingDownload }),
    }),
    {
      name: 'smartwake-food-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ meals: s.meals, settings: s.settings, installed: s.installed, pendingDownload: s.pendingDownload }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<FoodState>;
        return { ...current, ...p, settings: { ...DEFAULT_FOOD_SETTINGS, ...(p.settings ?? {}) } };
      },
      onRehydrateStorage: () => () => {
        useFoodStore.setState({ hydrated: true });
      },
    },
  ),
);

/** Device-local calendar date (the food day). */
export function todayLocal(tz?: string): string {
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  return localDateString(new Date(), zone);
}

export function defaultMealTitle(d: Date): string {
  const h = d.getHours();
  if (h < 11) return 'Breakfast';
  if (h < 16) return 'Lunch';
  if (h < 19) return 'Snack';
  return 'Dinner';
}

export function newDraft(source: MealDraft['source'], dateLocal: string): MealDraft {
  return { dateLocal, title: defaultMealTitle(new Date()), source, items: [], unmatched: [] };
}

/** Totals + targets for one day (selector helper). */
export function daySummary(meals: MealEntry[], settings: FoodSettings, dateLocal: string): {
  totals: Macros;
  proteinTargetG: number;
  meals: MealEntry[];
} {
  return {
    totals: dailyTotals(meals, dateLocal),
    proteinTargetG: proteinTarget(settings.weightKg, settings.proteinGPerKg),
    meals: meals.filter((m) => m.dateLocal === dateLocal),
  };
}
