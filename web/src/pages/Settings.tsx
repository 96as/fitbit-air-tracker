import { useEffect, useState } from 'react';
import { api, type AlarmPolicy, type User } from '../api';

const METHODS: [number, string][] = [
  [3, 'Muslim World League'],
  [2, 'ISNA (North America)'],
  [5, 'Egyptian General Authority'],
  [4, 'Umm al-Qura (Makkah)'],
  [1, 'University of Karachi'],
  [8, 'Gulf Region'],
  [12, 'Union des Organisations Islamiques de France'],
  [13, 'Diyanet (Turkey)'],
];

export default function Settings() {
  const [user, setUser] = useState<User>();
  const [fajr, setFajr] = useState<AlarmPolicy>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.settings().then(({ user, policies }) => {
      setUser(user);
      setFajr(policies.find((p) => p.prayer === 'fajr'));
    });
  }, []);

  if (!user) return <p className="notice">Loading…</p>;

  const useMyLocation = () => {
    navigator.geolocation?.getCurrentPosition((pos) => {
      setUser({ ...user, lat: pos.coords.latitude, lng: pos.coords.longitude });
    });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.saveSettings({
        lat: user.lat,
        lng: user.lng,
        tz: user.tz,
        calcMethod: user.calcMethod,
        madhab: user.madhab,
      });
      if (fajr) {
        await api.savePolicy({
          prayer: 'fajr',
          enabled: fajr.enabled,
          windowMinutes: fajr.windowMinutes,
          deadlineOffsetMinutes: fajr.deadlineOffsetMinutes,
          snoozeMinutes: fajr.snoozeMinutes,
        });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>Settings</h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Location & calculation</h2>
        <div className="grid">
          <div>
            <label>Latitude</label>
            <input
              type="number"
              step="0.0001"
              value={user.lat}
              onChange={(e) => setUser({ ...user, lat: Number(e.target.value) })}
            />
          </div>
          <div>
            <label>Longitude</label>
            <input
              type="number"
              step="0.0001"
              value={user.lng}
              onChange={(e) => setUser({ ...user, lng: Number(e.target.value) })}
            />
          </div>
          <div>
            <label>Timezone (IANA)</label>
            <input value={user.tz} onChange={(e) => setUser({ ...user, tz: e.target.value })} />
          </div>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <button className="secondary" onClick={useMyLocation}>
            📍 Use my location
          </button>
        </div>
        <label>Calculation method</label>
        <select
          value={user.calcMethod}
          onChange={(e) => setUser({ ...user, calcMethod: Number(e.target.value) })}
        >
          {METHODS.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <label>Asr madhab</label>
        <select
          value={user.madhab}
          onChange={(e) => setUser({ ...user, madhab: Number(e.target.value) as 0 | 1 })}
        >
          <option value={0}>Shafi / Maliki / Hanbali</option>
          <option value={1}>Hanafi</option>
        </select>
      </div>

      {fajr && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Fajr smart-wake policy</h2>
          <label>
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 8 }}
              checked={fajr.enabled}
              onChange={(e) => setFajr({ ...fajr, enabled: e.target.checked })}
            />
            Enabled
          </label>
          <label>Wake window (minutes before deadline)</label>
          <input
            type="number"
            min={5}
            max={120}
            value={fajr.windowMinutes}
            onChange={(e) => setFajr({ ...fajr, windowMinutes: Number(e.target.value) })}
          />
          <label>Deadline: minutes before Fajr (time you need to pray)</label>
          <input
            type="number"
            min={0}
            max={120}
            value={fajr.deadlineOffsetMinutes}
            onChange={(e) => setFajr({ ...fajr, deadlineOffsetMinutes: Number(e.target.value) })}
          />
          <label>Snooze minutes</label>
          <input
            type="number"
            min={1}
            max={20}
            value={fajr.snoozeMinutes}
            onChange={(e) => setFajr({ ...fajr, snoozeMinutes: Number(e.target.value) })}
          />
        </div>
      )}

      <button onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
      {saved && <span className="ok" style={{ marginLeft: 12 }}>Saved ✓</span>}
    </div>
  );
}
