/* Lumi To-Do — Service Worker
   策略：
   - 導航請求（開 App）：network-first，離線時回快取，確保不會卡在舊版
   - 同源靜態資源（icon / manifest）：cache-first + 背景更新
   - CDN 依賴（tailwind / lucide / supabase-js / lunar）：stale-while-revalidate
   - 其他（Supabase API 等）：直接走網路，不介入
*/
const VER = 'v24';
const CACHE = 'lumi-shell-' + VER;
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './favicon-192.png',
  './favicon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) 開 App 的導航請求：先抓網路，失敗才用快取
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // 2) 同源靜態：快取優先
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // 3) CDN 依賴：先用快取、背景更新
  if (/cdn\.jsdelivr\.net|unpkg\.com|cdn\.tailwindcss\.com/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && (res.status === 200 || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // 4) 其他（Supabase API / Edge Function）：不快取
});
