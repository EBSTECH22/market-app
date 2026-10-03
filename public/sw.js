self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: "Community Harvest", body: event.data ? event.data.text() : "" }; }
  const opts = {
    body: data.body || "",
    icon: "/logo-192.png",
    badge: "/logo-192.png",
    data: { url: data.url || "/vendor" },
  };
  /* One notification per conversation: a busy chat replaces its last alert
     (and still buzzes) instead of stacking thirty of them. */
  if (data.tag) { opts.tag = data.tag; opts.renotify = true; }
  event.waitUntil(self.registration.showNotification(data.title || "Community Harvest", opts));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/vendor";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).pathname === new URL(url, self.location.origin).pathname && "focus" in w) {
          if ("navigate" in w) w.navigate(url).catch(() => {});
          return w.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
