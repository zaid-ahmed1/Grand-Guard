// Ally service worker. Deliberately has no fetch handler and no cache: the page is always live from the laptop,
// and the event stream must never be intercepted. It exists so the app can be installed and can show notifications.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()))
self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({type: "window", includeUncontrolled: true}).then((list) => (list.length ? list[0].focus() : self.clients.openWindow("/"))),
  )
})
