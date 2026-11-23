const PREFIX = 'yangtze-runoff-shell-'
const CACHE = PREFIX + '__BUILD_VERSION__'
const SHELL = ['/', '/index.html', '/app.js', '/pwa.js', '/runoff.js', '/rain-import.js', '/rain-worker.js', '/data-origin.js', '/region-scope.js', '/personal-rain-store.js', '/style.css',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  if (event.request.mode !== 'navigate' && !SHELL.includes(url.pathname)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const response = await fetch(event.request)
      if (response.ok) await cache.put(event.request, response.clone())
      return response
    } catch {
      const cached = await cache.match(event.request) ||
        (event.request.mode === 'navigate' ? await cache.match('/') : null)
      return cached || Response.error()
    }
  })())
})
