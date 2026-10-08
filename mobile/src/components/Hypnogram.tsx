import { Text, View } from 'react-native';
import type { SleepSession } from '@fitbit-air-tracker/core';
import { colors, fmtDate, fmtTime } from '../theme';

const minutes = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 60_000;

export function Hypnogram({ session, tz }: { session: SleepSession; tz: string }) {
  const total = session.stages.reduce((s, seg) => s + minutes(seg.startUtc, seg.endUtc), 0);
  const totals = session.stages.reduce<Record<string, number>>((acc, seg) => {
    acc[seg.stage] = (acc[seg.stage] ?? 0) + minutes(seg.startUtc, seg.endUtc);
    return acc;
  }, {});
  return (
    <View>
      <Text style={{ color: colors.muted, fontSize: 12 }}>
        {fmtDate(session.startUtc, tz)} · {fmtTime(session.startUtc, tz)}–{fmtTime(session.endUtc, tz)}
        {session.efficiencyPct != null ? ` · ${session.efficiencyPct}% efficiency` : ''}
        {session.source === 'mock' ? ' · simulated' : ''}
      </Text>
      <View style={{ flexDirection: 'row', height: 30, borderRadius: 6, overflow: 'hidden', marginVertical: 8 }}>
        {session.stages.map((seg, i) => (
          <View key={i} style={{ flex: minutes(seg.startUtc, seg.endUtc) / total, backgroundColor: colors.stage[seg.stage] }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {Object.entries(totals).map(([stage, mins]) => (
          <Text key={stage} style={{ color: colors.muted, fontSize: 12, marginRight: 12 }}>
            <Text style={{ color: colors.stage[stage] }}>● </Text>
            {stage} {Math.round(mins)} min
          </Text>
        ))}
      </View>
    </View>
  );
}
