import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type AccessibilityActionEvent, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { colors } from '../../theme';

/**
 * Shared bits for the lightweight react-native-svg charts.
 * Spec (dataviz skill): one series hue, recessive hairline grid, 2px lines,
 * ≤24px bars with a 4px rounded data-end, ≥8px markers with a 2px surface ring,
 * tap/scrub to read a value (hit target = the whole column), and an
 * accessible summary + adjustable actions so VoiceOver can step through points.
 */

export interface Datum {
  /** Stable key, e.g. the local date. */
  key: string;
  /** Short x label, e.g. 'Mon' or '7 Oct'. */
  label: string;
  /** Long label for the readout, e.g. 'Mon 7 Oct'. */
  longLabel: string;
  value: number | null;
}

export interface RefLine {
  value: number;
  label: string;
}

export const PAD = { left: 34, right: 8, top: 8, bottom: 20 };
export const SURFACE = colors.panel;

export function useWidth(initial = 300) {
  const [width, setWidth] = useState(initial);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w > 0) setWidth(w);
  }, []);
  return { width, onLayout };
}

/** Clean axis ticks (1/2/2.5/5 × 10^n) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 3): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

export function domainFor(
  values: (number | null)[],
  extra: number[] = [],
  fixed?: [number, number],
  zeroBased = false,
  fixedTicks?: number[],
  /** Smallest y-span to show, so tiny wiggles don't look dramatic. */
  minSpan = 0,
) {
  if (fixed) return { lo: fixed[0], hi: fixed[1], ticks: fixedTicks ?? niceTicks(fixed[0], fixed[1], 3) };
  const vs = [...values.filter((v): v is number => v != null), ...extra];
  let min = zeroBased ? 0 : Math.min(...vs);
  let max = Math.max(...vs);
  if (vs.length && max - min < minSpan) {
    const mid = (max + min) / 2;
    min = zeroBased ? 0 : mid - minSpan / 2;
    max = zeroBased ? Math.max(max, minSpan) : mid + minSpan / 2;
  }
  const ticks = niceTicks(vs.length ? min : 0, vs.length ? max : 1, 3);
  return { lo: ticks[0]!, hi: ticks[ticks.length - 1]!, ticks };
}

/** Index under the finger (nearest column), or the latest valued point by default. */
export function useSelection(data: Datum[], plotLeft: number, plotWidth: number) {
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const latest = useMemo(() => {
    for (let i = data.length - 1; i >= 0; i--) if (data[i]!.value != null) return i;
    return data.length - 1;
  }, [data]);
  const step = data.length ? plotWidth / data.length : plotWidth;
  const pick = (x: number) => {
    const i = Math.floor((x - plotLeft) / step);
    setSelected(Math.max(0, Math.min(data.length - 1, i)));
  };
  const touch = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    // Let a vertical page scroll win over a scrub.
    onResponderTerminationRequest: () => true,
    onResponderGrant: (e: GestureResponderEvent) => pick(e.nativeEvent.locationX),
    onResponderMove: (e: GestureResponderEvent) => pick(e.nativeEvent.locationX),
  };
  const a11yActions = [
    { name: 'increment' as const, label: 'Next day' },
    { name: 'decrement' as const, label: 'Previous day' },
  ];
  const onA11yAction = (e: AccessibilityActionEvent) => {
    const cur = selected ?? latest;
    if (e.nativeEvent.actionName === 'increment') setSelected(Math.min(data.length - 1, cur + 1));
    if (e.nativeEvent.actionName === 'decrement') setSelected(Math.max(0, cur - 1));
  };
  return { selected, active: selected ?? latest, touched: selected != null, touch, a11yActions, onA11yAction, step };
}

/** Value-led readout above the plot: "7 h 12 m  · Mon 7 Oct". */
export function Readout({ datum, format }: { datum?: Datum; format: (v: number) => string }) {
  if (!datum) return <View style={st.readout} />;
  return (
    <View style={st.readout}>
      <Text style={st.readoutValue}>{datum.value == null ? 'No data' : format(datum.value)}</Text>
      <Text style={st.readoutLabel}>{datum.longLabel}</Text>
    </View>
  );
}

/** Key for the reference line, under the plot so it never covers data. */
export function RefKey({ label }: { label: string }) {
  return (
    <View style={st.refKey}>
      <View style={st.refSwatch} />
      <Text style={st.readoutLabel}>{label}</Text>
    </View>
  );
}

/** Which x labels to print: every one for ≤7 points, else first / middle / last. */
export function xLabelIndexes(n: number): number[] {
  if (n <= 7) return [...Array(n).keys()];
  return [0, Math.floor((n - 1) / 2), n - 1];
}

export function summarize(title: string, data: Datum[], format: (v: number) => string): string {
  const vals = data.filter((d) => d.value != null) as (Datum & { value: number })[];
  if (!vals.length) return `${title}: no data for this period.`;
  const avg = vals.reduce((a, d) => a + d.value, 0) / vals.length;
  const min = vals.reduce((a, d) => (d.value < a.value ? d : a));
  const max = vals.reduce((a, d) => (d.value > a.value ? d : a));
  const last = vals[vals.length - 1]!;
  return `${title}, ${data.length} days. Latest ${format(last.value)} on ${last.longLabel}. Average ${format(avg)}. Lowest ${format(min.value)} on ${min.longLabel}; highest ${format(max.value)} on ${max.longLabel}. ${data.length - vals.length} days without data. Swipe up or down to step through days.`;
}

const st = StyleSheet.create({
  readout: { flexDirection: 'row', alignItems: 'baseline', minHeight: 30, marginBottom: 2 },
  readoutValue: { color: colors.text, fontSize: 24, fontWeight: '700', marginRight: 8 },
  readoutLabel: { color: colors.muted, fontSize: 12 },
  refKey: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  refSwatch: { width: 16, height: 2, backgroundColor: colors.muted, marginRight: 6, borderRadius: 1 },
});
