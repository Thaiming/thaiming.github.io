/* 밍톡 Service Worker — 오프라인에서도 앱이 열리도록 함
 * 전략: same-origin GET = Network-first → 실패 시 캐시 (navigate 요청은 index.html로 폴백)
 */
'use strict';

var CACHE_NAME = 'mingtalk-v1';
var PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './apple-touch-icon.png',
  './icon-512.png'
];

/* install: 앱 껍데기를 미리 저장하고 곧바로 활성화 */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(PRECACHE_URLS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

/* activate: 이전 버전 캐시를 지우고 열려 있는 페이지를 바로 제어 */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          if (key === CACHE_NAME) return false;
          return caches.delete(key);
        }));
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/* fetch: 네트워크 먼저, 실패하면 캐시 */
self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME)
            .then(function (cache) {
              return cache.put(request, copy);
            })
            .catch(function () {});
        }
        return response;
      })
      .catch(function () {
        return caches.match(request)
          .then(function (cached) {
            if (cached) return cached;
            if (request.mode === 'navigate') {
              return caches.match('./index.html');
            }
            return null;
          })
          .then(function (result) {
            if (result) return result;
            return new Response('오프라인 상태이고 캐시에 없는 요청입니다.', {
              status: 504,
              statusText: 'Offline',
              headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
          });
      })
  );
});
