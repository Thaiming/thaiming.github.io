/* 주간 루틴 체크 - 오프라인 캐시 */
var CACHE = 'weekly-routine-v4';
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

  /* 문서(화면)는 네트워크 우선: 새로 배포한 화면이 바로 반영되고, 오프라인일 때만 캐시를 쓴다 */
  if(isDoc){
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(function(res){
        if(res && res.ok){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
        }
        return res;
      }).catch(function(){
        return caches.match(req, { ignoreSearch: true }).then(function(hit){
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  /* 그 밖의 파일은 캐시 먼저 (빠른 오프라인), 뒤에서 최신본으로 조용히 갱신 */
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function(hit){
      if(hit){
        var update = fetch(req);
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
