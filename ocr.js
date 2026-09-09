/* ============================================================
 *  ocr.js —— 订单截图识别
 *  1) compressImage : 图片压缩（控制 localStorage 体积）
 *  2) recognize     : OCR 识别（优先用站点自带 vendor 引擎，失败再回退 CDN）
 *  3) parseOrder    : 从识别文本中解析平台/订单号/实付金额/买家
 * ============================================================ */
(function (global) {
  "use strict";

  /* ---------- 引擎来源：本地优先 ---------- */
  // worker 内部解析相对路径时基准不是页面，统一转成绝对地址避免 404
  function abs(p) {
    try { return new URL(p, document.baseURI).href; } catch (e) { return p; }
  }
  var SOURCES = [
    {
      name: "本地引擎",
      js: "vendor/tesseract.min.js",
      workerPath: abs("vendor/worker.min.js"),
      corePath: abs("vendor/tesseract-core-simd-lstm.wasm.js"),
      langPath: abs("vendor/tessdata")
    },
    {
      name: "jsDelivr",
      js: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
      workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
      corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js",
      langPath: "https://cdn.jsdelivr.net/npm/@tesseract.js-data/chi_sim@1.0.0/4.0.0"
    },
    {
      name: "unpkg",
      js: "https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js",
      langPath: "https://unpkg.com/@tesseract.js-data/chi_sim@1.0.0/4.0.0"
    },
    {
      name: "备用源",
      js: "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js",
      langPath: "https://tessdata.projectnaptha.com/4.0.0"
    }
  ];

  /* ---------- 图片压缩 ---------- */
  function compressImage(file, maxSide, quality) {
    maxSide = maxSide || 1100;
    quality = quality || 0.72;
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error("未选择文件")); return; }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("图片读取失败")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("图片解析失败，请换一张图片")); };
        img.onload = function () {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          var nw = Math.max(1, Math.round(w * scale));
          var nh = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement("canvas");
          canvas.width = nw; canvas.height = nh;
          var ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, nw, nh);
          ctx.drawImage(img, 0, 0, nw, nh);
          try {
            resolve(canvas.toDataURL("image/jpeg", quality));
          } catch (e) {
            reject(new Error("图片处理失败"));
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- 加载脚本 ---------- */
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("无法加载 " + url)); };
      document.head.appendChild(s);
    });
  }

  var loadedJs = null;
  function ensureScript(src) {
    if (global.Tesseract && loadedJs === src.js) return Promise.resolve(global.Tesseract);
    return loadScript(src.js).then(function () {
      loadedJs = src.js;
      if (!global.Tesseract) throw new Error("脚本未导出 Tesseract");
      return global.Tesseract;
    });
  }

  /* ---------- OCR 主体 ---------- */
  function attempt(src, image, onProgress) {
    return ensureScript(src).then(function (T) {
      var opts = {
        logger: function (m) {
          if (!onProgress) return;
          var p = Math.min(1, m.progress || 0);
          var label = (m.status === "recognizing text") ? "识别中"
            : (m.status === "loading language traineddata" ? "加载识别包"
              : (m.status === "initializing tesseract" ? "初始化引擎" : "准备中"));
          onProgress(p, label, src.name);
        }
      };
      if (src.workerPath) opts.workerPath = src.workerPath;
      if (src.corePath) opts.corePath = src.corePath;
      if (src.langPath) opts.langPath = src.langPath;

      return T.createWorker(["chi_sim"], 1, opts).then(function (worker) {
        return worker.recognize(image).then(function (res) {
          return worker.terminate().then(function () { return res; }, function () { return res; });
        }, function (err) {
          return worker.terminate().then(function () { throw err; }, function () { throw err; });
        });
      });
    });
  }

  function recognize(imageDataUrl, onProgress) {
    var chain = Promise.reject(null);
    SOURCES.forEach(function (src) {
      chain = chain.catch(function (prev) {
        if (prev) console.warn("[OCR] " + src.name + " 之前的来源失败：", prev.message || prev);
        return attempt(src, imageDataUrl, onProgress);
      });
    });
    return chain.then(function (res) {
      var text = (res && res.data && res.data.text) ? res.data.text : "";
      return { text: text, fields: parseOrder(text) };
    }).catch(function (err) {
      console.error("[OCR] 全部来源均失败", err);
      var msg = (err && err.message) ? err.message : String(err);
      throw new Error("识别失败：" + msg + "。可稍后重试，或直接在下方手动填写");
    });
  }

  /* ---------- 字段解析 ---------- */
  var PLATFORMS = [
    "微信小程序", "微信小店", "网易严选", "天猫超市", "天猫", "淘宝", "京东", "拼多多", "唯品会",
    "得物", "抖音商城", "抖音", "快手小店", "快手", "小红书", "闲鱼", "苏宁", "微店",
    "1688", "阿里巴巴", "视频号", "支付宝", "美团", "饿了么", "盒马"
  ];

  function clean(s) {
    return (s || "").replace(/^[\s:：,，.。、|]+/, "").replace(/[\s,，。;；|]+$/, "").trim();
  }

  function findPlatform(text) {
    for (var i = 0; i < PLATFORMS.length; i++) {
      if (text.indexOf(PLATFORMS[i]) > -1) return PLATFORMS[i];
    }
    return "";
  }

  function findOrderNo(text) {
    var m;
    var labeled = [
      /(?:订单编号|订单号|单号|订单ID|订单id)\s*[:：]?\s*([0-9A-Za-z\-]{8,32})/,
      /(?:编号)\s*[:：]?\s*([0-9A-Za-z\-]{8,32})/
    ];
    for (var i = 0; i < labeled.length; i++) {
      m = text.match(labeled[i]);
      if (m && m[1] && m[1].length >= 8) return clean(m[1]);
    }
    m = text.match(/\d{15,28}/);
    if (m) return m[0];
    m = text.match(/\d{10,14}/);
    if (m) return m[0];
    return "";
  }

  function findPaid(text) {
    var m;
    var numPat = "([0-9][0-9,]*(?:\\.[0-9]{1,2})?)";
    var labeled = [
      new RegExp("(?:实付款|实付金额|实付|应付金额|应付|已付款|已付|付款金额|订单金额|合计|总价|总额|商品总价)\\s*[:：]?\\s*[¥￥]?\\s*" + numPat),
      /(?:实付款|实付金额|实付|应付|已付|合计|总价)[^\n]{0,10}?([0-9][0-9,]*\.[0-9]{2})/
    ];
    var toNum = function (s) { return parseFloat(String(s).replace(/,/g, "")); };
    for (var i = 0; i < labeled.length; i++) {
      m = text.match(labeled[i]);
      if (m && m[1]) {
        var v = toNum(m[1]);
        if (!isNaN(v) && v > 0) return v.toFixed(2);
      }
    }
    var all = text.match(/[¥￥]\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/g) || [];
    var nums = all.map(function (s) { return toNum(s.replace(/[^\d.]/g, "")); })
      .filter(function (n) { return !isNaN(n) && n > 0; });
    if (nums.length) return Math.max.apply(null, nums).toFixed(2);
    var dec = text.match(/\d[\d,]*\.\d{2}/g) || [];
    var dn = dec.map(toNum).filter(function (n) { return n > 0 && n < 1000000; });
    if (dn.length) return Math.max.apply(null, dn).toFixed(2);
    return "";
  }

  function findBuyer(text) {
    var m;
    var patterns = [
      /(?:收货人|收件人|收货|买家昵称|买家|联系人|客户|昵称|收件)\s*[:：]\s*([^\n\r,，;；。]{1,20})/,
      /(?:收货人|收件人|买家|联系人|客户|昵称)\s+([^\n\r,，;；。]{2,20})/
    ];
    for (var i = 0; i < patterns.length; i++) {
      m = text.match(patterns[i]);
      if (m && m[1]) {
        var name = clean(m[1]);
        if (name && name.length <= 24 && !/^\d+$/.test(name)) {
          var phone = text.match(/1[3-9]\d{9}/);
          if (phone && name.indexOf(phone[0]) > -1) return name;
          return phone ? name + " " + phone[0] : name;
        }
      }
    }
    var p = text.match(/1[3-9]\d{9}/);
    if (p) return p[0];
    return "";
  }

  function parseOrder(text) {
    var t = (text || "").replace(/\r/g, "");
    return {
      platform: findPlatform(t),
      orderNo: findOrderNo(t),
      paid: findPaid(t),
      buyer: findBuyer(t)
    };
  }

  global.DaipaiOCR = {
    compressImage: compressImage,
    recognize: recognize,
    parseOrder: parseOrder
  };
})(window);
