import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { MetricsReport, MoodEntry, NightData } from '@fitbit-air-tracker/core';
import { colors, fmtTime } from '../../theme';
import { Hypnogram } from '../Hypnogram';
import { ENERGY_LABELS, MOOD_FACES, MOOD_LABELS } from '../../moodStore';
import {
  BigNumber,
  EmptyNote,
  HowCalculated,
  LowConfidenceNote,
  Meaning,
  MetricCard,
  MiniStat,
} from './MetricCard';
import {
  best,
  bestValue,
  consistencyVerdict,
  debtVerdict,
  fajrEaseVerdict,
  fmtMinutes,
  fmtNum,
  fmtSigned,
  learningNote,
  recoveryVerdict,
  sleepScoreVerdict,
  status,
  TONE_ICON,
  toneForLabel,
} from './format';

interface CardProps {
  report?: MetricsReport;
  night?: NightData;
}

/** "2 below your normal" / "about your normal" — never a judgement, just the comparison. */
function vsNormal(value: number | undefined, normal: number | undefined, unit: string, digits = 0, tolerance = 0): string | undefined {
  if (value == null || normal == null) return undefined;
  const d = value - normal;
  if (Math.abs(d) <= tolerance || Math.abs(d) < 0.5 * 10 ** -digits) return 'about your normal';
  return `${fmtNum(Math.abs(d), digits)}${unit} ${d > 0 ? 'above' : 'below'} your normal`;
}

// --- Fajr wake-up ---------------------------------------------------------

export function FajrWakeCard({ report, night, tz }: CardProps & { tz: string }) {
  const r = best(report, 'fajrWakeEase');
  if (!r || r.value == null) return null;
  const v = fajrEaseVerdict(r.value, r.label);
  return (
    <MetricCard title="This morning’s wake-up" pill={{ tone: v.tone, label: v.label }}>
      <Meaning>{v.meaning}</Meaning>
      {night?.session && <Text style={st.sub}>Up at {fmtTime(night.session.endUtc, tz)}</Text>}
      <LowConfidenceNote result={r} />
      <HowCalculated results={report?.all.fajrWakeEase} best={r} />
    </MetricCard>
  );
}

// --- Sleep -------------------------------------------------------------------

export function SleepCard({ report, night, tz }: CardProps & { tz: string }) {
  const score = best(report, 'sleepScore');
  const dur = best(report, 'sleepDuration');
  const scoreV = bestValue(report, 'sleepScore');
  const durV = bestValue(report, 'sleepDuration');
  const v = scoreV != null ? sleepScoreVerdict(scoreV, score?.label) : undefined;

  if (scoreV == null && durV == null) {
    return (
      <MetricCard title="Sleep">
        <EmptyNote>
          {night?.stagesProcessed === false
            ? 'Your sleep was detected — the band is still processing the stages. Check back in a few minutes.'
            : 'No sleep recorded for last night yet. Wear your Fitbit Air to bed; data shows about 15 minutes after it syncs.'}
        </EmptyNote>
      </MetricCard>
    );
  }

  return (
    <MetricCard title="Sleep" pill={v && { tone: v.tone, label: v.label }}>
      <View style={st.row}>
        <View style={{ flex: 1 }}>
          {scoreV != null ? (
            <BigNumber value={fmtNum(scoreV)} unit="/ 100" caption="Sleep score" />
          ) : (
            <BigNumber value={fmtMinutes(durV)} caption="Time asleep" />
          )}
        </View>
        {scoreV != null && durV != null && (
          <View style={st.side}>
            <Text style={st.sideValue}>{fmtMinutes(durV)}</Text>
            <Text style={st.sub}>asleep</Text>
          </View>
        )}
      </View>
      <Meaning>{v?.meaning ?? 'Score needs sleep stages — showing time asleep for now.'}</Meaning>
      <LowConfidenceNote result={score ?? dur} />
      {night?.session ? (
        <View style={{ marginTop: 10 }}>
          <Hypnogram session={night.session} tz={tz} />
        </View>
      ) : null}
      <HowCalculated results={report?.all[score ? 'sleepScore' : 'sleepDuration']} best={score ?? dur} />
    </MetricCard>
  );
}

// --- Recovery ------------------------------------------------------------------

