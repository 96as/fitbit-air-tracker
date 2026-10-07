import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme';
import type { Datum } from '../charts';

/**
 * One small multiple on the Trends tab: title, the chart (its readout shows the
 * latest / selected day as the big number), a one-line meaning, and a
 * "Show numbers" table (the non-visual way to read every value).
 */
export function TrendPanel({
  title,
  meaning,
  chart,
  data,
  format,
}: {
  title: string;
  meaning: string;
  chart: ReactNode;
  data: Datum[];
  format: (v: number) => string;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <View style={s.card}>
      <Text style={s.title} accessibilityRole="header">
        {title}
      </Text>
      <View style={{ marginTop: 6 }}>{chart}</View>
      <Text style={s.meaning}>{meaning}</Text>
      <Pressable
        onPress={() => setShowTable((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: showTable }}
        hitSlop={8}
        style={{ marginTop: 6, alignSelf: 'flex-start' }}
      >
        <Text style={s.toggle}>{showTable ? '▾ Hide numbers' : '▸ Show numbers'}</Text>
      </Pressable>
      {showTable && (
        <View style={s.table}>
          {[...data].reverse().map((d) => (
            <View key={d.key} style={s.row}>
              <Text style={s.cellLabel}>{d.longLabel}</Text>
              <Text style={s.cellValue}>{d.value == null ? '—' : format(d.value)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 10 },
  title: { color: colors.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  meaning: { color: colors.text, fontSize: 14, lineHeight: 20, marginTop: 6 },
  toggle: { color: colors.accent2, fontSize: 13, fontWeight: '600' },
  table: { marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  cellLabel: { color: colors.muted, fontSize: 13 },
  cellValue: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
});
