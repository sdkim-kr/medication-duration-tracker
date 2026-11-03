// Feature: medication-duration-tracker — PWA 서비스 워커
// 앱 셸(정적 자원)을 캐시하여 오프라인에서도 열리도록 한다.
// 데이터는 IndexedDB/localStorage에 저장되며 서비스 워커는 코드 자원만 캐시한다.

const CACHE_VERSION = "mdt-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./src/constants.js",
  "./src/validation.js",
  "./src/pii.js",
  "./src/Record_Parser.js",
  "./src/Text_Input_Module.js",
  "./src/Voice_Input_Module.js",
  "./src/Record_Store.js",
  "./src/save_pipeline.js",
  "./src/Analysis_Engine.js",
  "./src/Comparison_Engine.js",
  "./src/retry.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // 일부 자원이 실패해도 설치가 막히지 않도록 개별 추가한다.
      .then((cache) =>
        Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE_VERSION)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// 정적 자원은 cache-first, 그 외(동일 출처 네비게이션)는 네트워크 우선·실패 시 캐시 폴백.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 요청은 건드리지 않는다.

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      });
    })
  );
});