export function RecoveryCard({ report, night }: CardProps) {
  const r = best(report, 'recovery');
  if (!r || r.value == null) {
    return (
      <MetricCard title="Gym recovery">
        <EmptyNote>Not enough data yet. Recovery needs last night’s sleep and resting heart rate.</EmptyNote>
      </MetricCard>
    );
  }
  // The recommendation comes from the engine's label ("Train hard" / "Train light" / "Rest").
  const v = recoveryVerdict(r.value, r.label);
  const b = report?.baselines;
  return (
    <MetricCard title="Gym recovery">
      <View style={st.row}>
        <View style={{ flex: 1 }}>
          <Text style={st.advice} accessibilityRole="text">
            <Text style={{ color: status[v.tone] }}>{TONE_ICON[v.tone]} </Text>
            {v.label}
          </Text>
          <Text style={st.sub}>Recovery {fmtNum(r.value)} / 100</Text>
        </View>
      </View>
      <Meaning>{v.meaning}</Meaning>
      <View style={st.miniRow}>
        <MiniStat
          label="Resting heart rate"
          value={night?.restingHrBpm != null ? `${night.restingHrBpm} bpm` : '—'}
          sub={learningNote(report, 'restingHrBpm') ?? vsNormal(night?.restingHrBpm, b?.restingHrBpm, ' bpm', 0, 1)}
        />
        <MiniStat
          label="Heart-rate variability"
          value={night?.dailyHrv?.rmssdMs != null ? `${fmtNum(night.dailyHrv.rmssdMs)} ms` : '—'}
          sub={
            night?.dailyHrv?.rmssdMs != null
              ? (learningNote(report, 'rmssdMs') ?? vsNormal(night.dailyHrv.rmssdMs, b?.rmssdMs, ' ms', 0, 2))
              : 'not synced yet'
          }
        />
      </View>
      <LowConfidenceNote result={r} />
      <HowCalculated results={report?.all.recovery} best={r} />
    </MetricCard>
  );
}

// --- Breathing -----------------------------------------------------------------

export function BreathingCard({ report, night }: CardProps) {
  const r = best(report, 'breathing');
  const brpm = r?.value ?? night?.respiratory?.fullSleepBrpm ?? undefined;
  const normalBrpm = r?.components?.baselineBrpm ?? report?.baselines.respiratoryBrpm;
  const spo2 = r?.components?.spo2AvgPct ?? night?.dailySpo2?.avgPct;
  const normalSpo2 = r?.components?.spo2BaselinePct ?? report?.baselines.spo2AvgPct;

  if (brpm == null && spo2 == null) {
    return (
      <MetricCard title="Breathing">
        <EmptyNote>Breathing data hasn’t arrived yet. The band sends it after it finishes processing your night.</EmptyNote>
      </MetricCard>
    );
  }

  const diff = brpm != null && normalBrpm != null ? brpm - normalBrpm : undefined;
  const high = diff != null && diff > 1.5;
  const low = diff != null && diff < -1.5;
  const spo2Low = spo2 != null && normalSpo2 != null && spo2 < normalSpo2 - 2;
  const brLearning = learningNote(report, 'respiratoryBrpm');
  const ownTone = high || spo2Low ? 'caution' : diff != null ? 'good' : 'neutral';
  const ownLabel = high ? 'Higher than usual' : low ? 'Lower than usual' : spo2Low ? 'Oxygen lower' : diff != null ? 'Normal for you' : 'Learning';
  const label = r?.label ?? ownLabel;
  const tone = toneForLabel(r?.label, ownTone);
  const flagged = r?.label ? tone === 'caution' : high || spo2Low;

  return (
    <MetricCard title="Breathing" pill={{ tone, label }}>
      <View style={st.row}>
        <View style={{ flex: 1 }}>
          {brpm != null ? (
            <BigNumber value={fmtNum(brpm, 1)} unit="breaths/min" caption="While asleep" />
          ) : (
            <EmptyNote>Breathing rate not synced yet.</EmptyNote>
          )}
        </View>
      </View>
      <Meaning>
        {flagged
          ? 'A bit different from your usual nights. This can follow a cold, a late meal, or a hard workout. It’s a wellness signal, not a diagnosis — see a doctor if you feel unwell.'
          : brLearning
            ? `Looks steady — we’re ${brLearning}.`
            : diff != null
              ? `Steady and within your normal range (about ${fmtNum(normalBrpm, 1)}).`
              : 'We’re still learning your normal — a few more nights needed.'}
      </Meaning>
      <View style={st.miniRow}>
        <MiniStat
          label="Blood oxygen (SpO₂)"
          value={spo2 != null ? `${fmtNum(spo2, 1)}%` : '—'}
          sub={spo2 != null ? (learningNote(report, 'spo2AvgPct') ?? vsNormal(spo2, normalSpo2, '%', 1, 0.5)) : 'not synced yet'}
        />
        {night?.skinTempDeltaC != null && (
          <MiniStat
            label="Skin temperature"
            value={`${fmtSigned(night.skinTempDeltaC)} °C`}
            sub={best(report, 'skinTemp')?.label ?? 'vs your normal'}
          />
        )}
      </View>
      <LowConfidenceNote result={r} />
      <HowCalculated results={report?.all.breathing} best={r} />
    </MetricCard>
  );
}

