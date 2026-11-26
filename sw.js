/* Hemory 개인용 서비스 워커 — 앱 껍데기만 캐시. 드라이브/제미나이 응답은 절대 캐시하지 않는다.
   v1.6.1: 예약녹음 '말한 구간' 측정 복구(AudioContext 잠금 → 탭·복귀 시 깨움).
   v1.6.0: 전사 완료 자동 반영(화면 복귀·포커스·20~30초 주기 자동 동기화).
   v1.5.1: 버전·캐시 키를 올리고, 설치 즉시 활성화(skipWaiting) + version.json 은 캐시 금지.
           아이폰 홈화면 앱에 구버전 화면·구버전 코드가 남지 않게 하는 것이 목적이다.
           (앱 js/app.js 도 version.json 과 대조해 다르면 캐시를 지우고 새로 연다)
   v1.5.0: 다크 타임라인 UI(4탭) + 백그라운드 복귀 시 마이크·센서 재요청 제거(js/lifecycle.js 추가).
   v1.4.1: 뒤집어 녹음 마이크 연결 유지(스트림 재사용·keepMic) — 엎을 때마다 재세팅하지 않는다.
   v1.4.0: 30분 세그먼트·선택 삭제·Blob 재생·무음 감지(js/pure.js 추가).
   v1.3.2: 네트워크 우선으로 바꿔 새 버전이 다음 실행에 바로 반영되게 했다. */
const VERSION = "hemory-v1.6.1";
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
  "./js/lifecycle.js",
  "./js/flow.js",
  "./js/pure.js",
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
  // 새 워커를 곧바로 대기열에서 꺼내 활성화한다(구버전이 계속 잡고 있지 않게)
  self.skipWaiting();
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

  // 버전 확인 파일은 항상 네트워크에서 새로 받는다(캐시에 남으면 업데이트 판정이 틀어진다)
  if (url.pathname.endsWith("/version.json")) {
    e.respondWith(fetch(req, { cache: "no-store" }).catch(() => new Response("{}", { headers: { "Content-Type": "application/json" } })));
    return;
  }

  const isDoc = req.mode === "navigate" || url.pathname.endsWith("/") || !url.pathname.split("/").pop().includes(".");
  const networkFirst = isDoc || NETWORK_FIRST.test(url.pathname);

  if (networkFirst) {
    // 새 버전이 바로 반영되도록 네트워크부터, 실패하면 캐시.
    //   cache:'no-cache' — 브라우저 HTTP 캐시(깃허브 페이지는 max-age=600)에 남은
    //   옛 config.js·app.js 를 그대로 쓰지 않고 서버에 재검사를 받는다.
    //   (이게 없으면 새 index 를 받아도 안쪽 모듈이 옛 버전이라 버전 판정이 어긋난다)
    e.respondWith(
      fetch(req, { cache: "no-cache" }).then((res) => {
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
