/* Hemory 개인용 서비스 워커 — 앱 껍데기만 캐시. 드라이브/제미나이 응답은 절대 캐시하지 않는다. */
const VERSION = "hemory-v1.2.0";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/config.js",
  "./js/drive.js",
  "./js/store.js",
  "./js/search.js",
  "./js/qa.js",
  "./js/record.js",
  "./js/util.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./demo/demo-transcripts.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  // 개인 데이터·API 는 서비스 워커를 거치지 않는다
  if (url.hostname.includes("googleapis.com") || url.hostname.includes("accounts.google.com") ||
      url.hostname.includes("generativelanguage.googleapis.com")) return;

  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const fetched = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
      return hit || fetched;
    })
  );
});
