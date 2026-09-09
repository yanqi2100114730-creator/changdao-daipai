/* 代拍工作台 Service Worker —— 离线缓存（版本更新时改 CACHE 名即可） */
var CACHE = "daipai-workbench-v5";

var PRECACHE = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "ocr.js",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/icon.ico"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () { /* 单个失败不阻塞 */ });
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  // 跨域资源（二维码库等）不缓存，走网络
  if (url.origin !== location.origin) return;
  // OCR 引擎体积大（约 27MB），不进缓存，交给浏览器 HTTP 缓存
  if (url.pathname.indexOf("/vendor/") > -1) return;

  // 页面导航：网络优先，离线回退缓存
  if (req.mode === "navigate" || (req.headers.get("accept") || "").indexOf("text/html") > -1) {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put("./index.html", copy); });
        return res;
      }).catch(function () {
        return caches.match("./index.html").then(function (r) {
          return r || caches.match("./");
        });
      })
    );
    return;
  }

  // 静态资源：缓存优先，后台更新
  e.respondWith(
    caches.match(req).then(function (cached) {
      var fetching = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return cached;
      });
      return cached || fetching;
    })
  );
});
