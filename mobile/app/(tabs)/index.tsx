import { useState } from 'react';
import { Text, View } from 'react-native';
import { localDateString } from '@fitbit-air-tracker/core';
import { useStore } from '../../src/store';
import { Button, Card, H2, Muted, Screen, Stat } from '../../src/components/ui';
import { Hypnogram } from '../../src/components/Hypnogram';
import { colors, fmtDate, fmtTime, PRAYER_LABELS } from '../../src/theme';
import { refreshTimetable } from '../../src/services/prayerTimes';
import { labelFor, replan } from '../../src/services/replan';

export default function TonightScreen() {
  const { settings, planned, timings, hijriByDate, sessions, permissions } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const tz = settings.tz;
  const today = localDateString(new Date(), tz);
  const todayTimes = timings[today];
  const next = planned[0];
  const lastNight = sessions.find((s) => !s.isNap) ?? sessions[0];

  const refresh = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await refreshTimetable();
      await replan();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Tonight">
      {permissions.alarmKit !== 'granted' && (
        <Card style={{ borderColor: colors.accent }}>
          <Text style={{ color: colors.accent, fontWeight: '600' }}>
            {permissions.alarmKit === 'unavailable'
              ? 'System alarms unavailable on this device (needs iOS 26). Using notification chain + Bedside mode.'
              : 'Allow alarms in Settings so the wake-up rings until you stop it — even if the app is closed.'}
          </Text>
        </Card>
      )}

      {next ? (
        <Card>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>{labelFor(next)}</Text>
          <Muted>{fmtDate(next.deadlineUtc, tz)}</Muted>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <Stat label="Wake window opens" value={fmtTime(next.windowStartUtc, tz)} />
            <Stat label="Latest wake" value={fmtTime(next.deadlineUtc, tz)} />
            {next.prayerTimeUtc && <Stat label="Prayer time" value={fmtTime(next.prayerTimeUtc, tz)} />}
          </View>
          <Muted>
            {next.windowStartUtc === next.deadlineUtc
              ? 'Exact alarm: rings at the time above until you stop it.'
              : 'Open Bedside mode when you sleep: the alarm fires as soon as light sleep is detected inside the window — and always by the latest-wake time.'}
          </Muted>
          <Muted>
            {planned.length} alarm{planned.length === 1 ? '' : 's'} armed for the next 7 days.
          </Muted>
        </Card>
      ) : (
        <Card>
          <Muted>No alarm planned. Enable one in the Alarms tab{todayTimes ? '' : ' (and fetch prayer times below)'}.</Muted>
        </Card>
      )}

      <H2>Prayer times · {hijriByDate[today] ?? today}</H2>
      <Card>
        {todayTimes ? (
          ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha', 'lastthird'].map(
            (k) =>
              todayTimes[k] && (
                <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
                  <Text style={{ color: colors.muted }}>{PRAYER_LABELS[k]}</Text>
                  <Text style={{ color: colors.text, fontVariant: ['tabular-nums'] }}>{fmtTime(todayTimes[k], tz)}</Text>
                </View>
              ),
          )
        ) : (
          <Muted>Not fetched yet for {settings.locationLabel}.</Muted>
        )}
        {error && <Text style={{ color: colors.danger, marginTop: 6 }}>{error}</Text>}
        <Button title={busy ? 'Refreshing…' : 'Refresh prayer times'} kind="secondary" onPress={() => void refresh()} disabled={busy} />
      </Card>

      <H2>Last night</H2>
      <Card>{lastNight ? <Hypnogram session={lastNight} tz={tz} /> : <Muted>No sleep data yet.</Muted>}</Card>

      {sessions.length > 1 && (
        <>
          <H2>Recent nights</H2>
          {sessions.slice(1, 7).map((s) => (
            <Card key={s.id}>
              <Hypnogram session={s} tz={tz} />
            </Card>
          ))}
        </>
      )}
    </Screen>
  );
}
