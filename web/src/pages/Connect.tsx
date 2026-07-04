import { useEffect, useState } from 'react';
import { api, fmtTime, type Status } from '../api';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export default function Connect() {
  const [status, setStatus] = useState<Status>();
  const [pushState, setPushState] = useState<'unknown' | 'subscribed' | 'unavailable' | 'error'>(
    'unknown',
  );

  useEffect(() => {
    api.status().then(setStatus).catch(() => undefined);
    navigator.serviceWorker?.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription();
      if (sub) setPushState('subscribed');
    });
  }, []);

  async function enablePush() {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setPushState('error');
      const { publicKey } = await api.pushKey();
      if (!publicKey) return setPushState('unavailable');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await api.subscribePush(sub.toJSON());
      setPushState('subscribed');
    } catch {
      setPushState('error');
    }
  }

  return (
    <div>
      <h1>Device & delivery</h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Fitbit Air connection</h2>
        {status?.mockMode ? (
          <>
            <p>
              <span className="warn">● Simulator mode</span> — a mock Fitbit Air is generating
              realistic sleep data (including the real ~15 min sync lag), so everything works
              without Google credentials.
            </p>
            <p className="notice">
              Connecting a real Fitbit Air uses the Google Health API and requires approved
              developer access — see <code>docs/INTEGRATIONS.md</code>. Once configured, set{' '}
              <code>PROVIDER=google_health</code> in <code>server/.env</code>.
            </p>
          </>
        ) : (
          <p>
            <span className="ok">● Google Health API</span> provider active.
          </p>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Push notifications (tier-1 alarm)</h2>
        {pushState === 'subscribed' ? (
          <p className="ok">✓ Subscribed — alarms will ring as push notifications.</p>
        ) : pushState === 'unavailable' ? (
          <p className="warn">
            Server has no VAPID keys yet. Run <code>npm run vapid -w server</code> and put the keys
            in <code>server/.env</code>, then restart.
          </p>
        ) : (
          <>
            <p className="notice">
              Enable push so the alarm reaches this device even when the app is closed (most
              reliable on Android; on iPhone install the app to the home screen first — and rely on
              Bedside Mode).
            </p>
            <button onClick={enablePush}>Enable push alarms</button>
            {pushState === 'error' && (
              <p className="warn">Could not subscribe — check notification permissions.</p>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Scheduled alarms</h2>
        {status?.scheduledAlarms.length ? (
          <table>
            <thead>
              <tr>
                <th>Prayer</th>
                <th>Window opens</th>
                <th>Deadline</th>
                <th>Prayer time</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {status.scheduledAlarms.map((a) => (
                <tr key={a.prayer}>
                  <td style={{ textTransform: 'capitalize' }}>{a.prayer}</td>
                  <td>{fmtTime(a.windowStartUtc)}</td>
                  <td>{fmtTime(a.deadlineUtc)}</td>
                  <td>{fmtTime(a.prayerTimeUtc)}</td>
                  <td>{a.fired ? 'fired' : 'armed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="notice">Nothing armed right now.</p>
        )}
      </div>
    </div>
  );
}
