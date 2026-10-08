import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  PORTION_UNITS,
  UNIT_LABELS,
  gramsPerUnit,
  stepFor,
  type FoodItem,
  type LoggedFood,
  type Macros,
  type PortionUnit,
} from '@fitbit-air-tracker/core';
import { colors } from '../../theme';

/** Small presentational pieces shared by the Food tab and the food/* screens. */

export function ProgressBar({ value, color = colors.accent2 }: { value: number; color?: string }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={s.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}>
      <View style={[s.fill, { width: `${pct * 100}%`, backgroundColor: color }]} />
    </View>
  );
}

export function MacroLine({ m, grams }: { m: Macros; grams?: number }) {
  return (
    <Text style={s.macroLine}>
      {grams !== undefined ? `${Math.round(grams)} g · ` : ''}
      {Math.round(m.kcal)} kcal · P {fmt1(m.protein)} g · C {fmt1(m.carbs)} g · F {fmt1(m.fat)} g
    </Text>
  );
}

export const fmt1 = (n: number) => (Math.round(n * 10) / 10).toString();

export function fmtQty(q: number, unit: PortionUnit): string {
  const n = Number.isInteger(q) ? q.toString() : q.toFixed(q < 1 ? 2 : 1).replace(/0+$/, '').replace(/\.$/, '');
  return `${n} ${UNIT_LABELS[unit]}`;
}

/** Units worth offering for this food (keeps the chip row short). */
export function unitsFor(food: FoodItem): PortionUnit[] {
  const has = (re: RegExp) => food.portions?.some((p) => re.test(p.label)) ?? false;
  const out: PortionUnit[] = ['g'];
  if (has(/piece|medium|each|item|whole|sandwich|patty|ball|date|fruit|egg|roll|wrap|bar|cookie|pastry|large|small|skewer|finjan|bottle/i)) out.push('piece');
  if (has(/slice/i)) out.push('slice');
  if (food.category === 'beverage' || food.category === 'dairy' || food.category === 'sauce') out.push('ml');
  out.push('cup');
  if (['fat', 'sauce', 'sweet', 'dairy', 'snack'].includes(food.category)) out.push('tbsp', 'tsp');
  if (['mixed', 'grain', 'legume', 'protein', 'vegetable'].includes(food.category)) out.push('plate');
  if (food.category === 'protein' || food.category === 'mixed') out.push('palm');
  if (['grain', 'legume', 'vegetable', 'fruit', 'mixed'].includes(food.category)) out.push('fist');
  if (['snack', 'fruit', 'sweet'].includes(food.category)) out.push('handful');
  out.push('oz');
  return PORTION_UNITS.filter((u) => out.includes(u));
}

/** Quantity stepper + unit chips for one logged food. */
export function PortionEditor({
  food,
  item,
  onChange,
}: {
  food: FoodItem;
  item: LoggedFood;
  onChange: (quantity: number, unit: PortionUnit) => void;
}) {
  const step = stepFor(item.unit);
  const min = step;
  const round = (n: number) => Math.round(n * 100) / 100;
  return (
    <View>
      <View style={s.row}>
        <Pressable accessibilityLabel="Less" onPress={() => onChange(round(Math.max(min, item.quantity - step)), item.unit)} style={s.stepBtn}>
          <Text style={s.stepTxt}>−</Text>
        </Pressable>
        <Text style={s.qty}>{fmtQty(item.quantity, item.unit)}</Text>
        <Pressable accessibilityLabel="More" onPress={() => onChange(round(item.quantity + step), item.unit)} style={s.stepBtn}>
          <Text style={s.stepTxt}>+</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
        {unitsFor(food).map((u) => (
          <Pressable
            key={u}
            onPress={() => {
              if (u === item.unit) return;
              // keep the same grams when switching units, rounded to a sensible step
              const per = gramsPerUnit(food, u);
              const st = u === 'g' || u === 'ml' ? 1 : stepFor(u);
              const q = Math.max(st, Math.round(item.grams / per / st) * st);
              onChange(round(q), u);
            }}
            style={[s.chip, u === item.unit && s.chipOn]}
          >
            <Text style={[s.chipTxt, u === item.unit && s.chipTxtOn]}>{UNIT_LABELS[u]}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export const foodStyles = StyleSheet.create({
  caveat: {
    backgroundColor: '#3b2f0b',
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
  },
  caveatText: { color: colors.accent, fontSize: 13, lineHeight: 18 },
  itemTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  bigNumber: { color: colors.text, fontSize: 28, fontWeight: '700' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { color: colors.accent2, fontSize: 14, fontWeight: '600' },
});

const s = StyleSheet.create({
  track: { height: 10, borderRadius: 5, backgroundColor: colors.bg, overflow: 'hidden', marginTop: 8 },
  fill: { height: 10, borderRadius: 5 },
  macroLine: { color: colors.muted, fontSize: 13, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  stepBtn: { width: 40, height: 36, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stepTxt: { color: colors.text, fontSize: 20 },
  qty: { color: colors.text, fontSize: 16, minWidth: 110, textAlign: 'center', fontWeight: '600' },
  chip: { borderRadius: 999, borderWidth: 1, borderColor: colors.border, paddingVertical: 5, paddingHorizontal: 11, marginRight: 6 },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipTxt: { color: colors.text, fontSize: 13 },
  chipTxtOn: { color: '#0f172a', fontWeight: '700' },
});

/** Native header for the food/* screens (they live on the root stack, which hides headers by default). */
export const foodHeader = {
  headerShown: true,
  headerStyle: { backgroundColor: colors.panel },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text },
  headerBackTitle: 'Back',
  contentStyle: { backgroundColor: colors.bg },
} as const;
