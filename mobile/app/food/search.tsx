import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { suggestUnit, type FoodItem } from '@fitbit-air-tracker/core';
import { colors } from '../../src/theme';
import { useFoodStore } from '../../src/foodStore';
import { foodHeader } from '../../src/services/food/ui';
import { defaultPortion, loggedFood, relog } from '../../src/services/food/draft';
import { POPULAR_FOODS, searchFoodDb, sourceLabel } from '../../src/services/food/foodDb';

/**
 * Food search over the bundled DB (English, transliterated Arabic or Arabic).
 * Modes: add a new line, replace the food of line `index`, or map the
 * unrecognised photo label `index`.
 */
export default function SearchScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string; index?: string; q?: string }>();
  const mode = (params.mode ?? 'add') as 'add' | 'replace' | 'unmatched';
  const index = Number(params.index ?? -1);
  const [q, setQ] = useState(params.q ?? '');
  const draft = useFoodStore((s) => s.draft);
  const addItem = useFoodStore((s) => s.addDraftItem);
  const updateItem = useFoodStore((s) => s.updateDraftItem);
  const patchDraft = useFoodStore((s) => s.patchDraft);

  const results: FoodItem[] = useMemo(() => (q.trim() ? searchFoodDb(q, 40).map((m) => m.food) : POPULAR_FOODS), [q]);

  const choose = (food: FoodItem) => {
    if (!draft) return router.back();
    if (mode === 'replace' && draft.items[index]) {
      const prev = draft.items[index]!;
      const { quantity, unit } = suggestUnit(food, prev.grams);
      updateItem(index, relog(prev, food, quantity, unit));
    } else if (mode === 'unmatched' && draft.unmatched[index]) {
      const det = draft.unmatched[index]!;
      const { quantity, unit } = suggestUnit(food, det.estGrams);
      addItem(loggedFood(food, quantity, unit, { aiLabel: det.label, aiConfidence: det.confidence }));
      patchDraft({ unmatched: draft.unmatched.filter((_, j) => j !== index) });
    } else {
      const { quantity, unit } = defaultPortion(food);
      addItem(loggedFood(food, quantity, unit));
    }
    router.back();
  };

  return (
    <View style={st.screen}>
      <Stack.Screen options={{ ...foodHeader, title: 'Find food' }} />
      <TextInput
        value={q}
        onChangeText={setQ}
        autoFocus
        placeholder="Search: kabsa, لبن, chicken breast, dates…"
        placeholderTextColor={colors.muted}
        style={st.input}
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
      />
      {!q.trim() && <Text style={st.hint}>Common foods</Text>}
      <FlatList
        data={results}
        keyExtractor={(f) => f.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Text style={st.hint}>No match. Try a simpler word (e.g. “rice”, “chicken”).</Text>}
        renderItem={({ item: f }) => (
          <Pressable onPress={() => choose(f)} style={({ pressed }) => [st.row, pressed && { opacity: 0.6 }]}>
            <View style={{ flex: 1 }}>
              <Text style={st.name} numberOfLines={2}>
                {f.name}
              </Text>
              {f.nameAr ? <Text style={st.ar}>{f.nameAr}</Text> : null}
              <Text style={st.meta}>
                per 100 g: {Math.round(f.per100g.kcal)} kcal · P {f.per100g.protein} g · {sourceLabel(f)}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 12 },
  input: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 10, color: colors.text, padding: 12, fontSize: 16 },
  hint: { color: colors.muted, fontSize: 13, marginTop: 10, marginBottom: 4 },
  row: { paddingVertical: 10, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { color: colors.text, fontSize: 15, fontWeight: '600' },
  ar: { color: colors.muted, fontSize: 14, marginTop: 1 },
  meta: { color: colors.muted, fontSize: 12, marginTop: 2 },
});
