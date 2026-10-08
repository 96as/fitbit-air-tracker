import { useEffect } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { sumMacros } from '@fitbit-air-tracker/core';
import { Button, Card, Field, H2, Muted } from '../../src/components/ui';
import { colors } from '../../src/theme';
import { useFoodStore } from '../../src/foodStore';
import { relog } from '../../src/services/food/draft';
import { foodById, sourceLabel } from '../../src/services/food/foodDb';
import { MacroLine, PortionEditor, foodStyles, foodHeader } from '../../src/services/food/ui';

export default function ReviewScreen() {
  const router = useRouter();
  const draft = useFoodStore((s) => s.draft);
  const patchDraft = useFoodStore((s) => s.patchDraft);
  const updateItem = useFoodStore((s) => s.updateDraftItem);
  const removeItem = useFoodStore((s) => s.removeDraftItem);
  const saveDraft = useFoodStore((s) => s.saveDraft);
  const setDraft = useFoodStore((s) => s.setDraft);

  useEffect(() => {
    if (!draft) router.back();
  }, [draft, router]);
  if (!draft) return null;

  const totals = sumMacros(draft.items.map((i) => i.macros));
  const fromPhoto = draft.source === 'photo';

  const save = () => {
    if (draft.unmatched.length > 0) {
      Alert.alert('Some foods are not mapped', 'Unmapped items are not counted. Save anyway?', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Save', onPress: doSave },
      ]);
      return;
    }
    doSave();
  };
  // Saving clears the draft; the effect above then pops back to the Food tab.
  const doSave = () => {
    saveDraft();
  };

  return (
    <ScrollView contentContainerStyle={st.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ ...foodHeader, title: 'Review meal' }} />
      {fromPhoto && (
        <View style={foodStyles.caveat}>
          <Text style={foodStyles.caveatText}>
            Photo estimates can be off by ±40%. Check each food and adjust the portion — or weigh it for accuracy.
          </Text>
        </View>
      )}

      <Field label="Meal name" value={draft.title} onChangeText={(title) => patchDraft({ title })} placeholder="Lunch" />

      {draft.items.length === 0 && draft.unmatched.length === 0 && (
        <Card>
          <Muted>{fromPhoto ? 'The model did not find any food in the photo.' : 'No foods yet.'} Add them with “Add food”.</Muted>
        </Card>
      )}

      {draft.items.map((item, index) => {
        const food = foodById(item.foodId);
        return (
          <Card key={`${item.foodId}-${index}`}>
            <View style={foodStyles.rowBetween}>
              <Pressable
                style={{ flex: 1, paddingRight: 8 }}
                onPress={() => router.push({ pathname: '/food/search', params: { mode: 'replace', index: String(index), q: item.aiLabel ?? '' } })}
              >
                <Text style={foodStyles.itemTitle}>{item.name}</Text>
                {food?.nameAr ? <Text style={st.ar}>{food.nameAr}</Text> : null}
                <Text style={st.hint}>
                  {item.aiLabel ? `AI saw “${item.aiLabel}”${item.aiConfidence !== undefined ? ` · ${Math.round(item.aiConfidence * 100)}% sure` : ''} · ` : ''}
                  tap to change food
                </Text>
              </Pressable>
              <Pressable accessibilityLabel={`Remove ${item.name}`} onPress={() => removeItem(index)} hitSlop={10}>
                <Text style={st.remove}>✕</Text>
              </Pressable>
            </View>
            {food ? (
              <PortionEditor food={food} item={item} onChange={(q, u) => updateItem(index, relog(item, food, q, u))} />
            ) : (
              <Muted>This food is no longer in the database; its saved values are kept.</Muted>
            )}
            <MacroLine m={item.macros} grams={item.grams} />
            {food && <Text style={st.source}>{sourceLabel(food)}</Text>}
          </Card>
        );
      })}

      {draft.unmatched.length > 0 && <H2>Not recognised in the food list</H2>}
      {draft.unmatched.map((u, i) => (
        <Card key={`${u.label}-${i}`}>
          <View style={foodStyles.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={foodStyles.itemTitle}>“{u.label}”</Text>
              <Muted>≈ {u.estGrams} g · not counted until you pick a match</Muted>
            </View>
            <Pressable
              onPress={() => patchDraft({ unmatched: draft.unmatched.filter((_, j) => j !== i) })}
              hitSlop={10}
              accessibilityLabel={`Ignore ${u.label}`}
            >
              <Text style={st.remove}>✕</Text>
            </Pressable>
          </View>
          <Button
            title="Find a match"
            kind="secondary"
            onPress={() => router.push({ pathname: '/food/search', params: { mode: 'unmatched', index: String(i), q: u.label } })}
          />
        </Card>
      ))}

      <Button title="＋ Add food" kind="secondary" onPress={() => router.push({ pathname: '/food/search', params: { mode: 'add' } })} />

      <Card>
        <Text style={st.totalLabel}>Meal total</Text>
        <Text style={foodStyles.bigNumber}>
          {Math.round(totals.kcal)} kcal · {Math.round(totals.protein)} g protein
        </Text>
        <MacroLine m={totals} />
      </Card>

      <Button title={draft.mealId ? 'Save changes' : 'Save meal'} onPress={save} disabled={draft.items.length === 0} />
      <Button
        title="Cancel"
        kind="secondary"
        onPress={() => {
          setDraft(undefined);
        }}
      />
    </ScrollView>
  );
}

const st = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  ar: { color: colors.muted, fontSize: 14, marginTop: 2 },
  hint: { color: colors.accent2, fontSize: 12, marginTop: 3 },
  remove: { color: colors.muted, fontSize: 18, padding: 4 },
  source: { color: colors.muted, fontSize: 11, marginTop: 4 },
  totalLabel: { color: colors.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
});
