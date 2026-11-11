// ALPHA TERMINAL service worker: Web Push notifications ONLY.
//
// * There is deliberately NO "fetch" handler and NO Cache Storage: every page, API response and price comes from
//   the network, exactly as without a service worker. Financial data is never served from a cache.
// * Registered only when the user enables notifications on this device (Settings), and unregistered when they
//   disable them.
// * A push payload carries only the notification text and a same-origin path to open: never credentials or secrets.

const DEFAULT_URL = "/";

/** Only same-origin app paths may be opened ("/trades/12"), never another site. */
function safePath(u) {
  return typeof u === "string" && u.startsWith("/") && !u.startsWith("//") && !u.includes("\\") ? u : DEFAULT_URL;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Remove any cache an older build may have left behind: nothing here ever reads one.
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : "" };
  }
  const title = typeof d.title === "string" && d.title ? d.title.slice(0, 120) : "ALPHA TERMINAL";
  const options = {
    body: typeof d.body === "string" ? d.body.slice(0, 240) : "",
    tag: typeof d.tag === "string" ? d.tag.slice(0, 120) : undefined, // same event twice → replaced, never stacked
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    timestamp: Date.now(),
    data: { url: safePath(d.url) },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  const target = new URL(path, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          return w.focus().then((f) => (f && "navigate" in f ? f.navigate(target) : f));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// The push service rotated this device's subscription. The app re-registers it the next time it is opened
// (Settings shows the device as needing re-enable); the old endpoint is retired by the Worker on 404/410.
self.addEventListener("pushsubscriptionchange", () => {});
