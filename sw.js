// SPDX-License-Identifier: GPL-3.0-only
// SLOOP live works offline once opened: the page and its files from the cache, refreshed in the background.
const CACHE = "sloop-live-2";
const FILES = ["./", "index.html", "app.js", "proto.js", "transports.js", "device.js", "widgets.js", "parts.js", "live.js",
  "arrange.js", "sound.js", "mix.js", "next.js", "mock.js", "mockdata.js", "terminus.ttf",
  "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
