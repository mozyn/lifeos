/*
 * Browser notifications for reminders (product brief 8 §6, ADR-80), loaded into the app's service
 * worker (Workbox `importScripts`). A push carries { title, body, url, tag }, encrypted for this
 * device; a tap opens its URL inside the app (relative to the app's scope, e.g. `t/<id>`).
 */
/* eslint-env serviceworker */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'LifeOS', body: event.data ? event.data.text() : '' };
  }
  const scope = self.registration.scope;
  event.waitUntil(
    self.registration.showNotification(data.title || 'LifeOS', {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: new URL('icons/icon-192.png', scope).href,
      badge: new URL('icons/icon-192.png', scope).href,
      data: { url: new URL(data.url || 'today', scope).href },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope) && 'focus' in w) {
          return w.focus().then((c) => (c && 'navigate' in c ? c.navigate(target) : c));
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
