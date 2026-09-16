import { useState } from 'react';
import { Switch, Text, View, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { newId, type WakeAlarm } from '@fitbit-air-tracker/core';
import { useStore } from '../../src/store';
import { Button, Card, Chip, Field, H2, Muted, Screen, Stepper } from '../../src/components/ui';
import { colors, fmtTime, PRAYER_LABELS } from '../../src/theme';
import { replan } from '../../src/services/replan';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function AlarmsScreen() {
  const { alarms, upsertAlarm, removeAlarm, planned, settings } = useStore();
  const [adding, setAdding] = useState(false);

  const save = async (alarm: WakeAlarm) => {
    upsertAlarm(alarm);
    await replan();
  };
  const remove = async (id: string) => {
    removeAlarm(id);
    await replan();
  };

  const prayerAlarms = alarms.filter((a) => a.kind === 'prayer');
  const customAlarms = alarms.filter((a) => a.kind === 'custom');
  const nextFor = (id: string) => planned.find((p) => p.alarmId === id);

  return (
    <Screen title="Alarms">
      <Muted>
        Every enabled alarm becomes a system alarm at its latest-wake time (rings until stopped). A wake window &gt; 0
        lets Bedside mode wake you earlier, during light sleep.
      </Muted>

      <H2>Prayer alarms</H2>
      {prayerAlarms.map((a) => (
        <Card key={a.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600' }}>{PRAYER_LABELS[a.prayer] ?? a.prayer}</Text>
              <Muted>{nextFor(a.id) ? `Next: ${fmtTime(nextFor(a.id)!.deadlineUtc, settings.tz)}` : a.enabled ? 'Waiting for prayer times' : 'Off'}</Muted>
            </View>
            <Switch value={a.enabled} onValueChange={(v) => void save({ ...a, enabled: v })} trackColor={{ true: colors.accent }} />
          </View>
          {a.enabled && (
            <>
              <Stepper label="Latest wake: minutes before prayer" value={a.deadlineOffsetMinutes} onChange={(v) => void save({ ...a, deadlineOffsetMinutes: v })} />
              <Stepper label="Smart wake window" value={a.windowMinutes} onChange={(v) => void save({ ...a, windowMinutes: v })} />
              <Stepper label="Snooze" value={a.snoozeMinutes} onChange={(v) => void save({ ...a, snoozeMinutes: v })} step={1} min={1} max={20} />
            </>
          )}
        </Card>
      ))}

      <H2>Custom wake times</H2>
      {customAlarms.map((a) => (
        <Card key={a.id}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={{ color: colors.text, fontSize: 22, fontWeight: '600' }}>{a.customTime}</Text>
              <Muted>
                {a.label ?? 'Alarm'} · {a.days && a.days.length ? a.days.map((d) => DAYS[d]).join(' ') : 'every day'}
                {a.windowMinutes ? ` · smart window ${a.windowMinutes} min` : ' · exact'}
              </Muted>
            </View>
            <Switch value={a.enabled} onValueChange={(v) => void save({ ...a, enabled: v })} trackColor={{ true: colors.accent }} />
          </View>
          <Button title="Delete" kind="danger" onPress={() => void remove(a.id)} />
        </Card>
      ))}
      {adding ? (
        <NewCustomAlarm
          onCancel={() => setAdding(false)}
          onSave={(a) => {
            setAdding(false);
            void save(a);
          }}
        />
      ) : (
        <Button title="+ Add custom wake time" onPress={() => setAdding(true)} />
      )}
    </Screen>
  );
}

function NewCustomAlarm({ onSave, onCancel }: { onSave: (a: WakeAlarm) => void; onCancel: () => void }) {
  const [time, setTime] = useState(() => {
    const d = new Date();
    d.setHours(6, 30, 0, 0);
    return d;
  });
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<number[]>([]);
  const [windowMinutes, setWindowMinutes] = useState(20);
  const [showPicker, setShowPicker] = useState(Platform.OS === 'ios');

  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;

  return (
    <Card>
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>New wake time</Text>
      {Platform.OS !== 'ios' && <Button title={`Time: ${hhmm}`} kind="secondary" onPress={() => setShowPicker(true)} />}
      {showPicker && (
        <DateTimePicker
          value={time}
          mode="time"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          themeVariant="dark"
          onChange={(_e, d) => {
            if (Platform.OS !== 'ios') setShowPicker(false);
            if (d) setTime(d);
          }}
        />
      )}
      <Field label="Label (optional)" value={label} onChangeText={setLabel} placeholder="e.g. Work" />
      <Text style={{ color: colors.muted, fontSize: 13, marginTop: 10 }}>Repeat on (none = every day)</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {DAYS.map((d, i) => (
          <Chip key={d} label={d} active={days.includes(i)} onPress={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())} />
        ))}
      </View>
      <Stepper label="Smart wake window (0 = exact)" value={windowMinutes} onChange={setWindowMinutes} />
      <Button
        title="Save alarm"
        onPress={() =>
          onSave({
            id: newId(),
            userId: 'me',
            kind: 'custom',
            prayer: 'fajr',
            label: label.trim() || undefined,
            customTime: hhmm,
            days: days.length ? days : undefined,
            enabled: true,
            windowMinutes,
            deadlineOffsetMinutes: 0,
            preferredStages: ['light', 'awake'],
            snoozeMinutes: 5,
            maxSnoozes: 2,
          })
        }
      />
      <Button title="Cancel" kind="secondary" onPress={onCancel} />
    </Card>
  );
}
