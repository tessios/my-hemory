/* Hemory 개인용 서비스 워커 — 앱 껍데기만 캐시. 드라이브/제미나이 응답은 절대 캐시하지 않는다.
   v1.3.3: 뒤집어 녹음 감지(js/flip.js) 분리. v1.3.2: 네트워크 우선으로 바꿔 새 버전이 다음 실행에 바로 반영되게 했다.
           (예전에는 캐시 먼저라서 예전 화면·예전 코드가 계속 열렸다) */
const VERSION = "hemory-v1.3.3";
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
  "./js/flip.js",
  "./js/util.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./demo/demo-transcripts.json",
];

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const NETWORK_FIRST = /\.(?:html|js|css|webmanifest)$/i;

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  // 개인 데이터·API 는 서비스 워커를 거치지 않는다
  if (url.hostname.includes("googleapis.com") || url.hostname.includes("accounts.google.com") ||
      url.hostname.includes("generativelanguage.googleapis.com")) return;

  if (url.origin !== location.origin) return;

  const isDoc = req.mode === "navigate" || url.pathname.endsWith("/") || !url.pathname.split("/").pop().includes(".");
  const networkFirst = isDoc || NETWORK_FIRST.test(url.pathname);

  if (networkFirst) {
    // 새 버전이 바로 반영되도록 네트워크부터, 실패하면 캐시
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  // 아이콘 같은 고정 자산은 캐시 먼저
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
