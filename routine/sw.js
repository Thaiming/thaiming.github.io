/* 주간 루틴 체크 - 오프라인 캐시 */
var CACHE = 'weekly-routine-v3';
var ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './apple-touch-icon.png',
  './icon-512.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      /* 설치 시에는 항상 최신본을 받아 캐시한다 */
      return Promise.all(ASSETS.map(function(url){
        return fetch(new Request(url, { cache: 'reload' })).then(function(res){
          if(res && res.ok) return c.put(url, res);
        }).catch(function(){});
      }));
    }).catch(function(){}).then(function(){
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k !== CACHE) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch(err) { return; }
  if(url.origin !== self.location.origin) return;

  var isDoc = (req.mode === 'navigate') || /\.html?$/.test(url.pathname);

  /* 캐시 먼저 (빠른 오프라인), 문서는 뒤에서 최신본으로 조용히 갱신 */
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function(hit){
      if(hit){
        var update = fetch(req, isDoc ? { cache: 'no-store' } : {});
        update.then(function(res){
          if(res && res.ok){
            caches.open(CACHE).then(function(c){ c.put(req, res.clone()); });
          }
        }).catch(function(){});
        return hit;
      }
      return fetch(req).then(function(res){
        if(res && res.ok && res.type === 'basic'){
          caches.open(CACHE).then(function(c){ c.put(req, res.clone()); });
        }
        return res;
      }).catch(function(){
        return caches.match('./index.html');
      });
    })
  );
});
