/// <reference lib="webworker" />
// CobraTex service worker (vite-plugin-pwa, strategy "injectManifest").
//  1) Precaches the static build assets (hashed JS/CSS/icons) — fast loads, safe to cache.
//  2) NEVER caches API / Supabase data (financial data stays network-only, same policy as before).
//  3) Navigation: network first; offline -> /offline.html (same behavior as the previous sw.js).
//  4) Update flow unchanged: the new SW waits until the user taps "update" (SKIP_WAITING message,
//     handled by src/cloud/updates.tsx).
//  5) Web Push handlers copied unchanged from the old public/sw.js.
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

registerRoute(
  new NavigationRoute(async ({ request }) => {
    try {
      return await fetch(request);
    } catch {
      return (await matchPrecache('/offline.html')) ?? Response.error();
    }
  }),
);

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
});

async function brandTitle(): Promise<string> {
  try {
    const res = await fetch('/brand.json', { cache: 'no-store' });
    const b = (await res.json()) as { appName?: string };
    return b.appName || 'CobraTex';
  } catch {
    return 'CobraTex';
  }
}

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: { title?: string; body?: string };
  try {
    payload = event.data.json();
  } catch {
    payload = { title: '', body: event.data.text() };
  }
  event.waitUntil(
    brandTitle().then((fallbackTitle) =>
      self.registration.showNotification(payload.title || fallbackTitle, {
        body: payload.body || '',
        icon: '/icon-192.png',
        dir: 'rtl',
        lang: 'ar',
      }),
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientsList) => {
      if (clientsList.length > 0) return clientsList[0].focus();
      return self.clients.openWindow('/');
    }),
  );
});
