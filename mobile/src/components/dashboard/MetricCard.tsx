import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MetricResult } from '@fitbit-air-tracker/core';
import { colors } from '../../theme';
import { CONFIDENCE_LABEL, fmtMetric, inputsSentence, methodLabel, status, TONE_ICON, type Tone } from './format';

/** Status word + icon, tinted. Color never carries the meaning alone. */
export function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <View style={[s.pill, { borderColor: status[tone] }]} accessible accessibilityLabel={`Status: ${label}`}>
      <Text style={[s.pillIcon, { color: status[tone] }]}>{TONE_ICON[tone]}</Text>
      <Text style={s.pillText}>{label}</Text>
    </View>
  );
}

/** Big headline number with a small unit and caption. */
export function BigNumber({ value, unit, caption }: { value: string; unit?: string; caption?: string }) {
  return (
    <View accessible accessibilityLabel={`${caption ? `${caption}: ` : ''}${value}${unit ? ` ${unit}` : ''}`}>
      <Text style={s.big}>
        {value}
        {unit ? <Text style={s.bigUnit}> {unit}</Text> : null}
      </Text>
      {caption ? <Text style={s.caption}>{caption}</Text> : null}
    </View>
  );
}

export function MiniStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <View style={s.mini} accessible accessibilityLabel={`${label}: ${value}${sub ? `. ${sub}` : ''}`}>
      <Text style={s.caption}>{label}</Text>
      <Text style={s.miniValue}>{value}</Text>
      {sub ? (
        <Text style={s.caption}>
          {tone ? <Text style={{ color: status[tone] }}>{TONE_ICON[tone]} </Text> : null}
          {sub}
        </Text>
      ) : null}
    </View>
  );
}

/** One-line plain-English meaning under the number. */
export function Meaning({ children }: PropsWithChildren) {
  return <Text style={s.meaning}>{children}</Text>;
}

/** Shown when the best result is only a rough estimate. */
export function LowConfidenceNote({ result }: { result?: MetricResult }) {
  if (!result || result.confidence !== 'low') return null;
  return (
    <Text style={s.lowConf}>
      {TONE_ICON.neutral} Rough estimate — some data hasn’t arrived yet. It will sharpen as your band syncs.
    </Text>
  );
}

export function EmptyNote({ children }: PropsWithChildren) {
  return <Text style={s.empty}>{children}</Text>;
}

/**
 * "How was this calculated?" — the chosen method, its confidence and inputs,
 * the plain-language explanation, and what the other methods said.
 */
export function HowCalculated({
  results,
  best,
  label = 'How was this calculated?',
}: {
  results?: MetricResult[];
  best?: MetricResult;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!best) return null;
  const others = (results ?? []).filter((r) => r.method !== best.method);
  return (
    <View style={s.how}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        hitSlop={8}
        style={s.howToggle}
      >
        <Text style={s.howToggleText}>{open ? '▾' : '▸'} {label}</Text>
      </Pressable>
      {open && (
        <View style={s.howBody}>
          <Text style={s.howText}>{best.explanation}</Text>
          <Row k="Method" v={methodLabel(best.method)} />
          <Row k="Confidence" v={CONFIDENCE_LABEL[best.confidence]} />
          <Row k="Used" v={inputsSentence(best.inputsUsed)} />
          {best.components && Object.keys(best.components).length > 0 && (
            <Row
              k="Parts"
              v={Object.entries(best.components)
                .map(([k, v]) => `${k} ${Math.round(v * 10) / 10}`)
                .join(' · ')}
            />
          )}
          {others.length > 0 && (
            <>
              <Text style={[s.howLabel, { marginTop: 8 }]}>Other methods</Text>
              {others.map((r) => (
                <View key={r.method} style={s.otherRow}>
                  <Text style={s.howText}>{methodLabel(r.method)}</Text>
                  <Text style={s.howValue}>
                    {fmtMetric(r)} · {r.confidence}
                  </Text>
                </View>
              ))}
            </>
          )}
          <Text style={s.disclaimer}>Wellness information, not a medical diagnosis.</Text>
        </View>
      )}
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.otherRow}>
      <Text style={s.howLabel}>{k}</Text>
      <Text style={[s.howValue, { flex: 1, textAlign: 'right' }]}>{v}</Text>
    </View>
  );
}

/** Card shell: title row with optional status pill, then body. */
export function MetricCard({
  title,
  pill,
  children,
  footer,
}: PropsWithChildren<{ title: string; pill?: { tone: Tone; label: string }; footer?: ReactNode }>) {
  return (
    <View style={s.card}>
      <View style={s.titleRow}>
        <Text style={s.title} accessibilityRole="header">
          {title}
        </Text>
        {pill ? <StatusPill {...pill} /> : null}
      </View>
      {children}
      {footer}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  title: { color: colors.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  pill: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  pillIcon: { fontSize: 11, marginRight: 4 },
  pillText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  big: { color: colors.text, fontSize: 48, fontWeight: '700', lineHeight: 54 },
  bigUnit: { color: colors.muted, fontSize: 18, fontWeight: '600' },
  caption: { color: colors.muted, fontSize: 12 },
  meaning: { color: colors.text, fontSize: 15, lineHeight: 21, marginTop: 6 },
  mini: { flex: 1, minWidth: 110, marginTop: 10 },
  miniValue: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 2 },
  lowConf: { color: colors.muted, fontSize: 12, marginTop: 6, fontStyle: 'italic' },
  empty: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 4 },
  how: { marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 8 },
  howToggle: { paddingVertical: 4 },
  howToggleText: { color: colors.accent2, fontSize: 13, fontWeight: '600' },
  howBody: { marginTop: 6 },
  howLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', marginRight: 10 },
  howText: { color: colors.text, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  howValue: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  otherRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 4 },
  disclaimer: { color: colors.muted, fontSize: 11, marginTop: 8 },
});
