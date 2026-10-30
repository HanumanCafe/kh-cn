// sw.js — Service Worker: រក្សាទុកឯកសារកម្មវិធី ដើម្បីបើកលឿន និងបើកបានពេលអ៊ីនធឺណិតខ្សោយ
// (ការបកប្រែនៅតែត្រូវការអ៊ីនធឺណិត)
// ពេលកែកូដ សូមប្តូរលេខ CACHE (ឧ. v2) ដើម្បីឲ្យទូរសព្ទយកកំណែថ្មី។

const CACHE = 'khcn-v5';
const FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/store.js',
  './js/recorder.js',
  './js/gemini.js',
  './js/speaker.js',
  './manifest.webmanifest',
  './fonts/kantumruy-khmer-400.woff2',
  './fonts/kantumruy-khmer-500.woff2',
  './fonts/kantumruy-khmer-700.woff2',
  './fonts/kantumruy-latin-400.woff2',
  './fonts/kantumruy-latin-500.woff2',
  './fonts/kantumruy-latin-700.woff2',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// យកពីអ៊ីនធឺណិតមុន (ដើម្បីបានកំណែថ្មី) បើគ្មានអ៊ីនធឺណិត ទើបយកពី cache
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // មិនប៉ះពាល់ការហៅ Gemini
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
