/* ============================================================
 *  app.js —— 长岛团队代拍记录（团队版，数据独立于个人版）
 * ============================================================ */
(function () {
  "use strict";

  /* ============ 常量 ============ */
  var STORAGE_KEY = "changdao_team_daipai_orders_v1";
  var LEGACY_KEY = "changdao_team_daipai_legacy_v1";
  var SETTLE_LIST = ["待结算", "已结算"];
  var MAX_IMAGES = 3;

  var VIEWS = [
    { id: "all", name: "全部代拍记录" },
    { id: "unsettled", name: "待结算佣金订单" }
  ];

  var CSV_HEADERS = [
    ["platform", "代拍平台"], ["orderTime", "下单日期"], ["orderNo", "订单编号"], ["product", "商品名称"],
    ["payInfo", "结算方式/实付金额"], ["client", "帮谁代拍（委托人）"], ["commission", "佣金金额"],
    ["selfCommission", "自己所得佣金"], ["settleStatus", "佣金结算状态"],
    ["buyer", "买家信息"], ["remark", "备注"], ["imgCount", "凭证图片张数"]
  ];

  /* ============ 状态 ============ */
  var orders = [];
  var state = {
    view: "all",
    product: "",
    platform: "",
    client: "",
    settle: "",
    date: "",
    q: "",
    sortKey: "orderTime",
    sortDir: "desc"
  };
  var collapsedGroups = {};   // 日期分组折叠状态：{ "2026-09-08": true }
  var editingId = null;
  var pendingImages = [];     // 表单中待保存的图片（dataURL）
  var pendingOcrImage = null; // 当前待识别图片

  /* ============ 工具 ============ */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function money(n) {
    var v = Number(n);
    if (isNaN(v)) v = 0;
    return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function num(n) { var v = Number(n); return isNaN(v) ? 0 : v; }
  function uid() { return "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function toDate(s) {
    if (!s) return "";
    var str = String(s).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : "";
  }
  function monthOf(s) { return !s ? "" : String(s).slice(0, 7); }
  function imgs(o) { return Array.isArray(o.images) ? o.images : []; }
  // 从自由填写的「结算方式/实付金额」文本里解析出金额，用于统计合计
  function extractAmount(s) {
    if (!s) return 0;
    var nums = String(s).match(/[¥￥]?\s*(\d+(?:\.\d{1,2})?)/g);
    if (!nums || !nums.length) return 0;
    // 取文本里最后一个数字（通常是实付金额）
    var last = nums[nums.length - 1].replace(/[¥￥\s]/g, "");
    var v = parseFloat(last);
    return isNaN(v) ? 0 : v;
  }
  function payNum(o) { return extractAmount(o.payInfo); }
  function toast(msg, ms) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, ms || 2400);
  }

  /* ============ 数据 ============ */
  function normalize(o) {
    // 兼容旧版本（v2 用 paid + settleBy 两个字段），自动合并成 payInfo
    var payInfo = o.payInfo;
    if (!payInfo) {
      var sb = o.settleBy || "";
      var pa = num(o.paid);
      payInfo = (sb ? sb + "，" : "") + (pa ? "实付 " + pa : "");
      payInfo = payInfo.replace(/，\s*$/, "");
    }
    return {
      id: o.id || uid(),
      platform: o.platform || "",
      orderTime: toDate(o.orderTime),
      orderNo: o.orderNo || "",
      product: o.product || "",
      payInfo: payInfo,
      client: o.client || "",
      commission: num(o.commission),
      selfCommission: (o.selfCommission === undefined || o.selfCommission === null || o.selfCommission === "")
        ? num(o.commission) : num(o.selfCommission),
      settleStatus: SETTLE_LIST.indexOf(o.settleStatus) > -1 ? o.settleStatus : "待结算",
      buyer: o.buyer || "",
      remark: o.remark || "",
      images: Array.isArray(o.images) ? o.images.slice(0, MAX_IMAGES) : [],
      updatedAt: o.updatedAt || ""
    };
  }
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    if (!raw) {
      try { raw = localStorage.getItem(LEGACY_KEY); } catch (e) { /* ignore */ }
    }
    if (raw) {
      try {
        var arr = JSON.parse(raw);
        orders = Array.isArray(arr) ? arr.map(normalize) : [];
      } catch (e) {
        console.error("数据读取失败", e);
        orders = [];
      }
    } else {
      orders = [];
    }
  }
  function save() {
    var payload = JSON.stringify(orders);
    try {
      localStorage.setItem(STORAGE_KEY, payload);
      return true;
    } catch (e) {
      try {
        var lean = JSON.stringify(orders.map(function (o) {
          var c = Object.assign({}, o); c.images = []; return c;
        }));
        localStorage.setItem(STORAGE_KEY, lean);
        toast("存储空间已满，已保存但凭证图片未写入，请删除部分图片");
        return false;
      } catch (e2) {
        toast("保存失败：本地存储空间不足，请先导出备份并清理数据");
        console.error(e2);
        return false;
      }
    }
  }

  /* ============ 筛选 / 排序 ============ */
  function viewFiltered(list) {
    if (state.view === "unsettled") return list.filter(function (o) { return o.settleStatus === "待结算"; });
    return list;
  }
  function toolFiltered(list) {
    var q = state.q.trim().toLowerCase();
    return list.filter(function (o) {
      if (state.platform && o.platform !== state.platform) return false;
      if (state.client && o.client !== state.client) return false;
      if (state.settle && o.settleStatus !== state.settle) return false;
      if (state.date && String(o.orderTime || "").slice(0, 10) !== state.date) return false;
      if (state.product) {
        var p = state.product.trim().toLowerCase();
        if (String(o.product || "").toLowerCase().indexOf(p) === -1) return false;
      }
      if (q) {
        var hay = [o.orderNo, o.product, o.client, o.buyer, o.platform, o.remark, o.payInfo]
          .map(function (x) { return String(x || ""); }).join(" ").toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }
  function sorted(list) {
    var arr = list.slice();
    var k = state.sortKey, dir = state.sortDir === "asc" ? 1 : -1;
    arr.sort(function (a, b) {
      if (k === "paid" || k === "commission" || k === "selfCommission") {
        return (num(a[k]) - num(b[k])) * dir;
      }
      var va = String(a[k] || ""), vb = String(b[k] || "");
      return va < vb ? -dir : (va > vb ? dir : 0);
    });
    return arr;
  }
  function currentList() { return sorted(toolFiltered(viewFiltered(orders))); }

  /* ============ 统计 ============ */
  function renderStats() {
    var curMonth = monthOf(todayStr());
    var m = orders.filter(function (o) { return monthOf(o.orderTime) === curMonth; });
    var monthCount = m.length;
    var monthAmount = m.reduce(function (s, o) { return s + payNum(o); }, 0);
    var monthComm = m.reduce(function (s, o) { return s + num(o.commission); }, 0);
    var monthSelf = m.reduce(function (s, o) { return s + num(o.selfCommission); }, 0);
    var un = orders.filter(function (o) { return o.settleStatus === "待结算"; });
    var unComm = un.reduce(function (s, o) { return s + num(o.commission); }, 0);
    var unSelf = un.reduce(function (s, o) { return s + num(o.selfCommission); }, 0);

    var cards = [
      { cls: "", label: "本月代拍总单数", value: monthCount, unit: "单", sub: "按 " + curMonth + " 自然月统计" },
      { cls: "c-gray", label: "本月代拍总金额", value: "¥" + money(monthAmount), sub: "实付金额合计" },
      { cls: "c-green", label: "本月佣金合计", value: "¥" + money(monthComm), sub: "其中自己所得 ¥" + money(monthSelf) },
      { cls: "c-orange", label: "待结算佣金订单数", value: un.length, unit: "单", sub: "佣金 ¥" + money(unComm) + " · 自己所得 ¥" + money(unSelf) }
    ];
    $("stats").innerHTML = cards.map(function (c) {
      return '<div class="stat-card ' + c.cls + '">' +
        '<div class="label">' + esc(c.label) + '</div>' +
        '<div class="value">' + esc(c.value) + (c.unit ? '<span class="unit">' + esc(c.unit) + '</span>' : '') + '</div>' +
        '<div class="sub">' + esc(c.sub) + '</div></div>';
    }).join("");
  }

  /* ============ 视图标签 ============ */
  function countOf(viewId) {
    var backup = state.view;
    state.view = viewId;
    var n = toolFiltered(viewFiltered(orders)).length;
    state.view = backup;
    return n;
  }
  function renderViews() {
    $("views").innerHTML = VIEWS.map(function (v) {
      var active = state.view === v.id ? " active" : "";
      return '<button class="view-tab' + active + '" data-view="' + v.id + '">' + esc(v.name) +
        '<span class="cnt">' + countOf(v.id) + '</span></button>';
    }).join("");
    Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (btn) {
      btn.onclick = function () { state.view = btn.getAttribute("data-view"); render(); };
    });
  }

  /* ============ 筛选控件 ============ */
  function uniq(key) {
    var set = {};
    orders.forEach(function (o) { if (o[key]) set[o[key]] = 1; });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, "zh-CN"); });
  }
  function opts(arr, cur, label) {
    return '<option value="">' + label + '</option>' + arr.map(function (v) {
      return '<option value="' + esc(v) + '"' + (cur === v ? " selected" : "") + '>' + esc(v) + '</option>';
    }).join("");
  }
  function renderFilters() {
    var ps = uniq("platform"), cs = uniq("client");
    $("fPlatform").innerHTML = opts(ps, state.platform, "全部平台");
    $("fClient").innerHTML = opts(cs, state.client, "全部委托人");
    $("platformList").innerHTML = ps.map(function (v) { return '<option value="' + esc(v) + '"></option>'; }).join("");
    $("clientList").innerHTML = cs.map(function (v) { return '<option value="' + esc(v) + '"></option>'; }).join("");
  }

  /* ============ 分组 + 表格/卡片 ============ */
  var COLS = [
    { key: "#", label: "#", data: "#" },
    { key: "platform", label: "代拍平台", data: "代拍平台" },
    { key: "orderTime", label: "下单日期", data: "下单日期", cls: "sortable num" },
    { key: "orderNo", label: "订单编号", data: "订单编号", cls: "num" },
    { key: "product", label: "商品名称", data: "商品名称" },
    { key: "payInfo", label: "结算方式/实付", data: "结算方式/实付" },
    { key: "client", label: "委托人", data: "委托人" },
    { key: "commission", label: "佣金金额", data: "佣金金额", cls: "sortable num" },
    { key: "selfCommission", label: "自己所得佣金", data: "自己所得佣金", cls: "sortable num" },
    { key: "settleStatus", label: "佣金结算", data: "佣金结算", cls: "sortable" },
    { key: "buyer", label: "买家信息", data: "买家信息" },
    { key: "images", label: "凭证", data: "凭证图片" },
    { key: "remark", label: "备注", data: "备注", cls: "remark-cell" },
    { key: "_ops", label: "操作", data: "操作" }
  ];
  var SORT_KEYS = ["orderTime", "commission", "selfCommission", "settleStatus"];

  function headHtml() {
    return "<tr>" + COLS.map(function (c) {
      var isSort = SORT_KEYS.indexOf(c.key) > -1;
      var arrow = state.sortKey === c.key ? '<span class="arrow">' + (state.sortDir === "asc" ? "▲" : "▼") + "</span>" : "";
      return '<th class="' + (c.cls || "") + (isSort ? " sortable" : "") + '"' +
        (isSort ? ' data-sort="' + c.key + '"' : "") + ">" + esc(c.label) + arrow + "</th>";
    }).join("") + "</tr>";
  }

  function imgCell(o) {
    var a = imgs(o);
    if (!a.length) return '<td data-label="凭证图片"><span class="thumb-empty">&#128247;</span></td>';
    return '<td data-label="凭证图片"><img class="thumb view-img" src="' + a[0] + '" alt="凭证">' +
      (a.length > 1 ? '<div class="img-count">' + a.length + " 张</div>" : "") + "</td>";
  }

  function rowHtml(o) {
    var a = imgs(o);
    var html = "";
    html += '<td data-label="#" class="seq-cell">' + o._seq + "</td>";
    html += '<td data-label="代拍平台">' + esc(o.platform) + "</td>";
    html += '<td data-label="下单日期" class="num">' + esc(o.orderTime || "-") + "</td>";
    html += '<td data-label="订单编号" class="num cell-strong">' + esc(o.orderNo) + "</td>";
    html += '<td data-label="商品名称"><div class="ellip" title="' + esc(o.product) + '">' + esc(o.product) + "</div></td>";
    html += '<td data-label="结算方式/实付" class="num cell-strong">' + esc(o.payInfo || "-") + "</td>";
    html += '<td data-label="委托人" class="cell-strong">' + esc(o.client) + "</td>";
    html += '<td data-label="佣金金额" class="num">¥' + money(o.commission) + "</td>";
    html += '<td data-label="自己所得佣金" class="num" style="color:var(--green);font-weight:500;">¥' + money(o.selfCommission) + "</td>";
    html += '<td data-label="佣金结算"><button class="settle-btn tag p-' + esc(o.settleStatus) + '" data-id="' + o.id + '">' + esc(o.settleStatus) + "</button></td>";
    html += '<td data-label="买家信息"><div class="ellip" title="' + esc(o.buyer) + '">' + esc(o.buyer || "-") + "</div></td>";
    html += imgCell(o);
    html += '<td data-label="备注" class="remark-cell"><div class="ellip" title="' + esc(o.remark) + '">' + esc(o.remark || "-") + "</div></td>";
    html += '<td data-label="操作" class="ops">' +
      '<button class="link-btn edit-btn" data-id="' + o.id + '">编辑</button>' +
      '<button class="link-btn del del-btn" data-id="' + o.id + '">删除</button></td>';
    return "<tr>" + html + "</tr>";
  }

  // 按日期分组（相同日期聚在一起），并给每条记录打上全局序号
  function groupByDate(list) {
    var map = {}, groups = [];
    list.forEach(function (o, idx) {
      o._seq = idx + 1;
      var d = o.orderTime || "未填日期";
      if (!map[d]) { map[d] = { date: d, items: [] }; groups.push(map[d]); }
      map[d].items.push(o);
    });
    return groups;
  }

  // 日期分组头部配色（不同日期用不同颜色区分）
  var GROUP_COLORS = ["g-blue", "g-green", "g-orange", "g-purple", "g-red", "g-cyan"];
  function groupColor(i) { return GROUP_COLORS[i % GROUP_COLORS.length]; }
  // 每条记录（手机卡片）用不同颜色区分：按序号循环取色
  var REC_COLORS = ["#ff7043", "#26a69a", "#7e57c2", "#ec407a", "#42a5f5", "#66bb6a", "#ffa726", "#26c6da"];
  function recColor(i) { return REC_COLORS[((i || 1) - 1) % REC_COLORS.length]; }

  function renderGrouped(list) {
    var hasData = orders.length > 0;
    if (list.length === 0) {
      $("content").innerHTML =
        '<div class="table-wrap"><div class="table-scroll"><table><thead>' + headHtml() + '</thead><tbody></tbody></table></div>' +
        '<div class="empty"><div class="big">&#128203;</div>' +
        (hasData
          ? "<p>当前筛选条件下没有匹配的订单</p><p>试试重置筛选，或切换到「全部代拍记录」视图</p>" +
            '<button class="btn" onclick="document.getElementById(\'btnReset\').click()">重置筛选</button>'
          : "<p>还没有任何代拍订单记录</p><p>点击「新增代拍记录」或「截图识别录入」开始</p>" +
            '<button class="btn primary" onclick="document.getElementById(\'btnAdd\').click()">+ 新增代拍记录</button>') +
        "</div></div>";
      bindSortEvents();
      return;
    }

    var groups = groupByDate(list);
    var tPaid = list.reduce(function (s, o) { return s + payNum(o); }, 0);
    var tComm = list.reduce(function (s, o) { return s + num(o.commission); }, 0);
    var tSelf = list.reduce(function (s, o) { return s + num(o.selfCommission); }, 0);

    // 桌面：分组表格
    var deskRows = groups.map(function (g, gi) {
      var collapsed = !!collapsedGroups[g.date];
      var gPaid = g.items.reduce(function (s, o) { return s + payNum(o); }, 0);
      var gComm = g.items.reduce(function (s, o) { return s + num(o.commission); }, 0);
      var head = '<tr class="group-row' + (collapsed ? " collapsed" : "") + '" data-date="' + esc(g.date) + '">' +
        '<td colspan="' + COLS.length + '">' +
        '<span class="caret">&#9656;</span>' +
        '<span class="dot ' + groupColor(gi) + '"></span>' +
        '<span class="g-name">' + esc(g.date) + '</span>' +
        '<span class="g-cnt">' + g.items.length + ' 条</span>' +
        '<span class="g-stat">实付 <b>¥' + money(gPaid) + '</b> · 佣金 <b>¥' + money(gComm) + '</b></span>' +
        '</td></tr>';
      var body = collapsed ? "" : g.items.map(rowHtml).join("");
      return head + body;
    }).join("");

    var desk = '<div class="table-wrap desk-only"><div class="table-scroll"><table><thead>' + headHtml() +
      '</thead><tbody>' + deskRows + '</tbody></table></div>' +
      '<div class="table-foot"><span>共 <b>' + list.length + '</b> 条</span>' +
      "<span>实付 <b>¥" + money(tPaid) + "</b> · 佣金 <b>¥" + money(tComm) +
      '</b> · 自己所得佣金 <b style="color:var(--green);">¥' + money(tSelf) + "</b></span></div></div>";

    // 手机：分组卡片
    var mobile = '<div class="card-list mob-only">' + groups.map(function (g, gi) {
      var collapsed = !!collapsedGroups[g.date];
      var gPaid = g.items.reduce(function (s, o) { return s + payNum(o); }, 0);
      var gComm = g.items.reduce(function (s, o) { return s + num(o.commission); }, 0);
      var cards = collapsed ? "" : g.items.map(function (o) {
        var st = o.settleStatus === "已结算" ? "st-done" : "st-wait";
        var rc = recColor(o._seq);
        var imgsHtml = imgs(o).length
          ? '<div class="c-imgs">' + imgs(o).map(function (src) {
              return '<img class="c-img view-img" src="' + src + '" alt="凭证">';
            }).join("") + '</div>'
          : "";
        return '<div class="rec-card ' + st + '" style="border-left:5px solid ' + rc + ';">' +
          '<div class="rc-top"><span class="seq ' + st + '" style="background:' + rc + ';">#' + o._seq + '</span>' +
          '<span class="rc-platform">' + esc(o.platform) + '</span>' +
          '<button class="settle-btn tag p-' + esc(o.settleStatus) + '" data-id="' + o.id + '">' + esc(o.settleStatus) + "</button></div>" +
          '<div class="rc-line"><span class="rc-k">订单号</span><span class="rc-v">' + esc(o.orderNo) + '</span></div>' +
          '<div class="rc-line"><span class="rc-k">商品</span><span class="rc-v">' + esc(o.product) + '</span></div>' +
          '<div class="rc-line"><span class="rc-k">结算/实付</span><span class="rc-v">' + esc(o.payInfo || "-") + '</span></div>' +
          '<div class="rc-line"><span class="rc-k">委托人</span><span class="rc-v">' + esc(o.client) + '</span></div>' +
          '<div class="rc-line"><span class="rc-k">佣金</span><span class="rc-v">¥' + money(o.commission) + (num(o.selfCommission) !== num(o.commission) ? '（自己 ¥' + money(o.selfCommission) + '）' : '') + '</span></div>' +
          (o.buyer ? '<div class="rc-line"><span class="rc-k">买家</span><span class="rc-v">' + esc(o.buyer) + '</span></div>' : '') +
          (o.remark ? '<div class="rc-line"><span class="rc-k">备注</span><span class="rc-v">' + esc(o.remark) + '</span></div>' : '') +
          imgsHtml +
          '<div class="rc-ops"><button class="link-btn edit-btn" data-id="' + o.id + '">编辑</button>' +
          '<button class="link-btn del del-btn" data-id="' + o.id + '">删除</button></div>' +
          '</div>';
      }).join("");
      return '<section class="date-group' + (collapsed ? " collapsed" : "") + '" data-date="' + esc(g.date) + '">' +
        '<header class="date-head" data-date="' + esc(g.date) + '">' +
        '<span class="caret">&#9656;</span>' +
        '<span class="dot ' + groupColor(gi) + '"></span>' +
        '<span class="g-name">' + esc(g.date) + '</span>' +
        '<span class="g-cnt">' + g.items.length + ' 条</span>' +
        '<span class="g-stat">实付 ¥' + money(gPaid) + '</span>' +
        '</header><div class="date-body">' + cards + '</div></section>';
    }).join("") + '</div>';

    $("content").innerHTML = desk + mobile;
    bindRowEvents();
    bindGroupToggle();
    bindSortEvents();
  }

  /* ============ 行内事件 ============ */
  function bindRowEvents() {
    Array.prototype.forEach.call(document.querySelectorAll(".edit-btn"), function (b) {
      b.onclick = function () { openModal(b.getAttribute("data-id")); };
    });
    Array.prototype.forEach.call(document.querySelectorAll(".del-btn"), function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-id");
        var o = orders.filter(function (x) { return x.id === id; })[0];
        if (!o) return;
        if (!confirm("确认删除订单「" + o.orderNo + "」？删除后不可恢复。")) return;
        orders = orders.filter(function (x) { return x.id !== id; });
        save(); render(); toast("已删除该订单");
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll(".settle-btn"), function (b) {
      b.onclick = function () {
        var id = b.getAttribute("data-id");
        var o = orders.filter(function (x) { return x.id === id; })[0];
        if (!o) return;
        o.settleStatus = o.settleStatus === "已结算" ? "待结算" : "已结算";
        o.updatedAt = todayStr();
        save(); render();
        toast("佣金结算状态已改为「" + o.settleStatus + "」");
      };
    });
    Array.prototype.forEach.call(document.querySelectorAll(".view-img"), function (im) {
      im.onclick = function () { showLightbox(im.src); };
    });
  }
  function bindGroupToggle() {
    Array.prototype.forEach.call(document.querySelectorAll(".group-row, .date-head"), function (h) {
      h.onclick = function () {
        var d = h.getAttribute("data-date");
        collapsedGroups[d] = !collapsedGroups[d];
        render();
      };
    });
  }
  function bindSortEvents() {
    Array.prototype.forEach.call(document.querySelectorAll("th[data-sort]"), function (th) {
      th.onclick = function () {
        var k = th.getAttribute("data-sort");
        if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        else { state.sortKey = k; state.sortDir = k === "orderTime" ? "desc" : "asc"; }
        render();
      };
    });
  }
  function showLightbox(src) {
    $("lightboxImg").src = src;
    $("lightbox").classList.add("show");
  }

  /* ============ 主渲染 ============ */
  function render() {
    renderStats();
    renderViews();
    renderFilters();
    var list = currentList();
    renderGrouped(list);
    $("resultInfo").textContent = "筛选出 " + list.length + " 条 / 共 " + orders.length + " 条记录";
  }

  /* ============ 表单弹窗 ============ */
  function renderImageGrid() {
    var grid = $("imgGrid");
    grid.innerHTML = pendingImages.map(function (src, i) {
      return '<div class="img-item"><img src="' + src + '" alt="凭证">' +
        '<button type="button" class="rm" data-i="' + i + '">&times;</button></div>';
    }).join("");
    Array.prototype.forEach.call(grid.querySelectorAll(".rm"), function (b) {
      b.onclick = function () {
        pendingImages.splice(parseInt(b.getAttribute("data-i"), 10), 1);
        renderImageGrid();
      };
    });
    $("imgHint").textContent = pendingImages.length ? "已添加 " + pendingImages.length + " / " + MAX_IMAGES + " 张" : "";
  }

  function addImageFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    if (pendingImages.length >= MAX_IMAGES) { toast("最多 " + MAX_IMAGES + " 张"); return; }
    var room = MAX_IMAGES - pendingImages.length;
    if (!window.DaipaiOCR || !window.DaipaiOCR.compressImage) {
      toast("图片模块未加载，请刷新页面重试");
      return;
    }
    var jobs = list.slice(0, room).map(function (f) {
      return window.DaipaiOCR.compressImage(f, 1100, 0.72).catch(function (e) {
        toast((e && e.message) || "图片处理失败");
        return null;
      });
    });
    Promise.all(jobs).then(function (arr) {
      arr.forEach(function (d) { if (d) pendingImages.push(d); });
      renderImageGrid();
      var kb = Math.round(pendingImages.join("").length / 1024);
      toast("已添加图片（约 " + kb + " KB）");
    });
  }

  function openModal(id) {
    editingId = id || null;
    var o = id ? orders.filter(function (x) { return x.id === id; })[0] : null;
    $("modalTitle").textContent = o ? "编辑代拍记录" : "新增代拍记录";
    $("iPlatform").value = o ? o.platform : "";
    $("iOrderTime").value = o ? toDate(o.orderTime) : todayStr();
    $("iOrderNo").value = o ? o.orderNo : "";
    $("iProduct").value = o ? o.product : "";
    $("iPayInfo").value = o ? o.payInfo : "";
    $("iClient").value = o ? o.client : "";
    $("iCommission").value = o ? o.commission : "";
    $("iSelfCommission").value = o ? o.selfCommission : "";
    $("iSettle").value = o ? o.settleStatus : "待结算";
    $("iBuyer").value = o ? o.buyer : "";
    $("iRemark").value = o ? o.remark : "";
    pendingImages = o ? imgs(o).slice() : [];
    renderImageGrid();
    resetOcrPanel();
    $("mask").classList.add("show");
    setTimeout(function () { $("iPlatform").focus(); }, 50);
  }
  function closeModal() {
    $("mask").classList.remove("show");
    editingId = null;
    pendingImages = [];
    pendingOcrImage = null;
  }

  function submitForm() {
    var v = function (el) { return el.value.trim(); };
    var platform = v($("iPlatform"));
    var orderNo = v($("iOrderNo"));
    var product = v($("iProduct"));
    var client = v($("iClient"));
    if (!platform) { alert("请填写代拍平台"); $("iPlatform").focus(); return; }
    if (!orderNo) { alert("请填写订单编号"); $("iOrderNo").focus(); return; }
    if (!product) { alert("请填写商品名称"); $("iProduct").focus(); return; }
    if (!client) { alert("请填写委托人（帮谁代拍）"); $("iClient").focus(); return; }
    var dup = orders.filter(function (o) { return o.orderNo === orderNo && o.id !== editingId; });
    if (dup.length) { alert("订单编号「" + orderNo + "」已存在，请勿重复登记"); $("iOrderNo").focus(); return; }

    var commission = Math.max(0, parseFloat($("iCommission").value) || 0);
    var selfRaw = $("iSelfCommission").value;
    var selfCommission = (selfRaw === "") ? commission : Math.max(0, parseFloat(selfRaw) || 0);

    var data = {
      platform: platform,
      orderTime: toDate($("iOrderTime").value) || todayStr(),
      orderNo: orderNo,
      product: product,
      payInfo: $("iPayInfo").value.trim(),
      client: client,
      commission: commission,
      selfCommission: selfCommission,
      settleStatus: $("iSettle").value,
      buyer: v($("iBuyer")),
      remark: $("iRemark").value.trim(),
      images: pendingImages.slice(0, MAX_IMAGES),
      updatedAt: todayStr()
    };

    if (editingId) {
      orders = orders.map(function (o) { return o.id === editingId ? Object.assign({}, o, data) : o; });
      toast("订单已更新");
    } else {
      data.id = uid();
      orders.push(data);
      toast("已新增代拍记录");
    }
    save();
    closeModal();
    render();
  }

  /* ============ OCR 面板 ============ */
  function resetOcrPanel() {
    $("ocrResult").classList.remove("show");
    $("ocrStatus").textContent = "未选择图片";
    $("ocrProgress").classList.remove("show");
    $("ocrProgress").firstElementChild.style.width = "0%";
    $("ocrWarn").classList.remove("show");
    $("ocrOk").classList.remove("show");
    $("ocrRaw").value = "";
    $("ocrRaw").style.display = "none";
    $("ocrPreview").removeAttribute("src");
    pendingOcrImage = null;
  }
  function setOcrImage(dataUrl) {
    pendingOcrImage = dataUrl;
    $("ocrPreview").src = dataUrl;
    $("ocrResult").classList.add("show");
    $("ocrStatus").textContent = "图片已就绪，点「开始识别」";
    $("ocrOk").classList.remove("show");
    $("ocrWarn").classList.remove("show");
  }
  function runOcr() {
    if (!pendingOcrImage) { toast("请先选择或拍摄图片"); return; }
    if (!window.DaipaiOCR) { toast("识别模块未加载"); return; }
    var btn = $("btnOcrRun");
    btn.disabled = true;
    $("ocrStatus").textContent = "正在初始化识别引擎…";
    $("ocrProgress").classList.add("show");
    $("ocrProgress").firstElementChild.style.width = "5%";
    $("ocrWarn").classList.remove("show");
    $("ocrOk").classList.remove("show");

    var engineLoaded = false;
    var timeoutId = setTimeout(function () {
      if (!engineLoaded) {
        $("ocrStatus").textContent = "首次使用需下载约 20MB 识别包，请保持网络畅通…";
      }
    }, 2500);

    window.DaipaiOCR.recognize(pendingOcrImage, function (p, label) {
      engineLoaded = true;
      $("ocrProgress").firstElementChild.style.width = Math.max(5, Math.round(p * 100)) + "%";
      $("ocrStatus").textContent = (label || "处理中") + " " + Math.round(p * 100) + "%";
    }).then(function (res) {
      clearTimeout(timeoutId);
      var f = res.fields || {};
      $("ocrPlatform").value = f.platform || "";
      $("ocrOrderNo").value = f.orderNo || "";
      $("ocrPaid").value = f.paid || "";
      $("ocrBuyer").value = f.buyer || "";
      $("ocrRaw").value = res.text || "";
      $("ocrResult").classList.add("show");
      $("ocrProgress").firstElementChild.style.width = "100%";
      var hit = [f.platform, f.orderNo, f.paid, f.buyer].filter(Boolean).length;
      $("ocrStatus").textContent = "识别完成，命中 " + hit + " / 4 项，请核对后填入";
      $("ocrOk").classList.add("show");
      $("ocrOk").textContent = "已识别，请逐项核对（识别结果可能有偏差，务必人工确认）";
      if (hit === 0) {
        $("ocrWarn").classList.add("show");
        $("ocrWarn").textContent = "未能自动识别出信息。可能是截图不清晰或含生僻排版，可点「查看识别原文」手动查找，或直接手动填写。";
      }
    }).catch(function (err) {
      clearTimeout(timeoutId);
      console.error(err);
      $("ocrWarn").classList.add("show");
      $("ocrWarn").textContent = (err && err.message) ? err.message : "识别失败，请稍后重试或直接手动填写";
      $("ocrStatus").textContent = "识别失败";
    }).then(function () {
      btn.disabled = false;
      $("ocrProgress").classList.remove("show");
    });
  }
  function applyOcr() {
    if ($("ocrPlatform").value.trim()) $("iPlatform").value = $("ocrPlatform").value.trim();
    if ($("ocrOrderNo").value.trim()) $("iOrderNo").value = $("ocrOrderNo").value.trim();
    if ($("ocrPaid").value.trim()) {
      var cur = $("iPayInfo").value.trim();
      $("iPayInfo").value = (cur ? cur + "，" : "") + "实付 " + $("ocrPaid").value.trim();
    }
    if ($("ocrBuyer").value.trim()) $("iBuyer").value = $("ocrBuyer").value.trim();
    if (pendingOcrImage && pendingImages.indexOf(pendingOcrImage) === -1 && pendingImages.length < MAX_IMAGES) {
      pendingImages.push(pendingOcrImage);
      renderImageGrid();
    }
    toast("已填入表单，请补全剩余字段");
  }

  /* ============ CSV 导出 / 导入 ============ */
  function csvCell(s) {
    var str = (s === null || s === undefined) ? "" : String(s);
    if (/[",\n\r]/.test(str)) str = '"' + str.replace(/"/g, '""') + '"';
    return str;
  }
  function exportCSV() {
    var list = currentList();
    if (!list.length) { toast("当前没有可导出的数据"); return; }
    var lines = [CSV_HEADERS.map(function (h) { return csvCell(h[1]); }).join(",")];
    list.forEach(function (o) {
      lines.push(CSV_HEADERS.map(function (h) {
        return h[0] === "imgCount" ? csvCell(imgs(o).length) : csvCell(o[h[0]]);
      }).join(","));
    });
    var d = new Date();
    var name = "代拍台账_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".csv";
    var blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
    toast("已导出 " + list.length + " 条记录");
  }
  function parseCSV(text) {
    var rows = [], row = [], cur = "", inQ = false;
    text = text.replace(/^\ufeff/, "");
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
        else { cur += c; }
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { row.push(cur); cur = ""; }
        else if (c === "\n") { row.push(cur); cur = ""; rows.push(row); row = []; }
        else if (c === "\r") { /* skip */ }
        else cur += c;
      }
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function importCSV(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var rows = parseCSV(String(e.target.result));
        if (rows.length < 2) { toast("文件内容为空"); return; }
        var headRow = rows[0].map(function (x) { return String(x).trim(); });
        var idx = {};
        CSV_HEADERS.forEach(function (h) {
          var i = headRow.indexOf(h[1]);
          if (i > -1) idx[h[0]] = i;
        });
        if (idx.orderNo === undefined) { toast("缺少「订单编号」列，无法导入"); return; }
        var existing = {};
        orders.forEach(function (o) { existing[o.orderNo] = o; });
        var added = 0, updated = 0;
        for (var r = 1; r < rows.length; r++) {
          var cells = rows[r];
          if (!cells.length || !String(cells[idx.orderNo] || "").trim()) continue;
          var pick = function (k) { return idx[k] !== undefined ? String(cells[idx[k]] || "").trim() : ""; };
          var no = pick("orderNo");
          var comm = parseFloat(pick("commission")) || 0;
          var selfRaw = pick("selfCommission");
          var rec = normalize({
            id: existing[no] ? existing[no].id : uid(),
            platform: pick("platform") || "未填平台",
            orderTime: pick("orderTime") || todayStr(),
            orderNo: no,
            product: pick("product") || "未填商品",
            payInfo: pick("payInfo"),
            paid: parseFloat(pick("paid")) || 0,
            client: pick("client") || "未填委托人",
            commission: comm,
            selfCommission: selfRaw === "" ? comm : (parseFloat(selfRaw) || 0),
            settleStatus: pick("settleStatus"),
            settleBy: pick("settleBy"),
            buyer: pick("buyer"),
            remark: pick("remark"),
            images: existing[no] ? existing[no].images : []
          });
          if (existing[no]) {
            for (var k in rec) existing[no][k] = rec[k];
            updated++;
          } else {
            orders.push(rec); existing[no] = rec; added++;
          }
        }
        save(); render();
        toast("导入完成：新增 " + added + " 条，更新 " + updated + " 条");
      } catch (err) {
        console.error(err); toast("导入失败，请检查 CSV 格式");
      }
    };
    reader.onerror = function () { toast("文件读取失败"); };
    reader.readAsText(file, "UTF-8");
  }

  /* ============ JSON 备份 / 恢复 ============ */
  function backup() {
    if (!orders.length) { toast("暂无数据可备份"); return; }
    var d = new Date();
    var blob = new Blob([JSON.stringify({ v: 2, exportedAt: todayStr(), orders: orders })],
      { type: "application/json;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "代拍工作台备份_" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".json";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
    toast("备份文件已导出");
  }
  function restore(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = JSON.parse(String(e.target.result));
        var arr = Array.isArray(data) ? data : data.orders;
        if (!Array.isArray(arr)) throw new Error("格式不对");
        var incoming = arr.map(normalize);
        if (!orders.length) {
          orders = incoming;
        } else {
          var mode = confirm("点「确定」= 用备份覆盖现有数据\n点「取消」= 合并（同订单编号以备份为准）");
          if (mode) orders = incoming;
          else {
            var map = {};
            orders.forEach(function (o) { map[o.orderNo] = o; });
            incoming.forEach(function (o) { map[o.orderNo] = o; });
            orders = Object.keys(map).map(function (k) { return map[k]; });
          }
        }
        save(); render();
        toast("已恢复 " + orders.length + " 条记录");
      } catch (err) {
        console.error(err); toast("备份文件解析失败");
      }
    };
    reader.onerror = function () { toast("文件读取失败"); };
    reader.readAsText(file, "UTF-8");
  }

  /* ============ 同步链接 ============ */
  function bytesToB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64ToBytes(b64) {
    var s = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function gzip(str) {
    if (!window.CompressionStream || !window.Blob) return Promise.resolve(null);
    try {
      var cs = new CompressionStream("gzip");
      return new Response(new Blob([str]).stream().pipeThrough(cs)).blob()
        .then(function (b) { return b.arrayBuffer(); })
        .then(function (ab) { return new Uint8Array(ab); })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function gunzip(bytes) {
    if (!window.DecompressionStream) return Promise.resolve(null);
    try {
      var ds = new DecompressionStream("gzip");
      return new Response(new Blob([bytes]).stream().pipeThrough(ds)).blob()
        .then(function (b) { return b.text(); })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function makeSyncUrl() {
    var payload = JSON.stringify({ v: 2, orders: orders });
    return gzip(payload).then(function (gz) {
      var b64;
      if (gz) b64 = "g" + bytesToB64(gz);
      else b64 = "r" + bytesToB64(new TextEncoder().encode(payload));
      var base = location.origin + location.pathname;
      return base + "#sync=" + b64;
    });
  }
  function readSyncUrl() {
    var m = location.hash.match(/[#&]sync=([A-Za-z0-9\-_]+)/);
    if (!m) return Promise.resolve(false);
    var flag = m[1].slice(0, 1);
    var body = m[1].slice(1);
    var getText;
    if (flag === "g") {
      getText = gunzip(b64ToBytes(body));
    } else {
      getText = Promise.resolve(new TextDecoder().decode(b64ToBytes(body)));
    }
    return getText.then(function (txt) {
      if (!txt) throw new Error("解压失败");
      var data = JSON.parse(txt);
      var arr = Array.isArray(data) ? data : data.orders;
      if (!Array.isArray(arr)) throw new Error("数据格式不对");
      applyIncoming(arr);
      history.replaceState(null, "", location.pathname);
      toast("同步完成，共 " + orders.length + " 条记录");
      return true;
    }).catch(function (e) {
      console.error(e);
      toast("同步链接解析失败");
      return false;
    });
  }

  // 把同步字符串或原始 JSON 合入本机数据（覆盖 / 合并二选一）
  function applyIncoming(incomingRaw) {
    var incoming = incomingRaw.map(normalize);
    if (!orders.length) {
      orders = incoming;
    } else {
      var mode = confirm("点「确定」= 用同步数据覆盖现有数据\n点「取消」= 合并（同订单编号以同步数据为准）");
      if (mode) {
        orders = incoming;
      } else {
        var map = {};
        orders.forEach(function (o) { map[o.orderNo] = o; });
        incoming.forEach(function (o) { map[o.orderNo] = o; });
        orders = Object.keys(map).map(function (k) { return map[k]; });
      }
    }
    save(); render();
    toast("已导入 " + orders.length + " 条记录");
  }

  function copyText(str) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(str).then(function () { resolve(true); },
          function () { resolve(fallbackCopy(str)); });
      } else {
        resolve(fallbackCopy(str));
      }
    });
  }
  function fallbackCopy(str) {
    try {
      var ta = document.createElement("textarea");
      ta.value = str; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.top = "-9999px"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  // 从「复制数据」得到的同步字符串，或原始 JSON，导入到本机
  function importFromText(txt) {
    txt = String(txt || "").trim();
    if (!txt) { toast("请先粘贴同步数据"); return; }
    if (/^[gr][A-Za-z0-9\-_]+$/.test(txt)) {
      var flag = txt.slice(0, 1), body = txt.slice(1);
      var getText = flag === "g" ? gunzip(b64ToBytes(body)) : Promise.resolve(new TextDecoder().decode(b64ToBytes(body)));
      getText.then(function (t) {
        if (!t) { toast("同步数据解压失败"); return; }
        try {
          var data = JSON.parse(t);
          var arr = Array.isArray(data) ? data : data.orders;
          if (!Array.isArray(arr)) throw new Error("数据格式不对");
          applyIncoming(arr);
        } catch (e) { toast("同步数据解析失败"); }
      }).catch(function () { toast("同步数据解析失败"); });
      return;
    }
    try {
      var data = JSON.parse(txt);
      var arr = Array.isArray(data) ? data : data.orders;
      if (!Array.isArray(arr)) throw new Error("no orders");
      applyIncoming(arr);
    } catch (e) {
      toast("无法识别的内容（需为同步数据或 JSON）");
    }
  }

  function syncFilterInputs() {
    $("fPlatform").value = state.platform;
    $("fClient").value = state.client;
    $("fSettle").value = state.settle;
    $("fDate").value = state.date;
  }
  function resetFilters() {
    state.product = ""; state.platform = ""; state.client = ""; state.settle = ""; state.date = ""; state.q = "";
    $("fProduct").value = ""; $("q").value = ""; $("fDate").value = "";
    $("fPlatform").value = ""; $("fClient").value = ""; $("fSettle").value = "";
    render();
  }

  /* ============ 初始化 ============ */
  function init() {
    load();

    // 顶部按钮
    $("btnAdd").onclick = function () { openModal(null); };
    $("btnOcr").onclick = function () {
      openModal(null);
      setTimeout(function () {
        var box = document.querySelector(".ocr-box");
        if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    };
    $("btnExport").onclick = exportCSV;
    $("btnImport").onclick = function () { $("fileCsv").click(); };
    $("fileCsv").onchange = function (e) {
      if (e.target.files && e.target.files[0]) importCSV(e.target.files[0]);
      e.target.value = "";
    };

    // 表单
    $("btnClose").onclick = closeModal;
    $("btnCancel").onclick = closeModal;
    $("btnSave").onclick = submitForm;
    $("orderForm").onsubmit = function (e) { e.preventDefault(); submitForm(); };
    $("mask").onclick = function (e) { if (e.target === $("mask")) closeModal(); };
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if ($("mask").classList.contains("show")) closeModal();
        if ($("syncMask").classList.contains("show")) $("syncMask").classList.remove("show");
        if ($("lightbox").classList.contains("show")) $("lightbox").classList.remove("show");
      }
    });

    // 图片：OCR 区（imageInput）与凭证区（galleryInput）分开
    $("btnAddImage").onclick = function () { pickGallery(false); };
    $("btnAddPhoto").onclick = function () { pickGallery(true); };
    $("btnPickImage").onclick = function () { pickImage(false); };
    $("btnTakePhoto").onclick = function () { pickImage(true); };

    $("galleryInput").onchange = function (e) {
      var files = e.target.files;
      e.target.value = "";
      if (!files || !files.length) return;
      addImageFiles(files);
    };

    $("imageInput").onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      if (!window.DaipaiOCR || !window.DaipaiOCR.compressImage) {
        toast("识别模块未加载，请刷新页面重试");
        return;
      }
      try {
        window.DaipaiOCR.compressImage(f, 1200, 0.75).then(function (dataUrl) {
          setOcrImage(dataUrl);
          if (pendingImages.length < MAX_IMAGES && pendingImages.indexOf(dataUrl) === -1) {
            pendingImages.push(dataUrl);
            renderImageGrid();
          }
        }).catch(function (err) {
          console.error(err);
          toast(err && err.message ? err.message : "图片处理失败");
        });
      } catch (err) {
        console.error(err);
        toast("图片处理失败：" + err.message);
      }
    };
    $("btnOcrRun").onclick = runOcr;
    $("btnOcrApply").onclick = applyOcr;
    $("btnOcrToggleRaw").onclick = function () {
      var t = $("ocrRaw");
      var showing = t.style.display !== "none";
      t.style.display = showing ? "none" : "block";
      this.textContent = showing ? "查看识别原文" : "收起识别原文";
    };

    // 筛选
    var timer = null;
    $("fProduct").oninput = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { state.product = $("fProduct").value; render(); }, 220);
    };
    $("q").oninput = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { state.q = $("q").value; render(); }, 220);
    };
    $("fPlatform").onchange = function () { state.platform = this.value; render(); };
    $("fClient").onchange = function () { state.client = this.value; render(); };
    $("fSettle").onchange = function () { state.settle = this.value; render(); };
    $("fDate").onchange = function () { state.date = this.value; render(); };
    $("btnReset").onclick = resetFilters;

    // 筛选侧边栏：桌面可收起，手机点开抽屉
    $("btnFilterToggle").onclick = function () { document.body.classList.add("filter-open"); };
    $("btnFsClose").onclick = function () { document.body.classList.remove("filter-open"); };
    $("filterBackdrop").onclick = function () { document.body.classList.remove("filter-open"); };
    $("btnFsCollapse").onclick = function () { document.body.classList.toggle("filter-collapsed"); };

    // 同步
    $("btnSync").onclick = function () { $("syncMask").classList.add("show"); };
    $("btnSyncClose").onclick = function () { $("syncMask").classList.remove("show"); };
    $("syncMask").onclick = function (e) { if (e.target === $("syncMask")) $("syncMask").classList.remove("show"); };
    $("btnGenSync").onclick = function () {
      if (!orders.length) { toast("暂无数据可同步"); return; }
      makeSyncUrl().then(function (url) {
        $("syncUrl").value = url;
        renderQr(url);
        var hint = url.length > 2000
          ? "链接较长（含图片），分享时可能被截断。更稳的方式：用上方「复制数据」→「粘贴导入」。"
          : "";
        $("copyDataHint").textContent = hint;
        toast("已生成，复制后发到手机打开即可");
      });
    };
    $("btnCopySync").onclick = function () {
      var t = $("syncUrl");
      if (!t.value) { toast("请先生成同步链接"); return; }
      t.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(t.value).then(function () { toast("已复制"); },
          function () { toast("复制失败，请手动选中复制"); });
      } else {
        toast(ok ? "已复制" : "复制失败，请手动选中复制");
      }
    };
    $("btnBackup").onclick = backup;
    $("btnRestore").onclick = function () { $("fileJson").click(); };
    $("fileJson").onchange = function (e) {
      if (e.target.files && e.target.files[0]) restore(e.target.files[0]);
      e.target.value = "";
    };
    // 手机端推荐的剪贴板同步方式
    $("btnCopyData").onclick = function () {
      if (!orders.length) { toast("暂无数据可复制"); return; }
      var payload = JSON.stringify({ v: 2, orders: orders });
      gzip(payload).then(function (gz) {
        var str = gz ? "g" + bytesToB64(gz) : "r" + bytesToB64(new TextEncoder().encode(payload));
        // base64 长度约为字节数的 4/3，超过约 1.5MB 直接走文件下载（剪贴板放不下）
        if (str.length > 2000000) {
          backup();
          $("copyDataHint").textContent = "数据较大（含较多图片），已改为下载备份文件，请用「导入备份」选择该文件。";
          return;
        }
        copyText(str).then(function (ok) {
          $("copyDataHint").textContent = ok
            ? "已复制！去另一台设备点开同步 → 粘贴导入即可。"
            : "复制失败，请长按上方文本框手动复制。";
        });
      });
    };
    $("btnPasteImport").onclick = function () { importFromText($("syncPaste").value); };

    // 大图
    $("btnCloseLb").onclick = function () { $("lightbox").classList.remove("show"); };
    $("lightbox").onclick = function (e) { if (e.target === $("lightbox")) $("lightbox").classList.remove("show"); };

    // PWA
    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function (e) {
          console.log("Service Worker 注册失败", e);
        });
      });
    }

    render();

    // 桌面 PWA 快捷方式参数
    try {
      var params = new URLSearchParams(location.search);
      var action = params.get("action");
      if (action === "add") {
        openModal(null);
      } else if (action === "ocr") {
        openModal(null);
        setTimeout(function () {
          var box = document.querySelector(".ocr-box");
          if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 150);
      }
    } catch (e) {}

    // 处理同步链接
    if (location.hash.indexOf("sync=") > -1) {
      readSyncUrl();
    }
  }

  function pickImage(capture) {
    var input = $("imageInput");
    if (capture) input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.click();
  }
  function pickGallery(capture) {
    var input = $("galleryInput");
    if (capture) {
      input.setAttribute("capture", "environment");
      input.removeAttribute("multiple");
    } else {
      input.removeAttribute("capture");
      input.setAttribute("multiple", "multiple");
    }
    input.click();
  }

  function renderQr(url) {
    var wrap = $("qrWrap");
    wrap.innerHTML = "";
    if (!url) return;
    if (global.QRCode) {
      try { new global.QRCode(wrap, { text: url, width: 180, height: 180 }); } catch (e) { /* ignore */ }
    } else {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js";
      s.onload = function () {
        try { new global.QRCode(wrap, { text: url, width: 180, height: 180 }); } catch (e) { /* ignore */ }
      };
      s.onerror = function () { /* 二维码加载失败不影响使用 */ };
      document.head.appendChild(s);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
