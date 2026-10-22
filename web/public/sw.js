// Retired (DECISIONS H-019): the TV serves its own pages, an offline cache only added risk (it kept a half-copied
// script from a deploy). This version removes every cache, unregisters itself and reloads the open pages.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
