/* 406 Truck Drops service worker: shows drop alerts. */
self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  var title = data.title || 'New 4x4 drop';
  var body = data.body || 'A new truck just hit Marketplace near Billings.';
  var url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: '/images/406-truck-drops-icon.png',
      badge: '/favicon-32.png',
      tag: 'truck-drop',
      data: { url: url },
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clients) {
        for (var i = 0; i < clients.length; i++) {
          if (clients[i].url.indexOf(self.location.origin) === 0) {
            return clients[i].focus();
          }
        }
        return self.clients.openWindow(url);
      })
  );
});
