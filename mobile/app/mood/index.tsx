import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { localDateString, type MoodEntry } from '@fitbit-air-tracker/core';
import { Button, Chip, Field, Muted, Screen } from '../../src/components/ui';
import { ENERGY_LABELS, MOOD_FACES, MOOD_LABELS, MOOD_TAGS, moodsOnDate, useMoodStore } from '../../src/moodStore';
import { useStore } from '../../src/store';
import { colors, fmtTime } from '../../src/theme';

type Score = MoodEntry['score'];
const SCORES: Score[] = [1, 2, 3, 4, 5];

/** One-tap mood check-in: mood (required) → optional energy, tags, note → Save. */
export default function MoodCheckIn() {
  const router = useRouter();
  const tz = useStore((s) => s.settings.tz);
  const { entries, addMood, removeMood } = useMoodStore();
  const [score, setScore] = useState<Score>();
  const [energy, setEnergy] = useState<Score>();
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const today = moodsOnDate(entries, localDateString(new Date(), tz), tz);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const toggleTag = (t: string) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const save = () => {
    if (!score) return;
    addMood({
      tsUtc: new Date().toISOString(),
      score,
      ...(energy ? { energy } : {}),
      ...(tags.length ? { tags } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    close();
  };

  return (
    <Screen title="How do you feel?">
      <View style={s.topRow}>
        <Muted>Takes 5 seconds. Only the mood is required.</Muted>
        <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close without saving" hitSlop={10}>
          <Text style={s.close}>Cancel</Text>
        </Pressable>
      </View>

      <Text style={s.section}>Mood</Text>
      <View style={s.scaleRow} accessibilityRole="radiogroup" accessibilityLabel="Mood">
        {SCORES.map((n) => (
          <Pressable
            key={n}
            onPress={() => setScore(n)}
            accessibilityRole="radio"
            accessibilityState={{ selected: score === n }}
            accessibilityLabel={`${MOOD_LABELS[n]}, ${n} of 5`}
            style={[s.face, score === n && s.faceActive]}
          >
            <Text style={s.faceGlyph}>{MOOD_FACES[n]}</Text>
            <Text style={[s.faceLabel, score === n && s.faceLabelActive]}>{MOOD_LABELS[n]}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={s.section}>Energy (optional)</Text>
      <View style={s.scaleRow} accessibilityRole="radiogroup" accessibilityLabel="Energy">
        {SCORES.map((n) => (
          <Pressable
            key={n}
            onPress={() => setEnergy(energy === n ? undefined : n)}
            accessibilityRole="radio"
            accessibilityState={{ selected: energy === n }}
            accessibilityLabel={`Energy ${ENERGY_LABELS[n]}, ${n} of 5`}
            style={[s.energy, energy === n && s.faceActive]}
          >
            <View style={s.energyBars}>
              {SCORES.map((k) => (
                <View key={k} style={[s.energyBar, { height: 4 + k * 3, backgroundColor: k <= n ? colors.accent2 : colors.border }]} />
              ))}
            </View>
            <Text style={[s.faceLabel, energy === n && s.faceLabelActive]}>{ENERGY_LABELS[n]}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={s.section}>Anything worth noting? (optional)</Text>
      <View style={s.tags}>
        {MOOD_TAGS.map((t) => (
          <Chip key={t} label={t} active={tags.includes(t)} onPress={() => toggleTag(t)} />
        ))}
      </View>

      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. slept late after a family visit" multiline maxLength={280} />

      <Button title={score ? `Save — ${MOOD_LABELS[score]}` : 'Pick a mood to save'} onPress={save} disabled={!score} />

      {today.length > 0 && (
        <>
          <Text style={s.section}>Earlier today</Text>
          {today.map((e) => (
            <View key={e.tsUtc} style={s.histRow}>
              <Text style={s.histText}>
                {MOOD_FACES[e.score]} {MOOD_LABELS[e.score]} · {fmtTime(e.tsUtc, tz)}
                {e.tags?.length ? ` · ${e.tags.join(', ')}` : ''}
              </Text>
              <Pressable onPress={() => removeMood(e.tsUtc)} accessibilityRole="button" accessibilityLabel="Delete this check-in" hitSlop={8}>
                <Text style={s.del}>Delete</Text>
              </Pressable>
            </View>
          ))}
        </>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  close: { color: colors.accent2, fontSize: 15, fontWeight: '600' },
  section: { color: colors.muted, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 20, marginBottom: 8 },
  scaleRow: { flexDirection: 'row', gap: 6 },
  face: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  faceActive: { borderColor: colors.accent, borderWidth: 2 },
  faceGlyph: { fontSize: 32 },
  faceLabel: { color: colors.muted, fontSize: 12, marginTop: 4 },
  faceLabelActive: { color: colors.text, fontWeight: '700' },
  energy: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  },
  energyBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 20 },
  energyBar: { width: 4, borderRadius: 1 },
  tags: { flexDirection: 'row', flexWrap: 'wrap' },
  histRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  histText: { color: colors.text, fontSize: 14, flex: 1 },
  del: { color: colors.danger, fontSize: 13 },
});