// --- Mood --------------------------------------------------------------------

export function MoodCard({ report, todayMoods }: { report?: MetricsReport; todayMoods: MoodEntry[] }) {
  const router = useRouter();
  const latest = todayMoods[0];
  const link = best(report, 'moodLink');
  const open = () => router.push('/mood');
  return (
    <MetricCard title="Mood">
      {latest ? (
        <>
          <View style={st.row}>
            <Text style={st.face} accessibilityLabel={`Mood: ${MOOD_LABELS[latest.score]}`}>
              {MOOD_FACES[latest.score]}
            </Text>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={st.sideValue}>{MOOD_LABELS[latest.score]}</Text>
              <Text style={st.sub}>
                {latest.energy ? `Energy: ${ENERGY_LABELS[latest.energy]}` : 'Checked in today'}
                {todayMoods.length > 1 ? ` · ${todayMoods.length} check-ins today` : ''}
              </Text>
            </View>
          </View>
          {latest.tags && latest.tags.length > 0 && <Text style={st.tags}>{latest.tags.join(' · ')}</Text>}
          <Pressable onPress={open} accessibilityRole="button" style={st.ghostBtn} hitSlop={6}>
            <Text style={st.ghostText}>Check in again</Text>
          </Pressable>
        </>
      ) : (
        <Pressable onPress={open} accessibilityRole="button" accessibilityLabel="How do you feel? Open mood check-in" style={st.moodBtn}>
          <Text style={st.moodBtnFaces}>😣 🙁 😐 🙂 😄</Text>
          <Text style={st.moodBtnText}>How do you feel?</Text>
          <Text style={st.sub}>One tap — helps link your mood to your sleep</Text>
        </Pressable>
      )}
      {link && link.value != null && (
        <>
          <Meaning>{link.explanation}</Meaning>
          <HowCalculated results={report?.all.moodLink} best={link} label="How was this worked out?" />
        </>
      )}
    </MetricCard>
  );
}

// --- Sleep debt + consistency -------------------------------------------------------

export function RhythmCard({ report }: { report?: MetricsReport }) {
  const debt = best(report, 'sleepDebt');
  const cons = best(report, 'consistency');
  if ((!debt || debt.value == null) && (!cons || cons.value == null)) {
    return (
      <MetricCard title="Sleep rhythm">
        <EmptyNote>Needs a few nights of data to show sleep debt and how regular your bedtimes are.</EmptyNote>
      </MetricCard>
    );
  }
  const dv = debt?.value != null ? debtVerdict(debt.value, debt.label) : undefined;
  const cv = cons?.value != null ? consistencyVerdict(cons.value, cons.label) : undefined;
  return (
    <MetricCard title="Sleep rhythm">
      <View style={st.miniRow}>
        <MiniStat label="Sleep debt" value={debt?.value != null ? fmtMinutes(debt.value) : '—'} sub={dv?.label} tone={dv?.tone} />
        <MiniStat label="Consistency" value={cons?.value != null ? `${fmtNum(cons.value)} / 100` : '—'} sub={cv?.label} tone={cv?.tone} />
      </View>
      {dv && <Meaning>{dv.meaning}</Meaning>}
      {cv && <Text style={[st.sub, { marginTop: 4, fontSize: 14 }]}>{cv.meaning}</Text>}
      <HowCalculated results={report?.all.sleepDebt} best={debt} label="How was sleep debt calculated?" />
      <HowCalculated results={report?.all.consistency} best={cons} label="How was consistency calculated?" />
    </MetricCard>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  miniRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  side: { alignItems: 'flex-end' },
  sideValue: { color: colors.text, fontSize: 22, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  advice: { color: colors.text, fontSize: 34, fontWeight: '800' },
  face: { fontSize: 44 },
  tags: { color: colors.muted, fontSize: 13, marginTop: 8 },
  moodBtn: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  moodBtnFaces: { fontSize: 24, letterSpacing: 2 },
  moodBtnText: { color: colors.accent, fontSize: 18, fontWeight: '700', marginTop: 6 },
  ghostBtn: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  ghostText: { color: colors.text, fontSize: 13 },
});
