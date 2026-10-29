const CACHE = 'qallab-v9';
const ASSETS = [
  "./",
  "app.js",
  "design-tokens.css",
  "editor.js",
  "viewer.js",
  "fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2",
  "fonts/ibm-plex-sans-arabic-arabic-600-normal.woff2",
  "fonts/ibm-plex-sans-arabic-latin-400-normal.woff2",
  "fonts/ibm-plex-sans-arabic-latin-600-normal.woff2",
  "icons/icon-192-maskable.png",
  "icons/icon-192.png",
  "icons/icon-512-maskable.png",
  "icons/icon-512.png",
  "index.html",
  "lib/UTIF.js",
  "lib/heic2any.min.js",
  "lib/jszip.min.js",
  "lib/pako.min.js",
  "lib/pdf-lib.min.js",
  "lib/pdf.min.js",
  "lib/pdf.worker.min.js",
  "manifest.webmanifest",
  "styles.css",
];
self.addEventListener('install', (e) => {
  // cache:'reload' skips the HTTP cache (GitHub Pages sends max-age=600), so a new version never stores stale files
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
