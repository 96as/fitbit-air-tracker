/**
 * Service worker: receives prayer-alarm pushes and keeps renotifying until the
 * user acts. Tier-1 alarm delivery — Bedside Mode is the offline guarantee.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    /* non-JSON push */
  }
  const title = payload.title || 'Wake up for prayer 🕌';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || 'It is time to wake up.',
      tag: 'prayer-alarm', // replaces previous — escalation renotifies instead of stacking
      renotify: true,
      requireInteraction: true,
      vibrate: [400, 150, 400, 150, 800],
      data: payload,
      actions: [
        { action: 'awake', title: "I'm awake" },
        { action: 'snooze', title: 'Snooze' },
      ],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const ack = (snooze) =>
    fetch('/api/v1/alarms/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snooze }),
    }).catch(() => {});

  if (event.action === 'awake') {
    event.waitUntil(ack(false));
  } else if (event.action === 'snooze') {
    event.waitUntil(ack(true));
  } else {
    // Body click: open Bedside Mode so the full-screen alarm takes over.
    event.waitUntil(
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) => {
          const existing = clients.find((c) => 'focus' in c);
          if (existing) {
            existing.navigate('/bedside');
            return existing.focus();
          }
          return self.clients.openWindow('/bedside');
        }),
    );
  }
});
