// Minimal service worker: receives Web Push and surfaces the "rate this" prompt.
// Registered by PushService. Kept plain JS (not part of the Angular bundle).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = {};
  }
  if (data.kind !== 'rate') return;
  const title = `Rate your effort: ${data.issueKey}`;
  const body = `${data.title} → ${data.toStatus}`;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.pendingId,
      data: { url: `/tracker?pending=${encodeURIComponent(data.pendingId)}` },
      requireInteraction: false,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/tracker';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
