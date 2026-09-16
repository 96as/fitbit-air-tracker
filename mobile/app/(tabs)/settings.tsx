import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { useStore } from '../../src/store';
import { Button, Card, Chip, Field, H2, Muted, Screen } from '../../src/components/ui';
import { CALC_METHODS, colors, fmtTime } from '../../src/theme';
import { clearAndRefetch } from '../../src/services/prayerTimes';
import { replan, labelFor } from '../../src/services/replan';
import { alarmKit } from '../../src/services/alarmKit';
import { ensureNotificationPermission } from '../../src/services/notificationChain';
import { seedSleepHistory, syncGoogleHistory } from '../../src/services/sleep';
import { DEFAULT_IOS_CLIENT_ID, makeGoogleProvider, redirectUriFor, signInWithGoogle, signOutOfGoogle } from '../../src/services/googleAuth';

export default function SettingsScreen() {
  const { settings, setSettings, permissions, setPermission, planned, events, device, googleConnected, setGoogleConnected, googleLastProbe, setGoogleLastProbe, logEvent } = useStore();
  const [clientId, setClientId] = useState(settings.googleIosClientId || DEFAULT_IOS_CLIENT_ID);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [lat, setLat] = useState(String(settings.lat));
  const [lng, setLng] = useState(String(settings.lng));
  const [tz, setTz] = useState(settings.tz);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const apply = async (patch: Partial<typeof settings>) => {
    setBusy(true);
    setMsg('');
    try {
      setSettings(patch);
      await clearAndRefetch();
      await replan();
      setMsg('Saved — prayer times refetched and alarms re-armed.');
    } catch (err) {
      setMsg(`Saved, but prayer times failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const useGps = async () => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return setMsg('Location permission denied.');
    const pos = await Location.getCurrentPositionAsync({});
    setLat(pos.coords.latitude.toFixed(4));
    setLng(pos.coords.longitude.toFixed(4));
    await apply({ lat: pos.coords.latitude, lng: pos.coords.longitude, locationLabel: 'GPS location' });
  };

  return (
    <Screen title="Settings">
      <H2>Location</H2>
      <Card>
        <Muted>{settings.locationLabel}</Muted>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="Latitude" value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Longitude" value={lng} onChangeText={setLng} keyboardType="numbers-and-punctuation" />
          </View>
        </View>
        <Field label="Timezone (IANA)" value={tz} onChangeText={setTz} autoCapitalize="none" />
        <Button title="📍 Use my location" kind="secondary" onPress={() => void useGps()} disabled={busy} />
        <Button
          title="Save location"
          onPress={() => void apply({ lat: Number(lat), lng: Number(lng), tz: tz.trim(), locationLabel: `${lat}, ${lng}` })}
          disabled={busy || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng))}
        />
      </Card>

      <H2>Calculation</H2>
      <Card>
        <Muted>Method</Muted>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {CALC_METHODS.map(([id, name]) => (
            <Chip key={id} label={name} active={settings.calcMethod === id} onPress={() => void apply({ calcMethod: id })} />
          ))}
        </View>
        <Muted>Asr madhab</Muted>
        <View style={{ flexDirection: 'row' }}>
          <Chip label="Shafi / Maliki / Hanbali" active={settings.madhab === 0} onPress={() => void apply({ madhab: 0 })} />
          <Chip label="Hanafi" active={settings.madhab === 1} onPress={() => void apply({ madhab: 1 })} />
        </View>
      </Card>

      <H2>Alarm delivery</H2>
      <Card>
        <Row label="System alarms (iOS 26 AlarmKit)" value={permissions.alarmKit} />
        {permissions.alarmKit !== 'granted' && permissions.alarmKit !== 'unavailable' && (
          <Button title="Allow system alarms" onPress={() => void alarmKit.requestPermission().then((r) => setPermission('alarmKit', r)).then(() => replan())} />
        )}
        <Row label="Notifications (backup chain)" value={permissions.notifications} />
        {permissions.notifications !== 'granted' && (
          <Button title="Allow notifications" kind="secondary" onPress={() => void ensureNotificationPermission().then((r) => setPermission('notifications', r)).then(() => replan())} />
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
          <Text style={{ color: colors.text }}>Backup notification chain after deadline</Text>
          <Switch value={settings.chainBackup} onValueChange={(v) => { setSettings({ chainBackup: v }); void replan(); }} trackColor={{ true: colors.accent }} />
        </View>
        <Muted>
          Armed now: {device.alarmKitIds.length} system alarm(s), {device.notificationIds.length} backup notification(s).
          {planned[0] ? ` Next: ${labelFor(planned[0])} ${fmtTime(planned[0].deadlineUtc, settings.tz)}.` : ''}
        </Muted>
      </Card>

      <H2>Sleep data</H2>
      <Card>
        <View style={{ flexDirection: 'row' }}>
          <Chip label="Simulator" active={settings.sleepSource === 'mock'} onPress={() => setSettings({ sleepSource: 'mock' })} />
          <Chip
            label="Google Health (Fitbit Air)"
            active={settings.sleepSource === 'google'}
            onPress={() => setSettings({ sleepSource: 'google' })}
          />
        </View>
        {settings.sleepSource === 'google' && !googleConnected && (
          <Text style={{ color: colors.accent, marginTop: 6 }}>Not connected yet — the simulator is used until you sign in.</Text>
        )}
        <Field label="Google iOS OAuth client ID" value={clientId} onChangeText={setClientId} autoCapitalize="none" autoCorrect={false} placeholder="1234567890-abc.apps.googleusercontent.com" />
        <Muted>
          Create it in Google Cloud Console (docs/GOOGLE_HEALTH_API.md §1). Put it in mobile/.env as
          EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID and rebuild once so the app owns the redirect scheme
          {clientId.trim() ? ` (${redirectUriFor(clientId)})` : ''}.
        </Muted>
        {googleConnected ? (
          <>
            <Text style={{ color: colors.ok, marginTop: 8 }}>✓ Google account connected</Text>
            <Button
              title={googleBusy ? 'Checking…' : 'Test Google sleep fetch now'}
              kind="secondary"
              disabled={googleBusy}
              onPress={() => {
                setGoogleBusy(true);
                makeGoogleProvider(settings.googleIosClientId)
                  .probe('me')
                  .then((r) => {
                    setGoogleLastProbe(r);
                    logEvent('google.probe', { ...r });
                  })
                  .catch((err) => setMsg(`Probe failed: ${String(err)}`))
                  .finally(() => setGoogleBusy(false));
              }}
            />
            {googleLastProbe && (
              <View style={{ marginTop: 8 }}>
                <Muted>Checked {fmtTime(googleLastProbe.checkedAtUtc, settings.tz)} · sessions in last 48 h: {googleLastProbe.sessionsLast48h}</Muted>
                <Muted>Newest stage: {googleLastProbe.newestStageEndUtc ? `${fmtTime(googleLastProbe.newestStageEndUtc, settings.tz)} (${googleLastProbe.stageLagMin} min ago)` : '—'}</Muted>
                <Muted>Newest heart rate: {googleLastProbe.newestHeartRateUtc ? `${fmtTime(googleLastProbe.newestHeartRateUtc, settings.tz)} (${googleLastProbe.heartRateLagMin} min ago)` : '—'}</Muted>
                <Text style={{ color: googleLastProbe.anyUnprocessedSession ? colors.ok : colors.muted, marginTop: 4 }}>
                  {googleLastProbe.anyUnprocessedSession ? 'In-progress night visible → live smart wake possible' : 'No in-progress night visible right now'}
                </Text>
              </View>
            )}
            <Button title="Sync sleep history" kind="secondary" onPress={() => void syncGoogleHistory().then((n) => setMsg(`Synced ${n} nights from Google.`)).catch((e) => setMsg(String(e)))} />
            <Button
              title="Disconnect Google"
              kind="danger"
              onPress={() => void signOutOfGoogle().then(() => { setGoogleConnected(false); logEvent('google.disconnected'); })}
            />
          </>
        ) : (
          <Button
            title={googleBusy ? 'Signing in…' : 'Connect Google'}
            disabled={googleBusy || !clientId.trim()}
            onPress={() => {
              setGoogleBusy(true);
              setSettings({ googleIosClientId: clientId.trim() });
              signInWithGoogle(clientId)
                .then(() => {
                  setGoogleConnected(true);
                  setSettings({ sleepSource: 'google' });
                  logEvent('google.connected');
                  setMsg('Connected. Sleep source switched to Google Health.');
                  return syncGoogleHistory();
                })
                .catch((err) => setMsg(`Google sign-in failed: ${String(err)}`))
                .finally(() => setGoogleBusy(false));
            }}
          />
        )}
      </Card>

      <H2>Data</H2>
      <Card>
        <Muted>{events.length} events logged on this device (alarm scheduled/fired/snoozed/dismissed, timetable fetches).</Muted>
        <Button title="Re-seed simulated sleep history" kind="secondary" onPress={() => { seedSleepHistory(); setMsg('Sleep history re-seeded.'); }} />
      </Card>

      {msg ? <Text style={{ color: colors.accent, marginTop: 12 }}>{msg}</Text> : null}
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const color = value === 'granted' ? colors.ok : value === 'unknown' ? colors.muted : colors.danger;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: colors.text }}>{label}</Text>
      <Text style={{ color, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}
