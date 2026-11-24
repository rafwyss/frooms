// Service worker: keeps the app shell available offline. Room data and everything about accounts (/api/*: /api/me,
// /api/friends, /api/people, /api/checkin, …) is never cached here, so the page can't
// show stale availability as if it were live. Menus are the exception: they don't change by the minute, so the last
// menus seen stay readable offline (network first, the cache only when offline).
"use strict";

const CACHE = "frooms-shell-v84";
const MENU_CACHE = "frooms-menus-v1";
const MENU_PATHS = ["/api/menu", "/api/menus"];
const SHELL = [
  "/",
  "/app.js",
  "/geo.js",
  "/lib.js",
  "/picker.js",
  "/sheet.js",
  "/map.js",
  "/places.js",
  "/account.js",
  "/friends.js",
  "/cred.js",
  "/bugs.js",
  "/checkin.js",
  "/ratings.js",
  "/tutorial.js",
  "/map/Z.json",
  "/map/H.json",
  "/map/UZ.json",
  "/map/UI.json",
  "/map/UO.json",
  "/map/pins.json",
  "/map/overview.json",
  "/map/region/index.json",
  "/mensa-photos/index.json",
  "/style.css",
  "/logo.svg",
  "/fonts/Archivo.woff2",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
  "/icons/trusted.svg",
  "/icons/whatsapp.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== MENU_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so a new deploy shows up on the next load; the cached shell is only the offline fallback.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only GETs: the usage beacon (POST /api/stats) and every other change go straight to the network, never queued.
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (MENU_PATHS.includes(url.pathname)) return event.respondWith(menu(event.request));
  // Sign-in (/auth/*) goes straight to the network: its redirects to SWITCH and back must never meet the cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  // The admin page (/admin, admin.js, admin.css) is never cached nor answered with the app shell when offline.
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin.") || url.pathname.startsWith("/admin/")) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(event.request);
      // Other pages (e.g. /experiment) must not replace the cached app shell.
      const navigate = event.request.mode === "navigate";
      if (fresh.ok && (!navigate || url.pathname === "/")) cache.put(navigate ? "/" : event.request, fresh.clone());
      return fresh;
    } catch (e) {
      const cached = await cache.match(event.request.mode === "navigate" ? "/" : event.request, { ignoreSearch: true });
      if (cached) return cached;
      throw e;
    }
  })());
});

/** A menu from the network (kept for later), or the kept copy when offline. */
async function menu(request) {
  const cache = await caches.open(MENU_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}
