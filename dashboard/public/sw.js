/**
 * Nova PWA Service Worker
 *
 * Strategy:
 *  - Network-first for HTML and navigations: always serve the freshest
 *    document so it references the chunk hashes that actually exist on the
 *    server. Cache only as offline fallback.
 *  - Cache-first for content-hashed assets under /assets/: Vite hashes the
 *    filename, so the file at a given URL is immutable forever — safe to
 *    cache with no revalidation.
 *  - Cache-first for static media (icons, fonts) for the same reason.
 *  - Pass-through for API, WebSocket, and HMR traffic.
 *
 * The previous version used stale-while-revalidate for the app shell,
 * which served a cached index.html referencing chunk hashes that no longer
 * existed on the server after a deploy → "Failed to fetch dynamically
 * imported module" errors on lazy-loaded routes. Bumping CACHE_NAME nukes
 * any leftover broken cache from that strategy.
 */

const CACHE_NAME = 'nova-shell-v4'

// Static media we want available offline. Notably absent: '/' and HTML —
// those go network-first so the chunk-hash references stay current.
const STATIC_PRECACHE = [
  '/manifest.json',
  '/nova-icon.png',
  '/nova-icon-192.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_PRECACHE))
  )
  // Activate immediately without waiting for old SW to stop
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Clean up old caches when a new version deploys
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)

  // Never cache API calls, WebSocket upgrades, or dev server HMR
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/v1') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/recovery-api') ||
    url.pathname.startsWith('/cortex-api') ||
    url.pathname.startsWith('/voice-api') ||
    url.pathname.includes('hot-update') ||
    event.request.method !== 'GET'
  ) {
    return // Fall through to network
  }

  // Navigations and HTML: network-first, cache fallback for offline.
  // This guarantees the document we serve always references chunk hashes
  // that exist on the server — the root cause of stale-bundle 404s.
  const isNavigation = event.request.mode === 'navigate'
  const isHTML = event.request.headers.get('accept')?.includes('text/html')
  if (isNavigation || isHTML) {
    event.respondWith(
      // cache:'no-store' — a plain fetch(request) may be answered by the HTTP
      // cache, resurrecting a stale shell despite "network-first". Fetch by
      // URL: re-wrapping a mode:'navigate' Request throws in Chromium.
      fetch(event.request.url, { cache: 'no-store', credentials: 'same-origin' })
        .then((resp) => {
          const clone = resp.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          return resp
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
    )
    return
  }

  // Content-hashed assets (Vite emits /assets/<name>-<hash>.<ext>): cache
  // forever — the URL itself changes when the content changes, so there is
  // no staleness risk. This is what makes long-cache + content-hash work.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((resp) => {
          // Only cache successful responses — don't poison the cache with 404s
          if (resp.ok) {
            const clone = resp.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return resp
        })
      )
    )
    return
  }

  // Static media (icons, fonts): cache-first
  if (url.pathname.match(/\.(png|jpg|jpeg|svg|ico|webp|woff2?|ttf|eot)$/)) {
    event.respondWith(
      caches.match(event.request).then((cached) =>
        cached || fetch(event.request).then((resp) => {
          if (resp.ok) {
            const clone = resp.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone))
          }
          return resp
        })
      )
    )
    return
  }

  // Default: pass through to network with cache fallback for offline
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  )
})
