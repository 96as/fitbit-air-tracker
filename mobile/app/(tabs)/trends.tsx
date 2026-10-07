import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { MetricsReport, NightData } from '@fitbit-air-tracker/core';
import { Card, Muted, Screen } from '../../src/components/ui';
import { BarChart, LineChart, type Datum } from '../../src/components/charts';
import { TrendPanel } from '../../src/components/dashboard/TrendPanel';
import { BASELINE_NIGHTS, bestValue, fmtMinutes, fmtNum, recoveryVerdict, sleepScoreVerdict, type BaselineKey } from '../../src/components/dashboard/format';
import { DEFAULT_SLEEP_NEED_MIN, useDashboardData } from '../../src/services/dashboardData';
import { moodsOnDate, MOOD_LABELS } from '../../src/moodStore';
import { useStore } from '../../src/store';
import { colors } from '../../src/theme';

type Range = 7 | 30;

const dayDate = (dateLocal: string) => new Date(`${dateLocal}T12:00:00Z`);
const shortLabel = (d: string, range: Range) =>
  range === 7
    ? dayDate(d).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' })
    : dayDate(d).toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longLabel = (d: string) => dayDate(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const avgOf = (data: Datum[]) => {
  const v = data.map((d) => d.value).filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 0–100 scores: show 40–100 when everything fits (less dramatic swings), else the full range. */
const scoreAxis = (data: Datum[]): { domain: [number, number]; ticks: number[] } =>
  data.every((d) => d.value == null || d.value >= 40) ? { domain: [40, 100], ticks: [40, 70, 100] } : { domain: [0, 100], ticks: [0, 50, 100] };

export default function TrendsScreen() {
  const tz = useStore((s) => s.settings.tz);
  const dash = useDashboardData();
  const [range, setRange] = useState<Range>(7);

  const view = useMemo(() => {
    const nights: NightData[] = dash.nights.slice(-range);
    const reports: MetricsReport[] = dash.reports.slice(-range);
    const byDate = new Map(reports.map((r) => [r.dateLocal, r]));
    const series = (pick: (n: NightData, r?: MetricsReport) => number | undefined | null): Datum[] =>
      nights.map((n) => {
        const v = pick(n, byDate.get(n.dateLocal));
        return { key: n.dateLocal, label: shortLabel(n.dateLocal, range), longLabel: longLabel(n.dateLocal), value: v == null ? null : v };
      });
    const latestReport = dash.reports[dash.reports.length - 1];
    const needMin = latestReport?.best.sleepDebt?.components?.needMin ?? DEFAULT_SLEEP_NEED_MIN;
    const recDays = reports.flatMap((r) => {
      const rec = r.best.recovery;
      return rec?.value != null ? [recoveryVerdict(rec.value, rec.label).label] : [];
    });
    return {
      recDays,
      latestReport,
      needMin,
      sleepHours: series((_, r) => {
        const m = bestValue(r, 'sleepDuration');
        return m == null ? null : m / 60;
      }),
      score: series((_, r) => bestValue(r, 'sleepScore')),
      recovery: series((_, r) => bestValue(r, 'recovery')),
      rhr: series((n) => n.restingHrBpm),
      hrv: series((n) => n.dailyHrv?.rmssdMs),
      breathing: series((n, r) => bestValue(r, 'breathing') ?? n.respiratory?.fullSleepBrpm),
      mood: series((n) => {
        const m = moodsOnDate(dash.moods, n.dateLocal, tz);
        return m.length ? m.reduce((a, e) => a + e.score, 0) / m.length : null;
      }),
    };
  }, [dash, range, tz]);

  if (dash.loading) {
    return (
      <Screen title="Trends">
        <ActivityIndicator color={colors.muted} style={{ marginTop: 40 }} />
      </Screen>
    );
  }

  const b = view.latestReport?.baselines;
  const hours = (h: number) => fmtMinutes(h * 60);
  const sleepAvg = avgOf(view.sleepHours);
  const scoreAvg = avgOf(view.score);
  const recAvg = avgOf(view.recovery);
  const recDays = view.recDays;
  /** Reference-line label: "your normal 58", or "learning 9/14" while the baseline is young. */
  const normalLabel = (key: BaselineKey, v: number, digits = 0) => {
    const n = b?.counts?.[key];
    return n != null && n < BASELINE_NIGHTS ? `your normal ${fmtNum(v, digits)} (learning ${n}/${BASELINE_NIGHTS})` : `your normal ${fmtNum(v, digits)}`;
  };
  const rhrAvg = avgOf(view.rhr);
  const hrvAvg = avgOf(view.hrv);
  const brAvg = avgOf(view.breathing);
  const brHigh = b?.respiratoryBrpm != null ? view.breathing.filter((d) => d.value != null && d.value > b.respiratoryBrpm! + 1.5).length : 0;
  const moodAvg = avgOf(view.mood);
  const moodCount = view.mood.filter((d) => d.value != null).length;
  const needH = view.needMin / 60;

  const short = sleepAvg != null ? view.needMin - sleepAvg * 60 : undefined;

  return (
    <Screen title="Trends">
      <View style={s.rangeRow} accessibilityRole="radiogroup">
        {([7, 30] as Range[]).map((r) => (
          <Pressable
            key={r}
            onPress={() => setRange(r)}
            accessibilityRole="radio"
            accessibilityState={{ selected: range === r }}
            style={[s.seg, range === r && s.segActive]}
          >
            <Text style={[s.segText, range === r && s.segTextActive]}>Last {r} days</Text>
          </Pressable>
        ))}
      </View>
      {dash.source === 'fixture' && (
        <Card style={{ borderStyle: 'dashed' }}>
          <Muted>Sample data — connect your Fitbit Air in Settings to see your own trends.</Muted>
        </Card>
      )}
      <Muted>Tap or slide across a chart to read any day.</Muted>

      <TrendPanel
        title="Sleep duration"
        meaning={
          sleepAvg == null
            ? 'No sleep recorded in this period.'
            : short != null && short > 10
              ? `Averaging ${hours(sleepAvg)} — ${fmtMinutes(short)} short of your ${hours(needH)} need.`
              : `Averaging ${hours(sleepAvg)} — meeting your ${hours(needH)} need.`
        }
        data={view.sleepHours}
        format={hours}
        chart={
          <BarChart
            title="Sleep duration"
            data={view.sleepHours}
            format={hours}
            tickFormat={(v) => `${v}h`}
            refLine={{ value: needH, label: `need ${hours(needH)}` }}
          />
        }
      />

      <TrendPanel
        title="Sleep score"
        meaning={scoreAvg == null ? 'No sleep scores yet.' : `Average ${fmtNum(scoreAvg)} / 100 — ${sleepScoreVerdict(scoreAvg).label.toLowerCase()} overall.`}
        data={view.score}
        format={(v) => `${fmtNum(v)} / 100`}
        chart={<LineChart title="Sleep score" data={view.score} format={(v) => `${fmtNum(v)} / 100`} {...scoreAxis(view.score)} />}
      />

      <TrendPanel
        title="Gym recovery"
        meaning={
          recAvg == null
            ? 'Not enough heart and sleep data yet.'
            : `Average ${fmtNum(recAvg)} / 100 · ${plural(recDays.filter((a) => a === 'Train hard').length, 'train-hard day')}, ${plural(recDays.filter((a) => a === 'Rest').length, 'rest day')}.`
        }
        data={view.recovery}
        format={(v) => `${fmtNum(v)} / 100`}
        chart={<LineChart title="Gym recovery" data={view.recovery} format={(v) => `${fmtNum(v)} / 100`} {...scoreAxis(view.recovery)} />}
      />

      <TrendPanel
        title="Resting heart rate"
        meaning={
          rhrAvg == null ? 'No resting heart rate yet.' : `Average ${fmtNum(rhrAvg)} bpm. Below your normal usually means you’re well rested.`
        }
        data={view.rhr}
        format={(v) => `${fmtNum(v)} bpm`}
        chart={
          <LineChart
            title="Resting heart rate"
            minSpan={12}
            data={view.rhr}
            format={(v) => `${fmtNum(v)} bpm`}
            refLine={b?.restingHrBpm != null ? { value: b.restingHrBpm, label: normalLabel('restingHrBpm', b.restingHrBpm) } : undefined}
          />
        }
      />

      <TrendPanel
        title="Heart-rate variability"
        meaning={hrvAvg == null ? 'No HRV synced yet.' : `Average ${fmtNum(hrvAvg)} ms. Above your normal usually means your body has recovered.`}
        data={view.hrv}
        format={(v) => `${fmtNum(v)} ms`}
        chart={
          <LineChart
            title="Heart-rate variability"
            minSpan={30}
            data={view.hrv}
            format={(v) => `${fmtNum(v)} ms`}
            refLine={b?.rmssdMs != null ? { value: b.rmssdMs, label: normalLabel('rmssdMs', b.rmssdMs) } : undefined}
          />
        }
      />

      <TrendPanel
        title="Breathing rate"
        meaning={
          brAvg == null
            ? 'No breathing data yet.'
            : brHigh > 0
              ? `Around ${fmtNum(brAvg, 1)} breaths/min. ${brHigh} night${brHigh === 1 ? ' was' : 's were'} higher than usual — often a cold, late meal or hard workout. A wellness signal, not a diagnosis.`
              : `Steady around ${fmtNum(brAvg, 1)} breaths/min while asleep.`
        }
        data={view.breathing}
        format={(v) => `${fmtNum(v, 1)} breaths/min`}
        chart={
          <LineChart
            title="Breathing rate"
            minSpan={4}
            data={view.breathing}
            format={(v) => `${fmtNum(v, 1)} breaths/min`}
            refLine={b?.respiratoryBrpm != null ? { value: b.respiratoryBrpm, label: normalLabel('respiratoryBrpm', b.respiratoryBrpm, 1) } : undefined}
          />
        }
      />

      <TrendPanel
        title="Mood"
        meaning={
          moodAvg == null
            ? 'No check-ins yet. Log your mood on the Today tab.'
            : `Mostly ${MOOD_LABELS[Math.round(moodAvg) as 1 | 2 | 3 | 4 | 5].toLowerCase()} · ${moodCount} check-in day${moodCount === 1 ? '' : 's'}.`
        }
        data={view.mood}
        format={(v) => `${fmtNum(v, 1)} · ${MOOD_LABELS[Math.round(v) as 1 | 2 | 3 | 4 | 5]}`}
        chart={
          <LineChart
            title="Mood"
            data={view.mood}
            format={(v) => `${fmtNum(v, 1)} · ${MOOD_LABELS[Math.round(v) as 1 | 2 | 3 | 4 | 5]}`}
            domain={[1, 5]}
            ticks={[1, 3, 5]}
            tickFormat={(v) => MOOD_LABELS[v as 1 | 3 | 5]}
          />
        }
      />
      <Muted>{'\n'}Wellness trends, not medical advice.</Muted>
    </Screen>
  );
}

const s = StyleSheet.create({
  rangeRow: { flexDirection: 'row', backgroundColor: colors.panel, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: colors.border, marginBottom: 6 },
  seg: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segActive: { backgroundColor: colors.bg },
  segText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  segTextActive: { color: colors.text },
});
