import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { macroProgress, mealTotals, type MealEntry } from '@fitbit-air-tracker/core';
import { Button, Card, H2, Muted, Screen, Stat, Stepper } from '../../src/components/ui';
import { colors } from '../../src/theme';
import { daySummary, newDraft, todayLocal, useFoodStore } from '../../src/foodStore';
import { isModelInstalled, useModelRuntime } from '../../src/services/food/modelManager';
import { fmtBytes, modelById } from '../../src/services/food/models';
import { MacroLine, ProgressBar, fmt1, fmtQty, foodStyles } from '../../src/services/food/ui';

function shiftDate(dateLocal: string, days: number): string {
  const d = new Date(`${dateLocal}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayLabel(dateLocal: string, today: string): string {
  if (dateLocal === today) return 'Today';
  if (dateLocal === shiftDate(today, -1)) return 'Yesterday';
  return new Date(`${dateLocal}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function FoodScreen() {
  const router = useRouter();
  const today = todayLocal();
  const [date, setDate] = useState(today);
  const meals = useFoodStore((s) => s.meals);
  const settings = useFoodStore((s) => s.settings);
  const setSettings = useFoodStore((s) => s.setSettings);
  const setDraft = useFoodStore((s) => s.setDraft);
  const removeMeal = useFoodStore((s) => s.removeMeal);
  const installed = useFoodStore((s) => s.installed);
  const pending = useFoodStore((s) => s.pendingDownload);
  const runtime = useModelRuntime();
  const { totals, proteinTargetG, meals: dayMeals } = useMemo(() => daySummary(meals, settings, date), [meals, settings, date]);
  const model = modelById(settings.modelId);
  const modelReady = useMemo(() => isModelInstalled(settings.modelId), [settings.modelId, installed]);

  const editMeal = (m: MealEntry) => {
    setDraft({ mealId: m.id, dateLocal: m.dateLocal, title: m.title, source: m.source, items: m.items, unmatched: [] });
    router.push('/food/review');
  };
  const confirmDelete = (m: MealEntry) =>
    Alert.alert('Delete meal?', `${m.title} · ${Math.round(mealTotals(m).kcal)} kcal`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => removeMeal(m.id) },
    ]);

  return (
    <Screen title="Food">
      <View style={[foodStyles.rowBetween, { marginTop: 2 }]}>
        <Pressable accessibilityLabel="Previous day" onPress={() => setDate(shiftDate(date, -1))} hitSlop={12}>
          <Text style={st.arrow}>‹</Text>
        </Pressable>
        <Text style={st.day}>{dayLabel(date, today)}</Text>
        <Pressable accessibilityLabel="Next day" disabled={date >= today} onPress={() => setDate(shiftDate(date, 1))} hitSlop={12}>
          <Text style={[st.arrow, date >= today && { opacity: 0.25 }]}>›</Text>
        </Pressable>
      </View>

      <Card>
        <Text style={st.label}>Protein</Text>
        {proteinTargetG > 0 ? (
          <>
            <Text style={foodStyles.bigNumber}>
              {Math.round(totals.protein)} <Text style={st.of}>/ {proteinTargetG} g</Text>
            </Text>
            <ProgressBar value={macroProgress(totals.protein, proteinTargetG)} color={totals.protein >= proteinTargetG ? colors.ok : colors.accent2} />
            <Muted>
              {totals.protein >= proteinTargetG
                ? 'Target reached for the day.'
                : `${Math.max(0, Math.round(proteinTargetG - totals.protein))} g to go · target ${fmt1(settings.proteinGPerKg)} g/kg × ${settings.weightKg} kg`}
            </Muted>
          </>
        ) : (
          <>
            <Text style={foodStyles.bigNumber}>{Math.round(totals.protein)} g</Text>
            <Muted>Set your body weight below to get a daily protein target.</Muted>
          </>
        )}
      </Card>

      <Card>
        <Text style={st.label}>Energy</Text>
        <Text style={foodStyles.bigNumber}>
          {Math.round(totals.kcal)} <Text style={st.of}>{settings.kcalTarget > 0 ? `/ ${settings.kcalTarget} kcal` : 'kcal'}</Text>
        </Text>
        {settings.kcalTarget > 0 && <ProgressBar value={macroProgress(totals.kcal, settings.kcalTarget)} color={colors.accent} />}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <Stat label="Carbs" value={`${Math.round(totals.carbs)} g`} />
          <Stat label="Fat" value={`${Math.round(totals.fat)} g`} />
          <Stat label="Fiber" value={`${Math.round(totals.fiber)} g`} />
        </View>
      </Card>

      <Button
        title="📷  Add meal from photo"
        onPress={() => {
          setDraft(undefined);
          router.push({ pathname: '/food/photo', params: { date } });
        }}
      />
      <Button
        title="Add manually"
        kind="secondary"
        onPress={() => {
          setDraft(newDraft('manual', date));
          router.push('/food/review');
        }}
      />

      <H2>Meals</H2>
      {dayMeals.length === 0 && <Muted>No meals logged {date === today ? 'yet today' : 'this day'}.</Muted>}
      {dayMeals.map((m) => {
        const t = mealTotals(m);
        return (
          <Pressable key={m.id} onPress={() => editMeal(m)} onLongPress={() => confirmDelete(m)}>
            <Card>
              <View style={foodStyles.rowBetween}>
                <Text style={foodStyles.itemTitle}>
                  {m.title}
                  {m.source === 'photo' ? '  📷' : ''}
                </Text>
                <Text style={st.time}>{new Date(m.loggedAtUtc).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
              </View>
              <MacroLine m={t} />
              {m.items.map((it, i) => (
                <Text key={`${it.foodId}-${i}`} style={st.itemLine} numberOfLines={1}>
                  • {it.name} — {fmtQty(it.quantity, it.unit)} ({Math.round(it.grams)} g) · {Math.round(it.macros.kcal)} kcal · P {fmt1(it.macros.protein)}
                </Text>
              ))}
              <View style={[foodStyles.rowBetween, { marginTop: 8 }]}>
                <Text style={foodStyles.link}>Edit</Text>
                <Pressable onPress={() => confirmDelete(m)} hitSlop={10}>
                  <Text style={[foodStyles.link, { color: colors.danger }]}>Delete</Text>
                </Pressable>
              </View>
            </Card>
          </Pressable>
        );
      })}

      <H2>Targets</H2>
      <Card>
        <Stepper label="Body weight" value={settings.weightKg} onChange={(v) => setSettings({ weightKg: settings.weightKg === 0 && v > 0 ? 70 : v < 30 ? 0 : v })} step={1} min={0} max={250} unit="kg" />
        <Stepper
          label="Protein per kg"
          value={settings.proteinGPerKg}
          onChange={(v) => setSettings({ proteinGPerKg: Math.round(v * 10) / 10 })}
          step={0.1}
          min={0.8}
          max={3}
          unit="g/kg"
        />
        <Stepper label="Energy target (optional)" value={settings.kcalTarget} onChange={(v) => setSettings({ kcalTarget: v })} step={50} min={0} max={6000} unit="kcal" />
        <Muted>
          Default 1.6 g/kg suits most people who train; 1.2–2.2 g/kg is the common range. This is general guidance, not medical advice.
        </Muted>
      </Card>

      <H2>On-device food recognition</H2>
      <Pressable onPress={() => router.push('/food/model')}>
        <Card>
          <View style={foodStyles.rowBetween}>
            <Text style={foodStyles.itemTitle}>{model.title}</Text>
            <Text style={[st.badge, { color: modelReady ? colors.ok : colors.muted }]}>
              {modelReady
                ? 'Ready'
                : runtime.status === 'downloading'
                  ? `${Math.round((runtime.bytesDone / Math.max(1, runtime.bytesTotal)) * 100)}%`
                  : runtime.status === 'verifying'
                    ? 'Verifying'
                    : pending
                      ? 'Paused'
                      : 'Not downloaded'}
            </Text>
          </View>
          <Muted>
            {modelReady
              ? 'Photos are analysed on this iPhone. They never leave the device.'
              : `Optional ${fmtBytes(model.files[0].bytes + model.files[1].bytes)} download (Wi-Fi recommended). Manual logging works without it.`}
          </Muted>
          <Text style={[foodStyles.link, { marginTop: 8 }]}>Manage model ›</Text>
        </Card>
      </Pressable>

      <Muted>
        {'\n'}Photo estimates can be off by ±40% — adjust portions or weigh food for accuracy. Nutrition values: USDA FoodData Central (public
        domain) plus clearly-marked recipe estimates for regional dishes.
      </Muted>
    </Screen>
  );
}

const st = StyleSheet.create({
  arrow: { color: colors.text, fontSize: 30, paddingHorizontal: 12 },
  day: { color: colors.text, fontSize: 17, fontWeight: '600' },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  of: { color: colors.muted, fontSize: 16, fontWeight: '500' },
  time: { color: colors.muted, fontSize: 13 },
  itemLine: { color: colors.text, fontSize: 13, marginTop: 4 },
  badge: { fontSize: 13, fontWeight: '700' },
});
