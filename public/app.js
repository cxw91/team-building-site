// 团建管理 —— 前端逻辑（多项目版）
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "¥" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
// 带符号的金额：正数 +¥1.50、负数 −¥1.50、0 显示 ¥0.00，用于差额 / 净收益这类「可正可负」的列
const signedMoney = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  if (Math.abs(v) < 0.005) return money(0);
  return (v > 0 ? "+" : "−") + money(Math.abs(v));
};
// 成员姓名一次可填多个：用逗号（中英文「,」「，」）分隔；同时兼容「、」等旧写法，避免历史习惯报错
const splitNames = (s) => String(s || "").split(/[,，、;；/|\s]+/).map((x) => x.trim()).filter(Boolean);

// 几个反复出现的时长集中在这里，避免散落在各处
const REVALIDATE_MS = 1000;  // 页签后台刷新的防抖窗口
const MODAL_TIGHT_H = 480;   // 软键盘弹出后弹窗切「贴顶 + 内部滚动」的高度阈值
const FOCUSOUT_DELAY = 150;  // 候选框 focusout 延迟收起
const FOCUS_CORRECT_DELAY = 80; // 输入框聚焦后校正弹窗位置

// 后端时间统一为 UTC 的 "YYYY-MM-DD HH:MM:SS"，这里转成本地时间显示
function fmtTime(s) {
  if (!s) return "";
  let iso = String(s).replace(" ", "T");
  if (!/[Z]|[+-]\d\d:?\d\d$/.test(iso)) iso += "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(s);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const TABS = [
  { key: "overview", label: "概览" },
  { key: "members", label: "成员" },
  { key: "carry", label: "携带物品" },
  { key: "shopping", label: "采购清单" },
  { key: "purchases", label: "采购记录" },
  { key: "settlement", label: "结算" },
  { key: "logs", label: "日志" },
];

const state = {
  token: localStorage.getItem("tb_token") || "",
  projectId: Number(localStorage.getItem("tb_project")) || null,
  projectName: "",
  familyId: null,
  families: [],
  projects: [],
  projectsAt: 0,        // 项目列表上次成功取数的时间戳：回到项目中心时据此判断要不要再刷一次
  tab: "overview",
lastLogId: 0,
  newLogs: 0,
  pending: null,        // 待确认删除：{ kind, id }
  editingMember: null,  // 正在编辑的成员 id
  editingFamily: null,  // 正在重命名的家庭 id
editingProject: null, // 正在改名的项目 id
  editingBudget: false, // 概览里是否正在编辑项目预算
  editingBonus: false, // 概览里是否正在编辑任务奖金
  overview: null,       // 概览接口最近一次的返回，供预算面板局部重画（不重新拉数据）
  projectStatus: "",    // 当前项目状态：进行中 / 已结束
  members: [],          // 成员页缓存：进入/退出编辑态、行内确认删除时就地重画，不重新拉接口
  carryItems: [],       // 携带物品页缓存（同上）
  shoppingList: [],     // 采购清单页缓存（同上）
  purchases: [],        // 采购记录页缓存（同上）
shopItems: [],        // 采购清单里的物品，供「登记一笔采购」的名称候选框使用
  purSuggestOpen: false,// 名称候选框是否展开
  purActive: -1,        // 候选框里键盘高亮到第几项
  settlement: null,     // 结算页缓存（切页签时先画缓存、再后台刷新）
  logsList: [],         // 日志缓存：日志页与概览「最近操作」共用
  tabReady: {},         // 各页签是否已有可立即绘制的缓存数据（true=切过去即可先画，不必等网络）
  tabAt: {},            // 各页签上次成功取数的时间戳（毫秒，避免短时间内重复后台刷新）
  revalidating: {},     // 正在后台刷新中的页签，避免同一页签并发刷新
};

const familyKey = (pid) => "tb_family_" + pid;
// 项目已结束时整个项目内只读：能看，不能改
const isReadonly = () => state.projectStatus === "已结束";

// ---------- 主题（浅色 / 深色） ----------
// 两套配色令牌在 style.css 顶部（:root 与 html[data-theme="dark"]），这里只负责：
// 决定用哪一套、把用户的选择记进 localStorage、同步按钮文案与浏览器地址栏配色。
const THEME_KEY = "tb_theme";
const themeMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const currentTheme = () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
const storedTheme = () => {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch (e) {
    return null;
  }
};
function applyTheme(t, persist) {
  const next = t === "dark" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {}
  }
  // 窄屏时侧边栏会铺成顶部条，所以地址栏配色要跟着主题走，避免「状态栏深、页面浅」的割裂色带。
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "dark" ? "#111629" : "#e9edf8");
  // 按钮里是太阳 / 月亮线条图标，显示哪一个由 CSS 按 data-theme 决定；
  // 这里只更新可访问名称与悬停提示（图标本身 aria-hidden，不参与朗读）
  const label = next === "dark" ? "浅色" : "深色"; // 提示写「点下去会切到哪个主题」
  const tip = "切换到" + label + "主题";
  document.querySelectorAll(".theme-btn").forEach((b) => {
    b.setAttribute("title", tip);
    b.setAttribute("aria-label", tip);
  });
}
function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
}
// 没手动选过主题时跟随系统：系统切深浅色，页面跟着切
if (themeMedia) {
  const onSysTheme = () => {
    if (!storedTheme()) applyTheme(themeMedia.matches ? "dark" : "light", false);
  };
  if (themeMedia.addEventListener) themeMedia.addEventListener("change", onSysTheme);
  else if (themeMedia.addListener) themeMedia.addListener(onSysTheme);
}
// 项目中心顶栏与项目内顶栏的主题按钮共用这一处委托
document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest('[data-action="toggle-theme"]')) toggleTheme();
});

// ---------- 接口封装 ----------
async function api(path, { method = "GET", body, withProject = true, adminPw } = {}) {
  const headers = { "content-type": "application/json" };
  if (state.token) headers["authorization"] = "Bearer " + state.token;
  if (withProject && state.projectId) headers["x-project-id"] = String(state.projectId);
  if (state.familyId) headers["x-family-id"] = String(state.familyId);
  if (adminPw) headers["x-admin-passcode"] = String(adminPw);
  const res = await fetch("/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout();
    throw new Error("口令失效，请重新登录");
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || "请求失败");
  return data;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 2200);
}

// ---------- 按钮加载态（Loading Button） ----------
// 凡是点击后会发起接口（数据库）请求的按钮，点击瞬间统一进入加载态：
// 按钮禁用 + 转圈 + 「xx中…」文案；请求结束（成功或失败）后恢复原样。
// 禁用本身就挡住了重复点击，所以同时也从根上防止了重复提交。
const BUSY_ACTIONS = {
  "confirm-del": "删除中…",
  "del-log": "删除中…",
  "clear-logs": "清除中…",
  "add-member": "添加中…",
  "save-member": "保存中…",
  "save-family": "保存中…",
  "add-family-app": "新增中…",
  "add-carry": "添加中…",
  "toggle-carry": "保存中…",
  "add-shop": "添加中…",
  "claim-shop": "接单中…",
  "unclaim-shop": "取消中…",
  "add-purchase": "登记中…",
  "open-project": "进入中…",
  "toggle-project": "处理中…",
"save-project": "保存中…",
  "save-budget": "保存中…",
  "del-project": "删除中…",
};

// 加载态「外观」这一层：转圈 + 文案 + 禁用。业务状态（dataset.busy / dataset.raw）由 setBusy 维护，
// 拆出来是为了在后台重画后能把同样的外观刷到新元素上（见 reapplyInflight）。
function paintBusy(el, label) {
  el.classList.add("is-loading");
  el.setAttribute("aria-busy", "true");
  el.disabled = true;
  const busyText = label || "处理中…";
  // 项目卡片的操作区很窄：加载态只转圈、并把按钮锁在原宽。
  // 否则「进入中…」这类变长的文字会把同排的「结束 / 改名 / 删除」挤到下一行。
  if (el.closest(".proj-card .actions")) {
    if (!el.style.minWidth) el.style.minWidth = Math.round(el.getBoundingClientRect().width) + "px";
    el.setAttribute("aria-label", busyText); // 文案仍对读屏可见，只是不占版面
    el.innerHTML = `<span class="btn-spin" aria-hidden="true"></span>`;
  } else {
    el.innerHTML = `<span class="btn-spin" aria-hidden="true"></span>${esc(busyText)}`;
  }
}
// 收掉加载态外观，并（若能）把原内容还原回来
function clearBusyLook(el) {
  el.classList.remove("is-loading");
  el.removeAttribute("aria-busy");
  el.removeAttribute("aria-label");
  el.style.removeProperty("min-width");
  if (el.dataset.raw != null) el.innerHTML = el.dataset.raw;
  delete el.dataset.busy;
  delete el.dataset.raw;
  el.disabled = false;
}

// 正在进行中的请求：key = "<动作>#<kind>:<id>" → 加载态文案。
// 把 data-kind 也编进 key：`confirm-del` 的 data-id 在不同实体（member id=3 与 family id=3）
// 之间可能重复，带上 kind 才能保证「同一实体」的加载态被精确搬到新元素上。
const INFLIGHT = new Map();
function inflightKey(btn) {
  const action = btn && btn.dataset ? btn.dataset.action : "";
  if (!action) return "";
  const kind = btn.dataset.kind ? btn.dataset.kind + ":" : "";
  return action + "#" + kind + (btn.dataset.id || "");
}
function findBusyTarget(key) {
  const i = key.indexOf("#");
  if (i < 0) return null;
  const action = key.slice(0, i);
  const rest = key.slice(i + 1);
  const j = rest.indexOf(":");
  const kind = j >= 0 ? rest.slice(0, j) : "";
  const id = j >= 0 ? rest.slice(j + 1) : rest;
  const parts = [`[data-action="${action}"]`];
  if (id) parts.push(`[data-id="${id}"]`);
  if (kind) parts.push(`[data-kind="${kind}"]`);
  return document.querySelector(parts.join(""));
}
function reapplyInflight() {
  if (!INFLIGHT.size) return;
  INFLIGHT.forEach((label, key) => {
    const el = findBusyTarget(key);
    if (!el || el.dataset.busy === "1") return;
    // 不能调 paintBusy：它会把当前 innerHTML（可能已经是上一轮留下的转圈 HTML）
    // 当作 raw 原始内容存下来，退出加载态时恢复的就是转圈而不是原始按钮文字。
    // 直接设置加载态外观，保留 paint()/DOM 重建时已存好的 dataset.raw。
    el.dataset.busy = "1";
    if (el.dataset.raw == null) el.dataset.raw = el.innerHTML;
    el.classList.add("is-loading");
    el.setAttribute("aria-busy", "true");
    el.disabled = true;
    const busyText = label || "处理中…";
    if (el.closest(".proj-card .actions")) {
      if (!el.style.minWidth) el.style.minWidth = Math.round(el.getBoundingClientRect().width) + "px";
      el.setAttribute("aria-label", busyText);
      el.innerHTML = `<span class="btn-spin" aria-hidden="true"></span>`;
    } else {
      el.innerHTML = `<span class="btn-spin" aria-hidden="true"></span>${esc(busyText)}`;
    }
  });
}

// 进入 / 退出加载态。原内容先存进 dataset，退出时原样还原（含行内图标与文字）。
function setBusy(btn, busy, label) {
  if (!btn) return;
  const key = inflightKey(btn);
  if (busy) {
    if (btn.dataset.busy === "1") return; // 已在处理中，不重复进入
    btn.dataset.busy = "1";
    btn.dataset.raw = btn.innerHTML;
    paintBusy(btn, label);
    if (key) INFLIGHT.set(key, label || "处理中…");
  } else {
    if (btn.dataset.busy !== "1") return;
    clearBusyLook(btn);
    if (key && INFLIGHT.delete(key)) {
      // 中途可能被重画换成了新元素，那个新元素上的加载态也一并收干净
      const el = findBusyTarget(key);
      if (el && el !== btn && el.dataset.busy === "1") clearBusyLook(el);
    }
  }
}

// ---------- 手机软键盘适配 ----------
// 1) 口令 / 管理密码输入框：手机系统的密码管理器（华为密码保险箱、Android 自动填充、
//    部分浏览器）会无视 autocomplete="off"，只要字段是 type="password"，就在键盘上方
//    弹出「无用户名 / 管理密码」这样的凭据面板，位置还跟着键盘乱飘。支持文本遮蔽的
//    浏览器里改用 type="text"，就不再被当成密码字段；不支持则保持 type="password"。
function hardenSecret(el) {
  if (!el) return;
  if (!(window.CSS && CSS.supports && CSS.supports("-webkit-text-security", "disc"))) return;
  el.type = "text";
  el.classList.add("secret-masked");
}
function hardenSecretInputs() {
  ["#passcode", "#adminPw", "#pcNewPasscode", "#pcNewAdminPw"].forEach((sel) => hardenSecret($(sel)));
}

// 2) 弹窗贴合可视区：软键盘弹出后 visualViewport 会收缩，只靠 position:fixed 屏幕居中
//    会把弹窗（连同它的输入框）压到键盘底下。这里让打开中的弹窗跟随 visualViewport 的
//    偏移与高度，可视高度不足时切成贴顶 + 内部滚动，并把被挡住的输入框滚回可视区。
const vv = window.visualViewport || null;
let openModal = null;
// 上一次写进 style 的几何值。软键盘弹起的那 200~300ms 里 resize 会连发几十次，
// 每次都写一遍 top/height 等于逼着浏览器逐帧重排遮罩层；这里只在数值真的变了才写。
let modalGeom = { top: null, height: null, left: null, width: null };

function syncModalToViewport() {
  if (!openModal || !vv) return;
  // 横向同理：手机上只要页面有横向溢出，布局视口就会比屏幕宽，而 position:fixed 的
  // 参照是布局视口——遮罩跟着变宽，卡片右边直接被屏幕切掉。可视区比布局视口窄时，
  // 就把遮罩收窄到可视区宽度并跟着左右偏移走；正常情况（含桌面带滚动条）不动它。
  const layoutW = document.documentElement.clientWidth;
  const narrow = !!(vv.width && layoutW && vv.width < layoutW - 1);
  const next = {
    top: Math.round(vv.offsetTop),
    height: Math.round(vv.height),
    left: narrow ? Math.round(vv.offsetLeft) : null,
    width: narrow ? Math.round(vv.width) : null,
  };

  if (next.top !== modalGeom.top) openModal.style.top = next.top + "px";
  if (next.height !== modalGeom.height) openModal.style.height = next.height + "px";
  if (next.width === null) {
    if (modalGeom.width !== null || modalGeom.left !== null) {
      openModal.style.removeProperty("left");
      openModal.style.removeProperty("width");
      openModal.style.removeProperty("right");
    }
  } else if (next.left !== modalGeom.left || next.width !== modalGeom.width) {
    openModal.style.left = next.left + "px";
    openModal.style.width = next.width + "px";
    openModal.style.right = "auto";
  }
  modalGeom = next;
  openModal.classList.toggle("modal-tight", vv.height <= MODAL_TIGHT_H);
}

// 把获得焦点的输入框滚进可视区。这里只在弹窗卡片内部滚，绝不调用 scrollIntoView：
// scrollIntoView 会把页面文档一起滚，而文档一滚 visualViewport 的 offsetTop 就变、
// 弹窗跟着上下挪，输入框又落到可视区外——来回抖动，手机上的表现就是「背景乱闪」。
function ensureFocusVisible() {
  if (!openModal || !vv) return;
  const el = document.activeElement;
  if (!el || !openModal.contains(el)) return;
  const card = el.closest(".modal-card") || openModal;
  const box = el.getBoundingClientRect();
  const cbox = card.getBoundingClientRect();
  const pad = 12;

  // 手机端底部按钮条是 sticky 吸底的，会盖住内容，得把它占的高度让出来
  let bottomEdge = cbox.bottom - pad;
  const acts = card.querySelector(".modal-actions");
  if (acts && getComputedStyle(acts).position === "sticky") {
    const abox = acts.getBoundingClientRect();
    if (abox.height && abox.top > cbox.top && abox.top < bottomEdge) bottomEdge = Math.min(bottomEdge, abox.top - 8);
  }

  if (box.bottom > bottomEdge) card.scrollTop += box.bottom - bottomEdge;
  else if (box.top < cbox.top + pad) card.scrollTop += box.top - (cbox.top + pad);
}

// 视口的 resize / scroll 事件合并到一帧里处理，避免连发事件引发的抖动
let vvRaf = 0;
function onViewportChange() {
  if (vvRaf) return;
  vvRaf = requestAnimationFrame(() => {
    vvRaf = 0;
    syncModalToViewport();
    ensureFocusVisible();
  });
}
// 打开弹窗时先同步一次几何（不能等下一帧，否则会先按整屏居中画一帧再跳）
function syncNow() {
  if (vvRaf) {
    cancelAnimationFrame(vvRaf);
    vvRaf = 0;
  }
  syncModalToViewport();
}

if (vv) {
  vv.addEventListener("resize", onViewportChange);
  vv.addEventListener("scroll", onViewportChange);
}
// 键盘可能在弹窗打开后才弹出：输入框获得焦点时再校正一次
document.addEventListener("focusin", () => setTimeout(onViewportChange, FOCUS_CORRECT_DELAY));

function setModalOpen(modal, open) {
  if (!modal) return;
if (open) {
    // 同一时刻只显示一个弹窗：手机上两张卡片上下叠着，后面那张会被两层遮罩压得发灰，
    // 看起来就像「弹窗显示异常」。这里先藏起下面那个（只是加 .hidden，DOM 与输入内容都保留），
    // askAdmin 里记了 _prev，验证结束 / 取消后会原样还原。
    if (openModal && openModal !== modal) setModalOpen(openModal, false);
    openModal = modal;
    modalGeom = { top: null, height: null, left: null, width: null };
    modal.classList.remove("hidden");
    syncNow();
    // 打开期间给根节点挂标记：CSS 用它冻结背景图层的动画、锁住页面滚动（见 style.css）
    document.documentElement.classList.add("modal-open");
    setTimeout(onViewportChange, 300); // 键盘弹起有过渡动画，稍后再校正
  } else {
    modal.classList.add("hidden");
    modal.style.removeProperty("top");
    modal.style.removeProperty("height");
    modal.style.removeProperty("left");
    modal.style.removeProperty("width");
    modal.style.removeProperty("right");
    modal.classList.remove("modal-tight");
    if (openModal === modal) openModal = null;
    modalGeom = { top: null, height: null, left: null, width: null };
    document.documentElement.classList.toggle("modal-open", !!openModal);
  }
}

// ---------- 管理权限密码弹窗 ----------
// 删除日志、清除全部日志、结束 / 删除 / 重启项目、新建项目、项目改名、设置预算等操作统一走这里：
// 弹出输入框 → 带上密码请求 → 密码不对可以重试 → 点取消则整个操作中止。
// 该弹窗可能是叠在另一个弹窗（如「新建项目」表单）之上打开的，关闭时把下面那个还原回来，
// 免得用户填到一半的表单被连带关掉、输入内容丢失。
function askAdmin(reason, errText = "", hint = "") {
  return new Promise((resolve) => {
    const modal = $("#adminModal");
    // 密码输错重试时会再次进入 askAdmin。此时 openModal 仍是 adminModal，
    // 不能再把它自己当作「下面的弹窗」——否则会把第一次记下的 _prev 覆盖掉，
    // 取消时就无法还原被压在下面的表单。
    if (!modal._prev && openModal && openModal !== modal) modal._prev = openModal;
    $("#adminReason").textContent = reason;
    $("#adminHint").textContent = hint || "本口令的管理员密码";
    $("#adminMsg").textContent = errText;
    $("#adminPw").value = "";
    $("#adminPw").disabled = false;
    $("#adminCancelBtn").disabled = false;
    setModalOpen(modal, true);
    modal._resolve = resolve;
    setTimeout(() => $("#adminPw").focus(), 30);
  });
}

// 关闭弹窗并恢复正常态：取消、请求成功、请求出错都会走这里
function hideAdmin() {
  const modal = $("#adminModal");
  const prev = modal._prev || null;
  modal._prev = null;
  modal._resolve = null;
  setModalOpen(modal, false);
  if (prev) setModalOpen(prev, true); // 还原被压在下面的弹窗
  $("#adminPw").value = "";
  $("#adminPw").disabled = false;
  $("#adminCancelBtn").disabled = false;
  setBusy($("#adminOkBtn"), false);
}

// 点「确定」：校验非空 → 弹窗内进入加载态（密码框、取消都禁用，确定按钮转圈）→
// 把密码交给 withAdmin 发请求。请求期间弹窗保持打开，用户能明确看到正在处理。
function submitAdmin() {
  const modal = $("#adminModal");
  if (!modal._resolve) return;
  const pw = $("#adminPw").value.trim();
  if (!pw) return ($("#adminMsg").textContent = "请输入密码");
  const resolve = modal._resolve;
  modal._resolve = null;
  $("#adminPw").disabled = true;
  $("#adminCancelBtn").disabled = true;
  setBusy($("#adminOkBtn"), true, "验证中…");
  resolve(pw);
}

function cancelAdmin() {
  const modal = $("#adminModal");
  const resolve = modal._resolve;
  modal._resolve = null;
  hideAdmin();
  if (resolve) resolve(null);
}

async function withAdmin(reason, run, hint = "") {
  let errText = "";
  for (;;) {
    const pw = await askAdmin(reason, errText, hint);
    if (pw == null) return false; // 用户取消了操作
    try {
      await run(pw);
      hideAdmin();
      return true;
    } catch (e) {
      // 只是密码不对就停在弹窗里重试；其他错误（如未配置密码）直接抛给调用方
      if (/密码不正确/.test(e.message)) {
        errText = e.message;
        setBusy($("#adminOkBtn"), false);
        $("#adminPw").disabled = false;
        $("#adminCancelBtn").disabled = false;
        continue;
      }
      hideAdmin();
      throw e;
    }
  }
}

// 行内“确认删除”按钮（避免浏览器弹窗，也便于自动化验证）
function isPending(kind, id) {
  return state.pending && state.pending.kind === kind && Number(state.pending.id) === Number(id);
}
function dangerCell(kind, id, actionName, label = "删除") {
  if (isPending(kind, id)) {
    return `<button class="link danger" data-action="confirm-del" data-kind="${kind}" data-id="${id}">确认删除</button>` +
      `<button class="link" data-action="cancel-del">取消</button>`;
  }
  return `<button class="link" data-action="${actionName}" data-kind="${kind}" data-id="${id}">${label}</button>`;
}

// ---------- 视图切换 ----------
function show(view) {
  ["loginView", "homeView", "pickView", "appView"].forEach((id) => $("#" + id).classList.toggle("hidden", id !== view));
}

// ---------- 登录 ----------
async function doLogin() {
  const passcode = $("#passcode").value.trim();
  if (!passcode) return ($("#loginMsg").textContent = "请输入口令");
  const btn = $("#loginBtn");
  if (btn.dataset.busy === "1") return; // 正在登录，忽略重复点击
  setBusy(btn, true, "登录中…");
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || "口令不正确");
    state.token = data.token;
    localStorage.setItem("tb_token", data.token);
    $("#loginMsg").textContent = "";
    $("#passcode").value = "";
    await afterLogin();
  } catch (e) {
    // 已经拿到 token 但后续失败（接口异常等）时，别把半截的 token 留在本地，
    // 否则刷新页面会带着它再失败一次、再 logout 一遍。
    if (state.token && !state.projectId) {
      state.token = "";
      localStorage.removeItem("tb_token");
    }
    $("#loginMsg").textContent = e.message;
  } finally {
    setBusy(btn, false);
  }
}

async function afterLogin() {
  await loadProjects();
  const saved = state.projectId && state.projects.find((p) => p.id === state.projectId);
  if (saved) await enterProject(saved.id, saved.name);
  else showHome();
}

function logout() {
  state.token = "";
  state.projectId = null;
  state.projectName = "";
  state.projectStatus = "";
  state.familyId = null;
  localStorage.removeItem("tb_token");
  localStorage.removeItem("tb_project");
  state.lastLogId = 0;
  state.newLogs = 0;
  state.pending = null;
  state.editingMember = null;
  state.editingFamily = null;
  state.editingProject = null;
  resetTabCache();
  pcAdminPw = ""; // 退出后不再保留管理权限密码：登录页的口令管理需重新验证
  pcRows = [];
  pcEditing = null;
  pcDeleting = null;
  closePcModal(); // 退出时若口令管理弹窗开着，一并关掉
  show("loginView");
}

// ---------- 项目中心 ----------
async function loadProjects() {
  state.projects = (await api("/projects", { withProject: false })).data || [];
  state.projectsAt = Date.now();
}

function renderFamRow() {
  const div = document.createElement("div");
  div.className = "fam-row";
  div.innerHTML =
    `<input class="fam-name" placeholder="家庭 / 小组名称" />` +
    `<input class="fam-members" placeholder="成员姓名，用逗号分隔（可留空）" />` +
    `<button class="link" data-action="del-fam-row">移除</button>`;
  return div;
}

// 新建项目弹窗里「移除」一行：只剩最后一行时清空输入而不是删掉，始终保留一行可填。
// 弹窗 #newProjModal 在 #homeView 之外，点击事件由弹窗自己的委托处理（见文件末尾），
// 抽成公共函数避免「添加一行 / 移除」两处逻辑分叉。
function removeFamRow(btn) {
  const row = btn.closest(".fam-row");
  if (!row) return;
  const rows = $("#famRows");
  if (rows.children.length > 1) row.remove();
  else row.querySelectorAll("input").forEach((i) => (i.value = ""));
}

// 新建项目弹窗
function openNewProj() {
  const rows = $("#famRows");
  if (!rows.children.length) for (let i = 0; i < 3; i++) rows.appendChild(renderFamRow());
  $("#projName").value = "";
  $("#projNote").value = "";
  $("#homeMsg").textContent = "";
  setModalOpen($("#newProjModal"), true);
  $("#projName").focus();
}
function closeNewProj() {
  setModalOpen($("#newProjModal"), false);
}

function showHome() {
  show("homeView");
  state.pending = null;
  state.projectStatus = "";
  closeNewProj();
  $("#homeMsg").textContent = "";
  renderProjects(); // 先用缓存出画面，不白屏
  refreshProjectsOnHome(); // 再补一次最新数据：进项目里登记采购、加人之后，卡片上的花费/人数会变
}

// 回到项目中心时重新拉一次项目列表。卡片上的「已花费」「家庭数」「成员数」都是后端汇总的，
// 只在登录、增删改项目时刷新过缓存的话，从项目里退回来看到的还是旧数字（重新登录才会变）。
// 失败就保持缓存内容，不打扰用户；期间若已经点进某个项目，则不再重绘，免得盖掉新页面。
async function refreshProjectsOnHome() {
  if (Date.now() - (state.projectsAt || 0) < 1500) return; // 刚拉过一次（登录、改名、删除后）就别重复请求
  try {
    await loadProjects();
  } catch {
    return;
  }
  if ($("#homeView").classList.contains("hidden")) return;
  renderProjects();
}

function renderProjects() {
  const list = state.projects || [];
  $("#projCount").textContent = list.length ? list.length + " 个项目" : "";
  const cards = list.map((p) => {
    const meta =
      `${p.family_count} 个家庭 · ${p.member_count} 位成员 · 已花费 ${money(p.total_amount)} · ` +
      `创建于 ${fmtTime(p.created_at)}` +
      (p.note ? " · " + esc(p.note) : "");
    if (state.editingProject === p.id) {
      return `<div class="proj-card">
        <div class="main">
          <input id="proj-edit-name-${p.id}" value="${esc(p.name)}" />
        </div>
        <div class="actions">
          <button class="primary shrink" data-action="save-project" data-id="${p.id}">保存</button>
          <button class="ghost shrink" data-action="cancel-project-edit">取消</button>
        </div>
      </div>`;
    }
    const done = p.status === "已结束";
    return `<div class="proj-card${done ? " done" : ""}">
      <div class="main">
        <div class="name">${esc(p.name)} <span class="tag${done ? " off" : ""}">${esc(p.status)}</span></div>
        <div class="meta">${meta}</div>
      </div>
      <div class="actions">
        <button class="primary shrink" data-action="open-project" data-id="${p.id}" data-name="${esc(p.name)}">进入</button>
        <button class="ghost shrink" data-action="toggle-project" data-id="${p.id}" data-status="${done ? "进行中" : "已结束"}">${done ? "重启" : "结束"}</button>
        <button class="link" data-action="edit-project" data-id="${p.id}">改名</button>
        <button class="link danger" data-action="del-project" data-id="${p.id}">删除</button>
      </div>
    </div>`;
  });
  // 末尾始终保留一张「+」卡片：没有项目时它就是那张中间带加号的空卡片
  cards.push(`<button class="proj-add" data-action="new-project">
      <span class="plus" aria-hidden="true"></span>
      <span>新建团建项目</span>
      ${list.length ? "" : '<span class="hint2">还没有项目，点这里新建一个</span>'}
    </button>`);
  $("#projList").innerHTML = cards.join("");
}

async function createProject() {
  const name = $("#projName").value.trim();
  if (!name) return ($("#homeMsg").textContent = "请输入项目名称");
  const note = $("#projNote").value.trim();
  const families = [...$("#famRows").querySelectorAll(".fam-row")]
    .map((row) => ({
      name: row.querySelector(".fam-name").value.trim(),
      members: splitNames(row.querySelector(".fam-members").value),
    }))
    .filter((f) => f.name)
    .map((f) => ({ name: f.name, members: f.members.map((n) => ({ name: n })) }));
  const btn = $("#createProjBtn");
  if (btn.dataset.busy === "1") return; // 正在创建，忽略重复点击
  setBusy(btn, true, "创建中…");
try {
    // 新建项目需要管理权限密码
    let res = null;
    const ok = await withAdmin(`新建项目「${name}」`, async (pw) => {
      res = await api("/projects", {
        method: "POST",
        body: { name, note, families },
        withProject: false,
        adminPw: pw,
      });
    });
    if (!ok) return; // 取消：保留已填内容（弹窗会被还原）
    $("#projName").value = "";
    $("#projNote").value = "";
    $("#famRows").innerHTML = "";
    $("#homeMsg").textContent = "";
    closeNewProj();
    await loadProjects();
    toast(`项目已创建：${res.family_count} 个家庭、${res.member_count} 位成员`);
    await enterProject(res.id, name);
  } catch (e) {
    $("#homeMsg").textContent = e.message;
  } finally {
    setBusy(btn, false);
  }
}

// 切换项目 / 退出登录时清空所有页签缓存，避免把上一个项目的数据画到新项目上
function resetTabCache() {
  state.tabReady = {};
  state.tabAt = {};
  state.revalidating = {};
  state.overview = null;
  state.settlement = null;
  state.logsList = [];
  state.members = [];
  state.carryItems = [];
  state.shoppingList = [];
  state.purchases = [];
  state.shopItems = [];
}

async function enterProject(id, name) {
  state.projectId = Number(id);
  state.projectName = name || (state.projects.find((p) => p.id === state.projectId) || {}).name || "团建管理";
  localStorage.setItem("tb_project", String(state.projectId));
  state.lastLogId = 0;
  state.newLogs = 0;
  state.pending = null;
state.editingMember = null;
  state.editingFamily = null;
  state.editingBudget = false;
  resetTabCache(); // 换项目：清掉上一个项目的页签缓存
  // 项目名可能已改名，状态也可能变了，取一次最新的
  state.projectStatus = (state.projects.find((p) => p.id === state.projectId) || {}).status || "";
  try {
    const d = (await api("/projects/" + state.projectId, { withProject: false })).data;
    if (d && d.project) {
      state.projectName = d.project.name;
      state.projectStatus = d.project.status;
    }
  } catch {}
  await loadFamilies();
  const saved = Number(localStorage.getItem(familyKey(state.projectId))) || null;
  if (saved && state.families.some((f) => f.id === saved)) {
    state.familyId = saved;
    showApp();
  } else if (!state.families.length) {
    // 选择家庭界面已不再提供「新增家庭」：本项目还没有家庭时先进入项目，
    // 到「成员」页新增后，再用顶栏「切换家庭」选中即可。
    state.familyId = null;
    showApp();
    toast("本项目还没有家庭，可在「成员」页新增");
  } else {
    state.familyId = null;
    showPick();
  }
}

// ---------- 家庭（项目内） ----------
async function loadFamilies() {
  state.families = (await api("/families")).data || [];
}
function familyName(id) {
  const f = state.families.find((x) => x.id === id);
  return f ? f.name : "未分配";
}
// 采购清单「接单家庭」：已认领 → 显示哪家接的（浅色副信息行里的蓝色标记，
// 与未认领的橙色「接任务」按钮形成颜色区分）；未认领 → 不显示
function claimInfo(i) {
  return i.claimed_family_id
    ? `<span class="tag claim">${esc(i.claimed_family_name || "已认领")} 接单</span>`
    : "";
}
// 采购清单「接任务 / 取消接任务」控件：未认领 → 可接；已认领 → 只有接单家庭能取消。
// 已购的项不给「取消接任务」：要回到「未接单 + 待购」只能删掉对应的采购记录（后端同样会拦）。
function claimAction(i) {
  if (i.status === "已购") return "";
  if (i.claimed_family_id) {
    const mine = Number(i.claimed_family_id) === Number(state.familyId);
    return mine ? `<button class="link" data-action="unclaim-shop" data-id="${i.id}">取消接任务</button>` : "";
  }
  // 与「待购 / 已购」状态标记同规格（同一 .pill 尺寸），接单前后高度不突变
  return `<button class="pill claim shrink" data-action="claim-shop" data-id="${i.id}">接任务</button>`;
}

// 采购状态（待购 / 已购）：完全由「采购记录」同步决定，清单里只读展示、不能点着切换。
// 登记了采购 → 变「已购」；删掉那笔记录 → 回「待购」并清掉接单家庭（后端按记录派生）。
function shopStatusCell(i) {
  const done = i.status === "已购";
  return `<span class="pill static${done ? " done" : ""}" title="由「采购记录」自动同步：登记了采购就变已购，删掉那笔记录就回到待购">${esc(i.status)}</span>`;
}

// 接任务 / 取消接任务：拿服务器返回的结果就地更新缓存并重画。
// 这样「行内状态（接单家庭标记 + 接任务/取消接任务 + 接单时间）」与 toast 提示在同一拍出现，
// 不必再等末尾那次整页 render 重新取数 —— 否则提示会比界面早一整趟网络，按钮转圈也得跟着多转一趟。
function applyClaimLocal(id, claim, claimedBy) {
  const nowUtc = () => new Date().toISOString().slice(0, 19).replace("T", " "); // 与服务端 datetime('now') 同格式
  const mine = Number(state.familyId) || null;
  const patch = (list) => {
    if (!Array.isArray(list)) return;
    const it = list.find((x) => Number(x.id) === Number(id));
    if (!it) return;
    if (claim) {
      it.claimed_family_id = mine;
      it.claimed_family_name = claimedBy || familyName(mine);
      it.claimed_at = nowUtc();
    } else {
      it.claimed_family_id = null;
      it.claimed_family_name = "";
      it.claimed_at = "";
    }
  };
  // 采购清单页用 state.shoppingList；采购记录页的「物品名称候选」用的是同一批数据（state.shopItems），
  // 两个缓存一起更新，切到采购记录时候选里就能立刻看到刚接下的项。
  patch(state.shoppingList);
  patch(state.shopItems);
  if (state.tab === "shopping") {
    paintShopping();
    applyReadonly();
    // 重画后把在途请求的加载态刷到新按钮上：否则旧按钮被替换，转圈会先断一下，
    // 状态要等末尾 setBusy(false) 才恢复，看起来就是「动画提前结束、状态过一会儿才同步」。
    reapplyInflight();
  }
}

// 后台对账：不阻塞界面地重新取一次当前页签的数据（跳过 revalidate 里「刚刷过就别再刷」的防抖），
// 用来跟上别人的改动。界面已经在上面按服务器返回更新过了，这里失败也不影响。
function refreshCurrentTabSoon() {
  const tab = state.tab;
  if (!FETCHERS[tab]) return;
  state.tabAt[tab] = 0;
  revalidate(tab).catch(() => {});
}

function showPick() {
  show("pickView");
  const ro = isReadonly();
  $("#pickSub").textContent = `项目：${state.projectName} · 选择你所属的家庭，用于记录操作日志` + (ro ? "（项目已结束，仅可查看）" : "");
  const list = $("#pickList");
  list.innerHTML = state.families.length
    ? state.families.map((f) => `<button class="pick" data-id="${f.id}">${esc(f.name)}</button>`).join("")
    : `<p class="hint">本项目还没有家庭，请进入项目后在「成员」页新增</p>`;
  list.querySelectorAll(".pick").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.familyId = Number(btn.dataset.id);
      localStorage.setItem(familyKey(state.projectId), String(state.familyId));
      showApp();
    })
  );
}

// ---------- 主界面 ----------
// 「切换家庭」就地下拉的内容：列出本项目全部家庭，点一下即切换（不再跳转到单独的选择界面）
function renderFamilyMenu() {
  const menu = $("#familyMenu");
  if (!menu) return;
  const mine = Number(state.familyId);
  menu.innerHTML = state.families.length
    ? state.families
        .map(
          (f) =>
            `<button class="family-item${f.id === mine ? " active" : ""}" data-action="pick-family" data-id="${f.id}" role="menuitem">` +
            `<span>${esc(f.name)}</span>${f.id === mine ? '<span class="hint">当前</span>' : ""}</button>`
        )
        .join("")
    : '<div class="hint" style="padding:8px 10px">本项目还没有家庭</div>';
}

// 只重建「界面框架」：标题、当前家庭、家庭下拉、页签栏（内容区交给 render / 缓存绘制）
function renderChrome() {
  $("#projTitle").innerHTML = esc(state.projectName) + (isReadonly() ? ' <span class="tag off">已结束 · 只读</span>' : "");
  $("#whoami").textContent = "当前：" + familyName(state.familyId);
  renderFamilyMenu();
  $("#familyMenu").classList.add("hidden"); // 界面重建时先收起下拉
  const nav = $("#tabs");
  // 页签按钮每次切换都会重建，但滑块必须留下来：只有同一个节点连续改 transform，
  // 浏览器才会把「旧位置 → 新位置」补成一段滑动，而不是瞬间跳过去。
  let glider = nav.querySelector(".nav-glider");
  if (!glider) {
    glider = document.createElement("span");
    glider.className = "nav-glider";
    glider.setAttribute("aria-hidden", "true");
    glider.dataset.fresh = "1"; // 首次落位不做动画，免得从左上角飞出来
  }
  nav.querySelectorAll(".tab").forEach((btn) => btn.remove());
  nav.insertAdjacentHTML(
    "beforeend",
    TABS.map(
      (t) =>
        `<button class="tab${t.key === state.tab ? " active" : ""}" data-tab="${t.key}">${t.label}` +
        (t.key === "logs" && state.newLogs
          ? `<span class="badge" aria-label="${state.newLogs} 条新日志">${state.newLogs}</span>`
          : "") +
        `</button>`
    ).join("")
  );
  nav.insertBefore(glider, nav.firstChild);
  nav.classList.add("has-glider");
  nav
    .querySelectorAll(".tab")
    .forEach((btn) => btn.addEventListener("click", () => openTab(btn.dataset.tab)));
  const animate = glider.dataset.fresh !== "1";
  delete glider.dataset.fresh;
  syncNavGlider(animate);
}

// 把高亮滑块对到当前页签。offsetLeft / offsetTop 是相对 .side-nav 内边距的位移，
// 纵向侧栏与窄屏底部横条都能直接用，不需要按方向写死某一轴为 0
// （写 0 会忽略导航列表自己的 padding，滑块整体左偏 12px）。
function syncNavGlider(animate = true) {
  const nav = $("#tabs");
  const glider = nav && nav.querySelector(".nav-glider");
  const active = nav && nav.querySelector(".tab.active");
  if (!glider || !active) return;
  // 视图隐藏（display:none）时量到的全是 0，会先把滑块压到左上角，等回到页面再滑一段飞进来
  if (!active.offsetWidth) return;
  // 先关掉过渡量一次位置再恢复：首次落位、以及断点切换（纵向↔横向）时不该播滑动
  if (!animate) glider.style.transition = "none";
  glider.style.width = active.offsetWidth + "px";
  glider.style.height = active.offsetHeight + "px";
  glider.style.transform = `translate3d(${active.offsetLeft}px, ${active.offsetTop}px, 0)`;
  glider.style.opacity = "1";
  if (!animate) {
    void glider.offsetWidth; // 强制结算一次，确保恢复过渡后不会补间刚才这一步
    glider.style.transition = "";
  }
}

// 窗口跨过断点时侧栏会在「左侧纵列」与「底部横条」之间切换，位移轴跟着变，需要重新落位
let navGliderRaf = 0;
window.addEventListener("resize", () => {
  if (navGliderRaf) return;
  navGliderRaf = requestAnimationFrame(() => {
    navGliderRaf = 0;
    syncNavGlider(false);
  });
});

// 切页签：先切高亮，再用缓存把新页签立刻画出来（网络延迟也不至于空等），随后后台刷新一次；
// 再也没有原来的「showApp() + render()」两次整页渲染，请求数直接减半。
function openTab(tab) {
  state.tab = tab;
  state.pending = null;
  if (tab === "logs") state.newLogs = 0;
  // 离开采购记录页时把名称候选框收起，免得把「正开着」的状态带到下次切回来
  if (tab !== "purchases") state.purSuggestOpen = false;
  renderChrome();
  if (paintTab(tab)) revalidate(tab);
  else render();
}

function showApp() {
  show("appView");
  renderChrome();
  const ready = render();
  // 不再做 10 秒轮询：数据只在切页签、主动操作、以及从后台切回前台时刷新
  Promise.resolve(ready).then(prefetchRest).catch(() => {});
}

// 从别的标签页 / 后台切回时补一次刷新，替代原来的定时轮询
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!state.token || $("#appView").classList.contains("hidden")) return;
  revalidate(state.tab);
});

// ---------- 表单状态快照 ----------
// 页签后台刷新会整体重建 #content，重建前先记住每个输入框里的值，重建后原样填回，
// 避免正在填写的内容被刷新清空。
function snapshotForm() {
  const c = $("#content");
  if (!c) return null;
  const fields = {};
  let n = 0;
  c.querySelectorAll("input, select, textarea").forEach((el) => {
    const key = el.id || el.tagName + "#" + n;
    n++;
    fields[key] = el.type === "checkbox" || el.type === "radio" ? (el.checked ? "1" : "0") : el.value;
  });
  const ae = document.activeElement;
  let focus = null;
  if (ae && ae !== document.body && c.contains(ae) && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) {
    focus = { key: ae.id || "", start: ae.selectionStart, end: ae.selectionEnd };
  }
  return { fields, focus, scrollY: window.scrollY || 0 };
}

function restoreForm(snap) {
  if (!snap) return;
  const c = $("#content");
  if (!c) return;
  let n = 0;
  c.querySelectorAll("input, select, textarea").forEach((el) => {
    const key = el.id || el.tagName + "#" + n;
    n++;
    if (!(key in snap.fields)) return;
    const v = snap.fields[key];
    if (el.type === "checkbox" || el.type === "radio") el.checked = v === "1";
    else if (el.value !== v) el.value = v;
  });
  const f = snap.focus;
  if (f && f.key) {
    const el = document.getElementById(f.key);
    if (el && c.contains(el)) {
      try {
        el.focus({ preventScroll: true });
        if (typeof f.start === "number" && el.setSelectionRange) el.setSelectionRange(f.start, f.end);
      } catch {}
    }
  }
  if (snap.scrollY) window.scrollTo(0, snap.scrollY);
}

// 提交成功后清空对应输入框，否则快照会把刚提交的内容又填回去
function clearFields(...ids) {
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

async function render() {
  // 页面重建是异步的（各页先拉接口、之后再整体赋值 #content）。轮询触发的重建与用户切页签可能交错：
  // 旧页签的重建会在稍后把内容盖回旧页签，于是出现「页签高亮在新页、内容还是旧页」的错位。
  // 这里在每轮重建结束后核对页签是否被改过：改过就丢弃这一轮、按当前页签重画（最多 3 轮，防止打转）。
  for (let i = 0; i < 3; i++) {
    const tab = state.tab;
    const fn = FETCHERS[tab];
    if (!fn) return;
    try {
      await fn();
      state.tabReady[tab] = true;
      state.tabAt[tab] = Date.now();
    } catch (e) {
      if (state.tab === tab) {
        $("#content").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
        return;
      }
      continue;
    }
    if (state.tab === tab) {
      // 取数完成之后再快照：否则「请求开始前」拍下的空值会在请求返回后把
      // 用户这期间刚选好的内容（例如采购记录里的物品名称）覆盖掉。
      // 这里拍的是「取数后、重画前」的最新值，重画后原样填回。
      const snap = snapshotForm();
      if (paintTab(tab)) restoreForm(snap);
      applyReadonly();
      return;
    }
  }
  // 三轮里页签都在变、没能画出来：至少用缓存把当前页签补画一次，别让内容区空着
  if (FETCHERS[state.tab] && !$("#content").firstChild) paintTab(state.tab);
}

// 用缓存把某个页签先画出来（切页签时先画缓存、网络回来再后台刷新）；没有缓存返回 false，交给整页渲染兜底
function paintTab(tab) {
  if (!state.tabReady[tab]) return false;
  const paint = PAINTERS[tab];
  if (!paint) return false;
  try {
    const keepSuggest = captureSuggestOpen(); // 用户正开着名称候选框时，重画不该把它关掉
    paint();
    applyReadonly();
    restoreSuggestOpen(keepSuggest);
    reapplyInflight(); // 重画后把在途请求的加载态刷回到新元素上
    return true;
  } catch {
    return false;
  }
}

// 后台刷新某个页签：拿到新数据后只在用户仍停在该页签时重画；失败就继续用缓存，不打扰用户
async function revalidate(tab) {
  if (!FETCHERS[tab]) return;
  if (state.revalidating[tab]) return; // 同一页签已在刷新，别叠加请求
  if (state.tabAt[tab] && Date.now() - state.tabAt[tab] < REVALIDATE_MS) return; // 刚刷新过，短时间内不再重复请求
  state.revalidating[tab] = true;
  try {
    await FETCHERS[tab]();
    state.tabReady[tab] = true;
    state.tabAt[tab] = Date.now();
    if (state.tab === tab) {
      // 快照放到取数之后：保留用户在这次后台刷新期间刚选好的内容，
      // 避免用「请求开始前」的旧快照把它盖掉。
      const snap = snapshotForm();
      if (paintTab(tab)) restoreForm(snap);
    }
  } catch {
    // 后台刷新失败：保持已画出的缓存内容
  } finally {
    state.revalidating[tab] = false;
  }
}

// 进入项目后预热其余页签：第一次切到任意页签也能先画缓存、立刻响应，再后台刷新
let prefetching = false;
async function prefetchRest() {
  if (prefetching) return;
  prefetching = true;
  try {
    for (const t of TABS.map((x) => x.key)) {
      if (state.tabReady[t] || !FETCHERS[t]) continue;
      if ($("#appView").classList.contains("hidden")) return; // 已离开主界面就不预热
      try {
        await FETCHERS[t]();
        state.tabReady[t] = true;
        // 不写 state.tabAt[t]：让用户切到该页签时的 revalidate 正常跑一次，
        // 避免「进入项目后 1 秒内切过去就不刷新」。
      } catch {}
    }
  } finally {
    prefetching = false;
  }
}

// 项目已结束：整页切成查看模式，禁掉一切编辑入口（后端也会拒）
function applyReadonly() {
  const c = $("#content");
  if (!isReadonly()) return;
  c.querySelectorAll("input, select, textarea, button").forEach((el) => {
    el.disabled = true;
  });
  if (!c.querySelector(".banner")) {
    const b = document.createElement("div");
    b.className = "banner";
    b.setAttribute("role", "status");
    b.textContent = "项目已结束 · 当前为查看模式，内容不可修改；如需修改，请在项目中心用本口令的管理员密码重启项目";
    c.prepend(b);
  }
}

function updateBadge() {
  const tab = $("#tabs").querySelector('[data-tab="logs"]');
  if (!tab) return;
  const old = tab.querySelector(".badge");
  if (old) old.remove();
  if (state.newLogs) {
    const span = document.createElement("span");
    span.className = "badge";
    span.textContent = state.newLogs;
    span.setAttribute("aria-label", state.newLogs + " 条新日志");
    tab.appendChild(span);
  }
}

// ---------- 预算进度 ----------
// 以「分」为单位的整数比较，避免浮点误差影响 60% / 100% 这两个边界：
//   进度 < 60%        → green（绿）
//   60% ≤ 进度 ≤ 100% → orange（橙）
//   进度 > 100%       → red（红）
// 预算为 0（未设置）时返回 none，不做任何着色。
function budgetTone(total, budget) {
  const bc = Math.round((Number(budget) || 0) * 100);
  if (!(bc > 0)) return "none";
  const sc = Math.round((Number(total) || 0) * 100);
  if (sc * 10 < bc * 6) return "green";
  if (sc <= bc) return "orange";
  return "red";
}

// 生成「总花费 / 预算」一行 + 进度条；预算未设置时只显示总花费与「预算：无」。
// 显示的整数百分比与颜色档次保持一致：<60% 向下取整（不会显示成 60%）、
// >100% 向上取整（不会显示成 100%）、60%~100% 四舍五入；分母分子都换成分，
// 避免浮点抖动（如 0.1+0.2 与 0.3 比较）影响显示。
function budgetProgressHtml(total, budget, label = "总花费") {
  const t = Number(total) || 0;
  const b = Number(budget) || 0;
  if (!(b > 0)) {
    return `<div class="budget-line"><span>${label} <b>${money(t)}</b></span><span class="budget-none">预算：无</span></div>`;
  }
  const tone = budgetTone(t, b);
  const rawPct = (Math.round(t * 100) * 100) / Math.round(b * 100);
  const shown = tone === "green" ? Math.floor(rawPct) : tone === "red" ? Math.ceil(rawPct) : Math.round(rawPct);
  const width = Math.max(0, Math.min(100, rawPct)); // 进度条封顶 100%，超支由红色提示
  return `<div class="budget-line">
      <span>${label} <b>${money(t)}</b> / 预算 <b>${money(b)}</b></span>
      <span class="budget-pct tone-${tone}">${shown}%</span>
    </div>
    <div class="budget-bar" role="progressbar" aria-valuenow="${shown}" aria-valuemin="0" aria-valuemax="${Math.max(100, shown)}"><span class="budget-fill tone-${tone}" style="width:${width.toFixed(2)}%"></span></div>`;
}

// 「预算与花费进度」面板的正文。概览整页渲染与「修改预算 / 取消」的局部切换共用这一份模板，
// 保证两种路径产出的 DOM 完全一致。
function budgetPanelHtml(o) {
  const hasBudget = Number(o.budget) > 0;
  return `<div class="section-head">
        <span class="title">预算与花费进度</span>
        ${state.editingBudget ? "" : `<button class="link" data-action="edit-budget">${hasBudget ? "修改预算" : "设置预算"}</button>`}
      </div>
      ${
        state.editingBudget
          ? `<div class="form-row">
               <input id="budget-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="预算金额（元）" value="${hasBudget ? o.budget : ""}" />
               <button class="primary shrink" data-action="save-budget">保存</button>
               <button class="ghost shrink" data-action="cancel-budget">取消</button>
             </div>
             <p class="hint" style="margin:8px 0 0">填 0 可取消预算设置；设置 / 修改预算需要本口令的管理员密码。</p>`
          : budgetProgressHtml(o.total_amount, o.budget)
      }`;
}

// 只重画「预算与花费进度」这一块。点「修改预算 / 取消」只是切换一个前端开关、数据没有任何变化，
// 所以不该整页重渲染、更不该重新拉接口——那样每点一次都要等三个网络往返，手感明显发顿。
function renderBudgetPanel({ focusInput = false } = {}) {
  const el = $("#budgetPanel");
  if (!el || !state.overview) return false; // 没有缓存数据时交给整页渲染兜底
  el.innerHTML = budgetPanelHtml(state.overview);
  applyReadonly();
  if (focusInput) {
    const i = $("#budget-input");
    if (i) setTimeout(() => i.focus({ preventScroll: true }), 0);
  }
  return true;
}

// ---------- 任务奖金 ----------
// 口径：奖金池由各家均摊出资，再按「各自完成的采购任务数」分回去。分配结果直接取自结算接口，
// 所以概览图表与结算页永远一致（后端按「分」精算，各家获得之和恰好等于奖金池）。
function bonusPanelHtml() {
  const o = state.overview || {};
  const s = state.settlement || {};
  const pool = Number(o.bonus) || 0;
  const has = pool > 0;
  const count = Number(s.family_count) || (state.families || []).length || 0;
  const per = count ? pool / count : 0;
  const active = !!s.bonus_active;
  const head = `<div class="section-head">
        <span class="title">任务奖金</span>
        ${state.editingBonus ? "" : `<button class="link" data-action="edit-bonus">${has ? "修改奖金" : "设置奖金"}</button>`}
      </div>`;
  if (state.editingBonus) {
    return `${head}
      <div class="form-row">
        <input id="bonus-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="奖金金额（元）" value="${has ? pool : ""}" />
        <button class="primary shrink" data-action="save-bonus">保存</button>
        <button class="ghost shrink" data-action="cancel-bonus">取消</button>
      </div>
      <p class="hint" style="margin:8px 0 0">填 0 可取消奖金设置；设置 / 修改任务奖金需要本口令的管理员密码。</p>`;
  }
  if (!has) {
    return `${head}
      <div class="budget-line"><span>任务奖金 <b>未设置</b></span><span class="budget-none">奖金：无</span></div>
      <p class="hint" style="margin:6px 0 0">设一个奖金池，各家均摊出资，再按各自完成的采购任务数分回去。</p>`;
  }
  if (!active) {
    // 奖金已设置但还没有任何「已购」任务：不分配，结算口径与没有奖金时完全一致
    return `${head}
      <div class="budget-line"><span>奖金池 <b>${money(pool)}</b> · ${count} 家各出 <b>${money(per)}</b></span><span class="budget-none">未生效</span></div>
      <p class="hint" style="margin:6px 0 0">还没有已完成（已购）的采购任务，奖金暂不分配、也不计入结算；等有任务采购完成后会自动按完成数分给各家。</p>`;
  }
  const rows = (s.detail || [])
    .slice()
    .sort((a, b) => (Number(b.bonus_out) || 0) - (Number(a.bonus_out) || 0) || (Number(b.done) || 0) - (Number(a.done) || 0));
  const max = Math.max(1, ...rows.map((d) => Number(d.bonus_out) || 0)); // 条宽按拿得最多的那家归一化
  return `${head}
    <div class="bonus-sum">
      <span>奖金池 <b>${money(pool)}</b></span>
      <span>${count} 家各出 <b>${money(per)}</b></span>
      <span>已完成 <b>${s.bonus_total_done || 0}</b> 项任务</span>
    </div>
    ${rows.map((d) => bonusRowHtml(d, max)).join("")}
    <p class="hint" style="margin:10px 0 0">净收益 = 获得奖金 − 出资，已计入结算页的应摊与转账建议。</p>`;
}

// 单行：家名 + 获得奖金占比条 + 金额；悬停看「完成数 / 出资 / 获得 / 净收益」。
// 复用 .task-row 的跟随鼠标气泡，交互与「任务接单情况」一致。
function bonusRowHtml(d, max) {
  const out = Number(d.bonus_out) || 0;
  const inn = Number(d.bonus_in) || 0;
  const net = Number(d.bonus_net) || 0;
  const done = Number(d.done) || 0;
  const pct = ((out / max) * 100).toFixed(2);
  const netTxt = signedMoney(net);
  const netCls = net > 0.004 ? "net-pos" : net < -0.004 ? "net-neg" : "";
  return `
      <div class="task-row bonus-row" tabindex="0" aria-label="${esc(d.name)}：完成 ${done} 项，获得奖金 ${money(out)}，出资 ${money(inn)}，净收益 ${netTxt}">
        <span class="task-fam">${esc(d.name)}</span>
        <div class="task-track"><span class="task-seg bonus" style="width:${pct}%"></span></div>
        <span class="task-count">${money(out)}</span>
        <div class="task-tip" aria-hidden="true">
          <div class="task-tip-head"><span class="task-tip-name">${esc(d.name)}</span><span class="task-tip-sum">完成 ${done} 项</span></div>
          <div class="task-tip-line"><span class="task-dot bonus"></span>获得奖金<b>${money(out)}</b></div>
          <div class="task-tip-line"><span class="task-dot in"></span>均摊出资<b>${money(inn)}</b></div>
          <div class="task-tip-line"><span class="task-dot net"></span>净收益<b class="${netCls}">${netTxt}</b></div>
        </div>
      </div>`;
}

// 只重画「任务奖金」这一块（切换编辑态时用，不重新拉数据）
function renderBonusPanel({ focusInput = false } = {}) {
  const el = $("#bonusPanel");
  if (!el) return false;
  el.innerHTML = bonusPanelHtml();
  applyReadonly();
  if (focusInput) {
    const i = $("#bonus-input");
    if (i) setTimeout(() => i.focus({ preventScroll: true }), 0);
  }
  return true;
}

// ---------- 概览 ----------
async function fetchOverview() {
  // 概览要用的四个接口互不依赖，并发拉取，别让网络延迟叠成四倍
  const [o, st, logs, shop] = await Promise.all([
    api("/overview"),
    api("/settlement"),
    api("/logs?since=0"), // 日志页与顶栏角标仍要这份增量游标，概览自己不再展示
    api("/shopping-items"), // 任务接单图表按「哪家接了、买到没有」统计
  ]);
  state.overview = o.data; // 缓存一份，供「修改预算 / 取消」局部重画时取用
  state.settlement = st.data || {}; // 后端返回 data: null 时给个空对象，paintOverview 里不解构就不会炸
  state.logsList = logs.data || [];
  state.lastLogId = state.logsList.length ? state.logsList[state.logsList.length - 1].id : 0;
  // 与采购清单页共用一份数据：两个缓存一起更新，切页签时接单状态立刻可见（同 claimShopping 里的约定）
  state.shoppingList = shop.data || [];
  state.shopItems = state.shoppingList;
}

function paintOverview() {
  const o = state.overview;
  const st = state.settlement || {};
  const hasBudget = Number(o.budget) > 0;
  $("#content").innerHTML = `
    <div class="cards">
      <div class="card"><div class="num">${money(o.total_amount)}</div><div class="lbl">总花费</div></div>
      <div class="card"><div class="num">${hasBudget ? money(o.budget) : "无"}</div><div class="lbl">项目预算</div></div>
      <div class="card"><div class="num">${st.family_count ? money(st.share) : "—"}</div><div class="lbl">每家应摊（${st.family_count} 家均分）</div></div>
      <div class="card"><div class="num">${o.family_count}</div><div class="lbl">家庭数</div></div>
      <div class="card"><div class="num">${o.member_count}</div><div class="lbl">成员数</div></div>
      <div class="card"><div class="num">${o.carry_done}/${o.carry_total}</div><div class="lbl">携带已带</div></div>
      <div class="card"><div class="num">${o.shopping_done}/${o.shopping_total}</div><div class="lbl">采购已购</div></div>
    </div>
    <div class="section budget-summary budget-panel" id="budgetPanel">${budgetPanelHtml(o)}</div>
    <div class="section bonus-panel" id="bonusPanel">${bonusPanelHtml()}</div>
    ${taskPanelHtml()}
  `;
}

// 概览页「任务接单情况」面板：每家一行的横向分段条形图。
// 绿色段 = 已接且已购，紫色段 = 已接但还没买（待购）；条长按接单最多的家庭归一化，
// 未接单的物品不计入任何一家，只在标题右侧的汇总里以「待接」出现。
function taskPanelHtml() {
  const items = state.shoppingList || [];
  const fams = state.families || [];

  // 家列表 = 现有家庭，再并上清单里仍挂着、但家可能已被删掉的接单方（保留历史数据不断档）
  const rows = fams.map((f) => ({ id: f.id, name: f.name }));
  const known = new Set(rows.map((r) => r.id));
  for (const it of items) {
    if (it.claimed_family_id && !known.has(it.claimed_family_id)) {
      known.add(it.claimed_family_id);
      rows.push({ id: it.claimed_family_id, name: it.claimed_family_name || "已移除的家庭" });
    }
  }

  const stats = rows
    .map((r) => {
      const mine = items.filter((it) => it.claimed_family_id === r.id);
      const done = mine.filter((it) => it.status === "已购").length;
      return { name: r.name, done, wait: mine.length - done, total: mine.length };
    })
    .sort((a, b) => b.total - a.total || b.done - a.done); // 接得多的排前面；同量时已完成多的靠前

  const unclaimed = items.filter((it) => !it.claimed_family_id).length;
  const claimed = items.length - unclaimed;
  const max = Math.max(1, ...stats.map((s) => s.total)); // 条宽归一化基准，全 0 时用 1 防除零

  const body = !items.length
    ? '<div class="empty">采购清单还没有物品，到「采购清单」页添加后这里就能看到各家的接单情况</div>'
    : stats.length
      ? stats.map((s) => taskRowHtml(s, max)).join("")
      : '<div class="empty">还没有家庭，到「成员」页新增家庭后才能接单</div>';

  return `
    <div class="section task-panel">
      <div class="section-head">
        <span class="title">任务接单情况</span>
        <span class="hint">${items.length ? `${unclaimed} 项待接 · ${claimed} 项已接单` : ""}</span>
      </div>
      ${body}
      ${stats.length && items.length ? `<div class="task-legend"><span class="task-dot done"></span>已购<span class="task-dot wait"></span>已接待购</div>` : ""}
    </div>
  `;
}

// 单行：家名 + 分段条 + 数字，附带一个自定义气泡（原生 title 没法做样式，也撑不下两行明细）。
// tip 用 aria-hidden 藏起来、行上给 aria-label，读屏不会念两遍。
function taskRowHtml(s, max) {
  const segs = s.total
    ? `<span class="task-seg done" style="width:${((s.done / max) * 100).toFixed(2)}%"></span><span class="task-seg wait" style="width:${((s.wait / max) * 100).toFixed(2)}%"></span>`
    : "";
  const label = s.total
    ? `${s.name}：已接 ${s.total} 项，已购 ${s.done} 项，待购 ${s.wait} 项`
    : `${s.name}：还没接单`;
  const tip = `
        <div class="task-tip" aria-hidden="true">
          <div class="task-tip-head"><span class="task-tip-name">${esc(s.name)}</span>${
            s.total ? `<span class="task-tip-sum">已接 ${s.total} 项</span>` : ""
          }</div>
          ${
            s.total
              ? `<div class="task-tip-line"><span class="task-dot done"></span>已购<b>${s.done}</b>项</div>
                 <div class="task-tip-line"><span class="task-dot wait"></span>待购<b>${s.wait}</b>项</div>`
              : `<div class="task-tip-none">还没接单</div>`
          }
        </div>`;
  return `
      <div class="task-row" tabindex="0" aria-label="${esc(label)}">
        <span class="task-fam">${esc(s.name)}</span>
        <div class="task-track">${segs}</div>
        <span class="task-count">${s.total}</span>
        ${tip}
      </div>`;
}

function logHtml(l, deletable = false) {
  return `<div class="log-item">
      <div class="log-time">${fmtTime(l.created_at)}</div>
      <div class="log-body"><span class="log-who">${esc(l.actor_name || "系统")}</span> ${esc(l.action)}${l.detail ? "：" + esc(l.detail) : ""}</div>
      ${deletable ? `<button class="link danger log-del" data-action="del-log" data-id="${l.id}">删除</button>` : ""}
    </div>`;
}

// ---------- 成员（手动添加 / 修改 / 删除） ----------
// 纯前端切换（进入 / 退出编辑态、行内「确认删除 / 取消」…）后只重画当前页签的内容块：
// 数据没有任何变化，用缓存重画即可，不必重新拉接口、也不必重建整页。
function paintCurrentTab() {
  const map = { members: paintMembers, carry: paintCarry, shopping: paintShopping, purchases: paintPurchases };
  const paint = map[state.tab];
  if (!paint) return false; // 当前页签没有对应画匠，就交给整页渲染兜底
  try {
    const keepSuggest = captureSuggestOpen(); // 同上：局部重画也别把正开着的候选框关掉
    paint();
    applyReadonly();
    restoreSuggestOpen(keepSuggest);
    reapplyInflight(); // 同上
    return true;
  } catch {
    return false;
  }
}

async function fetchMembers() {
  state.members = (await api("/members")).data || [];
}

// 只重画成员页内容（用缓存数据），供纯前端切换调用
function paintMembers() {
  const mems = state.members || [];
  const mine = state.familyId;
  const groups = state.families
    .map((f) => {
      const list = mems.filter((m) => m.family_id === f.id);
      const isMine = f.id === mine;
      const head = !isMine
        ? `<div class="section-head">
             <span class="title">${esc(f.name)}</span>
             <span class="hint">${list.length} 人 · 其他家庭只读</span>
           </div>`
        : state.editingFamily === f.id
          ? `<div class="section-head">
               <input id="fam-edit-name-${f.id}" value="${esc(f.name)}" style="max-width:220px" />
               <span>
                 <button class="primary shrink" data-action="save-family" data-id="${f.id}">保存</button>
                 <button class="ghost shrink" data-action="cancel-family-edit">取消</button>
               </span>
             </div>`
          : `<div class="section-head">
               <span class="title">${esc(f.name)} <span class="mine">（我的家庭）</span></span>
               <span class="hint">${list.length} 人
                 <button class="link" data-action="edit-family" data-id="${f.id}">重命名</button>
                 ${dangerCell("family", f.id, "del-family", "删除家庭")}
               </span>
             </div>`;
      const rows = list
        .map((m) => {
          if (isMine && state.editingMember === m.id) {
            return `<div class="row">
              <div class="main form-row" style="gap:8px">
                <input id="mem-edit-name-${m.id}" value="${esc(m.name)}" placeholder="姓名" style="max-width:180px" />
                <input id="mem-edit-note-${m.id}" value="${esc(m.note)}" placeholder="备注（忌口/过敏）" style="max-width:240px" />
              </div>
              <button class="primary shrink" data-action="save-member" data-id="${m.id}">保存</button>
              <button class="ghost shrink" data-action="cancel-member-edit">取消</button>
            </div>`;
          }
          return `<div class="row">
            <div class="main"><div class="name">${esc(m.name)}</div><div class="meta">${esc(m.role)}${m.note ? " · " + esc(m.note) : ""}</div></div>
            ${isMine
              ? `<button class="link" data-action="edit-member" data-id="${m.id}">修改</button>${dangerCell("member", m.id, "del-member")}`
              : ""}
          </div>`;
        })
        .join("");
      return `<div class="section${isMine ? "" : " readonly"}">
        ${head}
        ${list.length ? rows : '<div class="empty">暂无成员</div>'}
        ${isMine
          ? `<div class="form-row" style="margin-top:10px">
               <input id="mem-name-${f.id}" placeholder="成员姓名（可一次填多个，用逗号分隔）" />
               <input id="mem-note-${f.id}" placeholder="备注（忌口/过敏）" />
               <button class="ghost shrink" data-action="add-member" data-fid="${f.id}">添加</button>
             </div>`
          : '<p class="hint" style="margin:8px 0 0">只可查看，若要管理请先切换到该家庭</p>'}
      </div>`;
    })
    .join("");
  const addFamily = `<div class="section">
    <div class="section-head"><span class="title">新增家庭 / 小组</span></div>
    <div class="form-row">
      <input id="new-family-in-app" placeholder="家庭 / 小组名称" />
      <button class="ghost shrink" data-action="add-family-app">新增家庭</button>
    </div>
    <p class="hint" style="margin:8px 0 0">结算按家庭数均分，新增或删除家庭会直接影响每家应摊金额。</p>
  </div>`;
  $("#content").innerHTML =
    (groups || '<div class="empty">本项目还没有家庭，先新增一个</div>') + addFamily;
}

// ---------- 携带物品 ----------
async function fetchCarry() {
  state.carryItems = (await api("/carry-items")).data || [];
}

// 只重画携带物品页内容（用缓存数据）
function paintCarry() {
  const items = state.carryItems || [];
  const mine = state.familyId;
  const groups = state.families
    .map((f) => {
      const list = items.filter((i) => i.family_id === f.id);
      const isMine = f.id === mine;
return `<div class="section${isMine ? "" : " readonly"}">
        <div class="section-head">
          <span class="title">${esc(f.name)}${isMine ? ' <span class="mine">（我的家庭）</span>' : ""}</span>
          <span class="hint">${list.length} 项</span>
        </div>
        ${list.length
          ? list
              .map(
                (i) => `<div class="row">
                  <div class="main"><div class="name">${esc(i.name)} ${i.quantity ? '<span class="tag">' + esc(i.quantity) + "</span>" : ""}</div>
                    ${i.note ? `<div class="meta">${esc(i.note)}</div>` : ""}</div>
                  <button class="pill${i.status === "已带" ? " done" : ""}" ${isMine ? `data-action="toggle-carry" data-id="${i.id}" data-status="${i.status === "已带" ? "待带" : "已带"}"` : "disabled"}>
                    ${esc(i.status)}
                  </button>
                  ${isMine ? dangerCell("carry", i.id, "del-carry") : ""}
                </div>`
              )
              .join("")
          : '<div class="empty">暂无</div>'}
        ${isMine
          ? `<div class="form-row" style="margin-top:10px">
               <input id="carry-name" placeholder="物品名称" />
               <input id="carry-qty" class="shrink" style="flex:0 0 90px" placeholder="数量" />
               <button class="ghost shrink" data-action="add-carry">添加</button>
             </div>`
          : '<p class="hint" style="margin-top:8px">仅本家庭可编辑，其他家庭只读</p>'}
      </div>`;
    })
    .join("");
  const orphan = items.filter((i) => !i.family_id);
  const orphanHtml = orphan.length
    ? `<div class="section"><div class="section-head"><span class="title">未分配</span></div>${orphan
        .map((i) => `<div class="row"><div class="main"><div class="name">${esc(i.name)}</div></div><span class="tag">${esc(i.status)}</span></div>`)
        .join("")}</div>`
    : "";
  $("#content").innerHTML = (groups || "") + orphanHtml;
}

// ---------- 采购清单 ----------
async function fetchShopping() {
  state.shoppingList = (await api("/shopping-items")).data || [];
}

// 只重画采购清单页内容（用缓存数据）
function paintShopping() {
  const items = state.shoppingList || [];
  const waiting = items.filter((i) => i.status === "待购").length;
  const claimed = items.filter((i) => i.claimed_family_id).length;
  $("#content").innerHTML = `
    <div class="section">
      <div class="section-head">
        <span class="title">采购清单</span>
        <span class="hint">${waiting} 项待购 · ${claimed} 项已被接单</span>
      </div>
      <div class="form-row">
        <input id="shop-name" placeholder="采购项名称" />
        <input id="shop-qty" class="shrink" style="flex:0 0 70px" placeholder="数量" />
        <input id="shop-unit" class="shrink" style="flex:0 0 70px" placeholder="单位" />
        <button class="ghost shrink" data-action="add-shop">添加</button>
      </div>
      <p class="hint" style="margin:8px 0 0"></p>
      <div style="margin-top:10px">
        ${items.length
          ? items
              .map((i) => {
                // 副信息行（浅色小字）：数量 / 单位 / 备注，再接接单家庭标记与接单时间
                const sub = [i.quantity && esc(i.quantity), i.unit && esc(i.unit), i.note && esc(i.note)]
                  .filter(Boolean)
                  .join(" · ");
                return `<div class="row shop-row">
                  <div class="main">
                    <div class="name">${esc(i.name)}</div>
                    <div class="meta shop-meta">${sub ? `<span class="m">${sub}</span>` : ""}${claimInfo(i)}${
                  i.claimed_at ? `<span class="m">接单于 ${fmtTime(i.claimed_at)}</span>` : ""
                }</div>
                  </div>
                  <div class="shop-actions">
                    ${claimAction(i)}
                    ${shopStatusCell(i)}
                    ${
                      i.status === "已购"
                        ? // 已经登记过采购记录的项不能删：删除控件保持占用但不可用，原因写进 title / aria-label，
                          // 页面下方的规则说明里也写清「删掉采购记录即可恢复可删除」。删掉记录后 status 回「待购」，删除自动恢复可用。
                          `<button class="link" data-action="del-shop" data-id="${i.id}" disabled aria-disabled="true" title="这一项已经登记过采购记录，不能删除；删掉对应的采购记录后它会回到「未接单 + 待购」，那时才能删" aria-label="删除不可用：这一项已经登记过采购记录，删掉对应的采购记录后即可删除">删除</button>`
                        : dangerCell("shopping", i.id, "del-shop")
                    }
                  </div>
                </div>`;
              })
              .join("")
          : '<div class="empty">清单为空</div>'}
      </div>
    </div>`;
}

// ---------- 物品名称候选框（自绘下拉 · 只能选、不能新增） ----------
// 候选只来自采购清单里「当前家庭已接任务」的项目，且只保留还没登记过采购的：
// 已经采购过（清单里派生为「已购」）的项不再出现在候选里，避免同一项被重复登记。
// 输入框是只读的（点开候选选一个，不能手打新名称），颜色走主题令牌，可随时收起。
function purCandidates() {
  const mine = Number(state.familyId);
  return (state.shopItems || []).filter(
    (s) => !!s.claimed_family_id && Number(s.claimed_family_id) === mine && s.status !== "已购"
  );
}
function setSuggestOpen(open) {
  const box = $("#pur-suggest"), input = $("#pur-item"), toggle = $("#pur-combo .combo-toggle");
  if (!box || !input) return;
  state.purSuggestOpen = !!open;
  if (state.purSuggestOpen) {
    // 输入框只是展示位（选中后会被填上名称），不能拿它的值当搜索词：
    // 否则选过一次之后再重开，列表就只剩被选中的那一条，换不了别的项。恒列全部可选项。
    const items = purCandidates();
    state.purActive = -1;
    box.innerHTML = items.length
      ? items
          .map(
            (s, i) =>
              `<li role="option" id="pur-opt-${i}" data-action="pick-suggest" data-value="${esc(s.name)}" aria-selected="false">${esc(s.name)}` +
              (s.quantity ? `<span class="combo-sub">${esc(s.quantity)} ${esc(s.unit || "")}</span>` : "") +
              `</li>`
          )
          .join("")
      : `<li class="combo-empty" role="presentation">${state.familyId ? "当前没有可登记的项目：先到「采购清单」接任务；已经登记过采购的项不会再出现在这里" : "请先选择你所属的家庭"}</li>`;
  } else {
    state.purActive = -1;
    input.removeAttribute("aria-activedescendant");
  }
  box.hidden = !state.purSuggestOpen;
  input.setAttribute("aria-expanded", state.purSuggestOpen ? "true" : "false");
  if (toggle) toggle.setAttribute("aria-expanded", state.purSuggestOpen ? "true" : "false");
  // 卡片上的 isolation 把下拉面板关在了自己的层叠上下文里，下面那张「各家采购金额」会盖住它。
  // 展开时给所在卡片打个标记抬到最上层（CSS: .section.has-open-menu），收起时摘掉。
  const host = $("#pur-combo");
  const hostSec = host && host.closest(".section");
  if (hostSec) hostSec.classList.toggle("has-open-menu", state.purSuggestOpen);
}
// 重画内容区（后台刷新、切页签后的补画、局部重画）都会重建 #content，采购记录页的名称候选框
// 会被顺手收起。用户正开着候选框时先记下这个状态，重画完再展开，避免「刚点开就自己消失」。
function captureSuggestOpen() {
  return state.tab === "purchases" && !!state.purSuggestOpen;
}
function restoreSuggestOpen(keep) {
  if (keep && state.tab === "purchases" && !state.purSuggestOpen) setSuggestOpen(true);
}
function moveSuggestActive(delta) {
  const opts = [...document.querySelectorAll('#pur-suggest li[role="option"]')];
  if (!opts.length) return;
  state.purActive = (state.purActive + delta + opts.length) % opts.length;
  opts.forEach((o, i) => o.setAttribute("aria-selected", i === state.purActive ? "true" : "false"));
  const active = opts[state.purActive];
  $("#pur-item").setAttribute("aria-activedescendant", active.id);
  active.scrollIntoView({ block: "nearest" });
}
function chooseSuggestActive() {
  const opts = [...document.querySelectorAll('#pur-suggest li[role="option"]')];
  if (state.purActive < 0 || !opts[state.purActive]) return false;
  $("#pur-item").value = opts[state.purActive].dataset.value || "";
  setSuggestOpen(false);
  return true;
}
$("#content").addEventListener("focusin", (e) => {
  if (e.target.id === "pur-item") setSuggestOpen(true);
});
$("#content").addEventListener("focusout", (e) => {
  if (e.target.id !== "pur-item") return;
  // 焦点还在输入框里、或落到了同一个候选框上的按钮时，不收起来；
  // 等到确实点到别处再收，这样点候选项的那一下不会被提前打断。
  setTimeout(() => {
    const a = document.activeElement;
    if (a && (a.id === "pur-item" || (a.closest && a.closest("#pur-combo")))) return;
    setSuggestOpen(false);
  }, FOCUSOUT_DELAY);
});
$("#content").addEventListener("mousedown", (e) => {
  // 候选项目不可获得焦点，按下时别让输入框失焦（否则会先收起来再点不到）
  if (e.target.closest && e.target.closest('#pur-suggest li[role="option"]')) e.preventDefault();
});

// 接单明细气泡跟随指针：横向贴着鼠标，小箭头永远指向鼠标所在的 x。
// 气泡先按「鼠标 - 半个箭头」摆位，再在面板内左右各夹 8px；箭头再在气泡内部夹一次，
// 所以靠到两端时气泡会拐回来、箭头依然指着鼠标，不会戳出面板外。
$("#content").addEventListener("pointermove", (e) => {
  const row = e.target.closest && e.target.closest(".task-row");
  if (!row) return;
  const tip = row.querySelector(".task-tip");
  if (tip) placeTaskTip(row, tip, e.clientX);
});
// 触摸端没有 hover：点按抬起前先把气泡对到手指位置（focus-within 负责显示）
$("#content").addEventListener("pointerdown", (e) => {
  const row = e.target.closest && e.target.closest(".task-row");
  if (!row) return;
  const tip = row.querySelector(".task-tip");
  if (tip) placeTaskTip(row, tip, e.clientX);
});

function placeTaskTip(row, tip, clientX) {
  const box = row.getBoundingClientRect();
  const x = clientX - box.left; // 指针相对行左边缘的距离
  // 气泡宽度只在内容生成后量一次；同一次渲染里内容不变，避免每次移动都触发布局计算
  if (!tip.dataset.w) tip.dataset.w = String(tip.offsetWidth || 134);
  const w = Number(tip.dataset.w) || 134;
  const pad = 6;
  const left = Math.min(Math.max(x - 18, pad), Math.max(pad, box.width - w - pad));
  tip.style.left = left + "px";
  // 箭头夹在圆角半径（13px）以内：再靠边就会从圆角外侧露出小方块的毛边
  const arrow = Math.min(Math.max(x - left, 13), Math.max(13, w - 13));
  tip.style.setProperty("--ax", arrow + "px");
}

$("#content").addEventListener("keydown", (e) => {
  if (e.target.id !== "pur-item") return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (state.purSuggestOpen) moveSuggestActive(1);
    else setSuggestOpen(true);
  } else if (e.key === "ArrowUp") {
    if (!state.purSuggestOpen) return;
    e.preventDefault();
    moveSuggestActive(-1);
  } else if (e.key === "Enter") {
    if (state.purSuggestOpen && chooseSuggestActive()) e.preventDefault();
  } else if (e.key === "Escape") {
    if (!state.purSuggestOpen) return;
    e.preventDefault();
    setSuggestOpen(false);
  }
});

// ---------- 采购记录 ----------
async function fetchPurchases() {
  // 三个接口互不依赖，并发拉取
  const [p, s, o] = await Promise.all([api("/purchases"), api("/shopping-items"), api("/overview")]);
  state.purchases = p.data || [];
  state.shopItems = s.data || [];
  state.overview = o.data || {};
}

// 只重画采购记录页内容（用缓存数据），供纯前端切换调用
function paintPurchases() {
  const list = state.purchases || [];
  const ov = state.overview || {};
  const budget = Number(ov.budget) || 0;
  // 总花费按本页列出的采购明细就地汇总，保证与下方明细一致
  const spent = list.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  // 后台刷新 / 轮询会重建 #content，下拉面板的 DOM 会被销毁。
  // 在重建前记住面板当前的开合状态，重建后恢复，避免用户正开着面板时被意外收起。
  // （输入框里的值由 render/revalidate 的「取数后快照 + restoreForm」负责保留，不在这里处理。）
  const suggestBox = $("#pur-suggest");
  const suggestWasOpen = !!(suggestBox && !suggestBox.hidden);
  state.purSuggestOpen = false;  // 先按收起处理；若之前确实开着，末尾会再打开
  state.purActive = -1;
  const perFamily = {};
  list.forEach((p) => (perFamily[p.family_id] = (perFamily[p.family_id] || 0) + (Number(p.amount) || 0)));
  // 家庭金额标签改用 flex 容器排布：行内 span 靠 margin-right 拼接时，换行后的行距只有
  // 父级 line-height，手机端两行会贴在一起；flex 的 row-gap 才能给「陈家 / 赵家」之间留出稳定间距。
  const summary = state.families.length
    ? `<div class="fam-summary">${state.families
        .map((f) => `<span class="tag">${esc(f.name)} ${money(perFamily[f.id] || 0)}</span>`)
        .join("")}</div>`
    : '<span class="hint">还没有家庭</span>';
$("#content").innerHTML = `
    <div class="section">
      <div class="section-head"><span class="title">登记一笔采购</span></div>
      <div class="form-row">
        <div class="combo" id="pur-combo">
          <input id="pur-item" class="combo-input" placeholder="从你已接单的项目里选" autocomplete="off" spellcheck="false" readonly role="combobox" aria-expanded="false" aria-controls="pur-suggest" aria-autocomplete="none" />
          <button class="combo-toggle" type="button" data-action="toggle-suggest" aria-expanded="false" aria-label="展开或收起物品名称候选" title="展开或收起候选"><svg class="combo-caret" aria-hidden="true" focusable="false" width="16" height="16"><use href="#icon-chevron"></use></svg></button>
          <ul class="combo-list" id="pur-suggest" role="listbox" aria-label="物品名称候选" hidden></ul>
        </div>
        <input id="pur-amount" class="shrink" style="flex:0 0 90px" type="number" min="0" step="0.01" placeholder="金额" />
        <button class="ghost shrink" data-action="add-purchase">登记</button>
      </div>
<p class="hint" style="margin:8px 0 0"></p>
    </div>
    <!-- 「各家采购金额」面板用普通面板底色（与上方「登记一笔采购」一致）；进度条与百分比仍按档位着色 -->
    <div class="section budget-summary">
      <div class="section-head"><span class="title">各家采购金额</span></div>
      ${budgetProgressHtml(spent, budget)}
      <div style="margin-top:10px">${summary}</div>
    </div>
    <div class="section">
      <div class="section-head"><span class="title">采购明细</span><span class="hint">${list.length} 笔</span></div>
      ${list.length
        ? list
            .map(
              (p) => `<div class="row">
                <div class="main"><div class="name">${esc(p.item_name)}</div>
                  <div class="meta">${esc(familyName(p.family_id))} · ${fmtTime(p.purchased_at)}${p.quantity ? " · " + esc(p.quantity) : ""}</div></div>
                <span class="amt">${money(p.amount)}</span>
                ${
                  Number(p.family_id) === Number(state.familyId)
                    ? dangerCell("purchase", p.id, "del-purchase")
                    : '<span class="tag off" title="只有登记这笔采购的家庭能删除">他家登记</span>'
                }
              </div>`
            )
            .join("")
        : '<div class="empty">暂无采购记录</div>'}
    </div>`;
  // DOM 已重建。若重建前候选面板是打开的，把它恢复到打开状态并重新填充候选项，
  // 这样后台刷新 / 轮询不会把用户正在做的选择打断。
  if (suggestWasOpen) {
    state.purSuggestOpen = true;
    setSuggestOpen(true);
  }
}

// ---------- 结算 ----------
async function fetchSettlement() {
  state.settlement = (await api("/settlement")).data || {};
}

function paintSettlement() {
  const s = state.settlement || {};
  const detail = s.detail || [];
  const transfers = s.transfers || [];
  const bonus = Number(s.bonus) || 0;
  const bonusActive = !!s.bonus_active;
  // 只要项目设置了任务奖金池（含尚未生效的情况），「每家结算」就补一列「任务奖金」（= 该家获得的奖金）。
  // 放在「应摊」之后，让「已垫付 + 任务奖金 − 应摊 = 差额」这条算式在同一行里直接可读。
  const showBonusCol = bonus > 0;
  // 奖金明细按「获得」从多到少排，拿得多的排前面
  const bonusRows = detail
    .slice()
    .sort((a, b) => (Number(b.bonus_out) || 0) - (Number(a.bonus_out) || 0) || (Number(b.done) || 0) - (Number(a.done) || 0));
  $("#content").innerHTML = `
<div class="cards">
      <div class="card"><div class="num">${money(s.total)}</div><div class="lbl">总花费</div></div>
      <div class="card"><div class="num">${money(s.share)}</div><div class="lbl">每家应摊（${s.family_count} 家均分${bonusActive ? "，含奖金池" : ""}）</div></div>
      ${bonus > 0 ? `<div class="card"><div class="num">${money(bonus)}</div><div class="lbl">任务奖金池${bonusActive ? `（已完成 ${s.bonus_total_done} 项）` : "（未生效）"}</div></div>` : ""}
    </div>
    <div class="section">
      <div class="section-head"><span class="title">每家结算</span><span class="hint">分摊口径：${esc(s.basis || "按家庭数均分")}</span></div>
      <table class="settle-table">
        <thead><tr><th>家庭</th><th class="r">已垫付</th><th class="r">应摊</th>${showBonusCol ? '<th class="r">任务奖金</th>' : ""}<th class="r">差额</th></tr></thead>
        <tbody>
          ${detail
            .map(
              (d) => `<tr>
                <td>${esc(d.name)}</td>
                <td class="r">${money(d.paid)}</td>
                <td class="r">${money(d.share)}</td>
                ${showBonusCol ? `<td class="r">${money(d.bonus_out)}</td>` : ""}
                <td class="r ${d.balance > 0 ? "pos" : d.balance < 0 ? "neg" : ""}">${signedMoney(d.balance)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p class="hint" style="margin-top:10px">差额为正 = 该家庭多垫付、应收回；为负 = 应补付。${
        bonusActive
          ? `差额 = 已垫付 + 任务奖金 − 应摊；应摊已含奖金池出资（每家 ${money(s.bonus_contribution)}）。`
          : bonus > 0
            ? "奖金池尚未生效（还没有已完成的采购任务），「任务奖金」列暂按 0 计。"
            : ""
      }</p>
    </div>
    ${
      bonus > 0
        ? `<div class="section">
      <div class="section-head">
        <span class="title">任务奖金</span>
        <span class="hint">${
          bonusActive
            ? `奖金池 ${money(bonus)} · 每家出资 ${money(s.bonus_contribution)} · 按已完成采购数分配`
            : `奖金池 ${money(bonus)} · 还没有已完成的采购任务，暂不分配`
        }</span>
      </div>
      <table>
        <thead><tr><th>家庭</th><th class="r">已完成</th><th class="r">出资</th><th class="r">获得</th><th class="r">净收益</th></tr></thead>
        <tbody>
          ${bonusRows
            .map((d) => {
              const net = Number(d.bonus_net) || 0;
              const netTxt = signedMoney(net);
              return `<tr>
                <td>${esc(d.name)}</td>
                <td class="r">${Number(d.done) || 0} 项</td>
                <td class="r">${money(d.bonus_in)}</td>
                <td class="r">${money(d.bonus_out)}</td>
                <td class="r ${net > 0.004 ? "pos" : net < -0.004 ? "neg" : ""}">${netTxt}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
      <p class="hint" style="margin-top:10px">净收益 = 获得奖金 − 出资；出资计入上面的「应摊」，获得奖金计入「差额」。</p>
    </div>`
        : ""
    }
    <div class="section">
      <div class="section-head"><span class="title">结算建议</span></div>
      ${transfers.length
        ? transfers
            .map((t) => `<div class="row"><div class="main"><span class="name">${esc(t.from)}</span> 应付给 <span class="name">${esc(t.to)}</span></div><span class="amt">${money(t.amount)}</span></div>`)
            .join("")
        : '<div class="empty">无需转账，账目已平</div>'}
    </div>`;
}

// ---------- 日志 ----------
async function fetchLogs() {
  state.logsList = (await api("/logs?since=0")).data || [];
  state.lastLogId = state.logsList.length ? state.logsList[state.logsList.length - 1].id : 0;
}

function paintLogs() {
  const logs = state.logsList || [];
  state.newLogs = 0;
  updateBadge();
  const canDel = !isReadonly();
  $("#content").innerHTML = logs.length
    ? `<div class="section-head" style="margin-bottom:6px">
         <span class="hint">共 ${logs.length} 条${canDel ? " · 删除/清除需要本口令的管理员密码" : ""}</span>
         ${canDel ? `<button class="link danger" data-action="clear-logs">清除全部日志</button>` : ""}
       </div>
       <div class="logs">${logs.slice().reverse().map((l) => logHtml(l, canDel)).join("")}</div>`
    : '<div class="empty">暂无操作记录</div>';
}

// 取数（网络）与绘制（DOM）拆开：切页签时先用缓存画、再后台取数刷新
const FETCHERS = {
  overview: fetchOverview,
  members: fetchMembers,
  carry: fetchCarry,
  shopping: fetchShopping,
  purchases: fetchPurchases,
  settlement: fetchSettlement,
  logs: fetchLogs,
};

const PAINTERS = {
  overview: paintOverview,
  members: paintMembers,
  carry: paintCarry,
  shopping: paintShopping,
  purchases: paintPurchases,
  settlement: paintSettlement,
  logs: paintLogs,
};

// ---------- 项目内事件委托 ----------
$("#content").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) {
    // 只读的名称输入框没有 data-action：点它（哪怕它已经处于聚焦状态）都展开候选。
    // 只靠 focusin 有个死角——从候选里选完一项后输入框仍是聚焦的，再点它不触发 focusin，
    // 于是就「选过一次就拉不下来了」。
    if (e.target.id === "pur-item") setSuggestOpen(true);
    return;
  }
  if (btn.dataset.busy === "1") return; // 正在处理中，忽略重复点击
  const { action, id, fid, status, kind } = btn.dataset;
  const busyLabel = BUSY_ACTIONS[action];
  if (busyLabel) setBusy(btn, true, busyLabel);
  try {
    if (action === "confirm-del") {
      state.pending = null;
      const path = { member: "members", family: "families", carry: "carry-items", shopping: "shopping-items", purchase: "purchases" }[kind];
      if (path) await api("/" + path + "/" + id, { method: "DELETE" });
      if (kind === "family") {
        await loadFamilies();
        if (state.familyId && !state.families.some((f) => f.id === Number(state.familyId))) {
          state.familyId = null;
          localStorage.removeItem(familyKey(state.projectId));
        }
        // 顶栏「当前：某家」与家庭下拉都在 renderChrome 里，删掉的若是当前家庭要跟着刷新
        renderChrome();
      }
    } else if (action === "cancel-del") {
      // 收起行内「确认删除」：纯前端切换，只重画当前页签
      state.pending = null;
      if (paintCurrentTab()) return;
    } else if (action === "del-member" || action === "del-family" || action === "del-carry" || action === "del-shop" || action === "del-purchase") {
      // 点「删除」先进行内确认态：同样是纯前端切换
      state.pending = { kind, id: Number(id) };
      if (paintCurrentTab()) return;
    } else if (action === "del-log") {
      const ok = await withAdmin("删除这条操作日志", async (pw) => {
        await api("/logs/" + id, { method: "DELETE", adminPw: pw });
      });
      if (!ok) return; // 密码框点了「取消」：什么都没变，不必重渲染
      toast("日志已删除");
    } else if (action === "clear-logs") {
      // 一键清除本项目全部日志：不可恢复，清除前必须输入管理权限密码
      const ok = await withAdmin("清除本项目全部操作日志（清除后不可恢复）", async (pw) => {
        await api("/logs", { method: "DELETE", adminPw: pw });
      });
      if (!ok) return; // 同上：取消不重渲染
      state.lastLogId = 0;
      state.newLogs = 0;
      toast("全部日志已清除");
    } else if (action === "add-member") {
      const names = splitNames($("#mem-name-" + fid).value);
      if (!names.length) return toast("请输入成员姓名");
      const note = $("#mem-note-" + fid).value.trim();
      for (const n of names) await api("/members", { method: "POST", body: { name: n, family_id: Number(fid), note } });
clearFields("mem-name-" + fid, "mem-note-" + fid);
    } else if (action === "edit-member") {
      // 进入编辑态：纯前端切换，只重画成员页
      state.editingMember = Number(id);
      state.editingFamily = null;
      if (paintCurrentTab()) return;
    } else if (action === "cancel-member-edit") {
      state.editingMember = null;
      if (paintCurrentTab()) return;
    } else if (action === "save-member") {
      const name = $("#mem-edit-name-" + id).value.trim();
      if (!name) return toast("请输入成员姓名");
      await api("/members/" + id, { method: "PUT", body: { name, note: $("#mem-edit-note-" + id).value.trim() } });
      state.editingMember = null;
    } else if (action === "edit-family") {
      // 进入重命名编辑态：同上，只重画成员页
      state.editingFamily = Number(id);
      state.editingMember = null;
      if (paintCurrentTab()) return;
    } else if (action === "cancel-family-edit") {
      state.editingFamily = null;
      if (paintCurrentTab()) return;
    } else if (action === "save-family") {
      const name = $("#fam-edit-name-" + id).value.trim();
      if (!name) return toast("请输入家庭名称");
      await api("/families/" + id, { method: "PUT", body: { name } });
      state.editingFamily = null;
      await loadFamilies();
      if (state.familyId === Number(id)) $("#whoami").textContent = "当前：" + familyName(state.familyId);
    } else if (action === "add-family-app") {
      const name = $("#new-family-in-app").value.trim();
      if (!name) return toast("请输入家庭名称");
      await api("/families", { method: "POST", body: { name } });
      clearFields("new-family-in-app");
      await loadFamilies();
    } else if (action === "add-carry") {
      if (!state.familyId) return toast("请先选择你所属的家庭");
      const name = $("#carry-name").value.trim();
      if (!name) return toast("请输入物品名称");
      await api("/carry-items", { method: "POST", body: { name, quantity: $("#carry-qty").value.trim() } });
      clearFields("carry-name", "carry-qty");
    } else if (action === "toggle-carry") {
      await api("/carry-items/" + id, { method: "PUT", body: { status } });
      // 就地更新缓存并重画：新状态与加载态在同一拍到位，不必等末尾整页 render 重新取数。
      // 重画后由 reapplyInflight() 把转圈搬到新按钮上，避免「转圈先断一下、状态过一会才变」。
      const it = (state.carryItems || []).find((x) => Number(x.id) === Number(id));
      if (it) it.status = status;
      if (state.tab === "carry") {
        paintCarry();
        applyReadonly();
        reapplyInflight();
      }
      return; // 不走末尾那次整页 render
    } else if (action === "add-shop") {
      const name = $("#shop-name").value.trim();
      if (!name) return toast("请输入采购项名称");
      await api("/shopping-items", {
        method: "POST",
        body: { name, quantity: $("#shop-qty").value.trim(), unit: $("#shop-unit").value.trim() },
      });
      clearFields("shop-name", "shop-qty", "shop-unit");
} else if (action === "claim-shop") {
      if (!state.familyId) return toast("请先选择你所属的家庭");
      // 接任务 / 取消接任务不发 toast：行内状态（接单家庭标记 + 按钮）本身就是最直接的反馈
      const r = await api("/shopping-items/" + id, { method: "PUT", body: { claim: true } });
      applyClaimLocal(id, true, r.claimed_by); // 就地按服务器返回更新并重画
      refreshCurrentTabSoon();
      return; // 不走末尾那次整页 render，行内状态即刻到位即可
    } else if (action === "unclaim-shop") {
      if (!state.familyId) return toast("请先选择你所属的家庭");
      await api("/shopping-items/" + id, { method: "PUT", body: { claim: false } });
      applyClaimLocal(id, false);
      refreshCurrentTabSoon();
      return;
    } else if (action === "toggle-suggest") {
      // 收起时顺手把焦点移出输入框，免得 focusin 立刻又把它展开
      if (state.purSuggestOpen) {
        setSuggestOpen(false);
        $("#pur-item").blur();
      } else {
        $("#pur-item").focus();
        setSuggestOpen(true);
      }
      return;
    } else if (action === "pick-suggest") {
      $("#pur-item").value = btn.dataset.value || "";
      setSuggestOpen(false);
      $("#pur-item").focus();
      return;
    } else if (action === "add-purchase") {
      const itemName = $("#pur-item").value.trim();
      const amount = Number($("#pur-amount").value);
      if (!state.familyId) return toast("请先选择你所属的家庭");
      if (!itemName) return toast("请从候选里选择你已接单的采购项");
      if (!amount || amount <= 0) return toast("请输入金额");
      // 只能登记到「本家已接单」的清单项上：名称必须来自候选集合，手打的新名称一律不接受
      const shopAll = (await api("/shopping-items")).data || [];
      const matched = shopAll.find((s) => s.name === itemName && Number(s.claimed_family_id) === Number(state.familyId));
      if (!matched) {
        $("#pur-item").value = "";
        setSuggestOpen(false);
        return toast("只能选择你已接单的采购项，先去「采购清单」接任务再回来登记");
      }
      await api("/purchases", {
        method: "POST",
        body: { item_name: itemName, amount, family_id: Number(state.familyId), item_id: matched.id },
      });
clearFields("pur-item", "pur-amount");
    } else if (action === "edit-budget") {
      // 纯前端切换：只重画面板这一块、不重新拉数据，点了立刻出现输入框
      state.editingBudget = true;
      if (renderBudgetPanel({ focusInput: true })) return;
    } else if (action === "cancel-budget") {
      // 同理：只是收起输入框，立即生效
      state.editingBudget = false;
      if (renderBudgetPanel()) return;
    } else if (action === "save-budget") {
      const raw = $("#budget-input").value.trim();
      const val = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(val) || val < 0) return toast("请输入不小于 0 的预算金额");
      const ok = await withAdmin(
        val > 0 ? `将项目预算设为 ${money(val)}` : "取消预算设置（预算改为「无」）",
        async (pw) => {
          await api("/projects/" + state.projectId, { method: "PUT", body: { budget: val }, withProject: false, adminPw: pw });
        }
      );
      if (!ok) return; // 取消操作：保持编辑态，输入内容不丢
      state.editingBudget = false;
      // 预算已写成功：项目中心卡片里的数字下次进入时再刷新即可，
      // 不把 loadProjects 的失败暴露成「预算保存失败」。
      loadProjects().catch(() => {});
      toast(val > 0 ? "预算已更新为 " + money(val) : "已取消预算设置");
    } else if (action === "edit-bonus") {
      // 同预算：纯前端切换编辑态，点了立刻出现输入框
      state.editingBonus = true;
      if (renderBonusPanel({ focusInput: true })) return;
    } else if (action === "cancel-bonus") {
      state.editingBonus = false;
      if (renderBonusPanel()) return;
    } else if (action === "save-bonus") {
      const raw = $("#bonus-input").value.trim();
      const val = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(val) || val < 0) return toast("请输入不小于 0 的奖金金额");
      const count = Number(state.settlement && state.settlement.family_count) || 0;
      const ok = await withAdmin(
        val > 0
          ? `将任务奖金设为 ${money(val)}${count ? `（由 ${count} 家均摊出资，按完成数分配）` : ""}`
          : "取消任务奖金设置（奖金改为「无」）",
        async (pw) => {
          await api("/projects/" + state.projectId, { method: "PUT", body: { bonus: val }, withProject: false, adminPw: pw });
        }
      );
      if (!ok) return; // 取消操作：保持编辑态，输入内容不丢
      state.editingBonus = false;
      toast(val > 0 ? "任务奖金已更新为 " + money(val) : "已取消任务奖金");
    }
    await render();
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(btn, false);
  }
});

// ---------- 项目中心事件委托 ----------
$("#homeView").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.busy === "1") return; // 正在处理中，忽略重复点击
  const { action, id, name, status } = btn.dataset;
  const busyLabel = BUSY_ACTIONS[action];
  if (busyLabel) setBusy(btn, true, busyLabel);
  try {
    if (action === "new-project") {
      openNewProj();
      return;
    }
if (action === "del-project") {
      // 点「删除」直接弹管理权限密码，不再走行内「确认删除 / 取消」
      const target = state.projects.find((x) => x.id === Number(id));
      const label = target ? target.name : "该项目";
      const ok = await withAdmin(`删除项目「${label}」及其全部数据`, async (pw) => {
        await api("/projects/" + id, { method: "DELETE", withProject: false, adminPw: pw });
      });
      if (!ok) return renderProjects(); // 取消：数据无变化，重绘即可
      if (Number(id) === state.projectId) {
        state.projectId = null;
        state.projectName = "团建管理";
        state.projectStatus = "";
        localStorage.removeItem("tb_project");
      }
      await loadProjects();
      renderProjects();
      toast("项目已删除");
      return;
    }
    if (action === "open-project") {
      await enterProject(Number(id), name);
      return;
    }
    if (action === "toggle-project") {
      const target = state.projects.find((x) => x.id === Number(id));
      const label = target ? target.name : "该项目";
      // 「结束项目」与「重启已结束的项目」都属于高风险操作，都要先过管理权限密码
      const isRestart = status === "进行中";
      const ok = await withAdmin(
        isRestart ? `重启已结束的项目「${label}」` : `结束项目「${label}」（结束后项目内只读，需用本口令的管理员密码才能重启）`,
        async (pw) => {
          await api("/projects/" + id, { method: "PUT", body: { status }, withProject: false, adminPw: pw });
        }
      );
      if (!ok) return;
      toast(isRestart ? "项目已重启，可以继续编辑了" : "项目已结束，现在只能查看");
      await loadProjects();
      return renderProjects();
    }
    if (action === "edit-project") {
      state.editingProject = Number(id);
      return renderProjects();
    }
    if (action === "cancel-project-edit") {
      state.editingProject = null;
      return renderProjects();
    }
if (action === "save-project") {
      const newName = $("#proj-edit-name-" + id).value.trim();
      if (!newName) return toast("请输入项目名称");
      const target = state.projects.find((x) => x.id === Number(id));
      const oldName = target ? target.name : "该项目";
      // 原名保存：没有任何变化，不该让用户再走一遍管理口令。直接退出编辑态并提示。
      if (target && newName === target.name) {
        state.editingProject = null;
        renderProjects();
        return toast("项目名称没有改动");
      }
      // 同名检查：已有别的项目用了这个名字就提示换一个，避免列表里出现两张分不清的卡片
      // （忽略大小写与首尾空格，纯大小写差异同样会让人混淆）
      const lower = newName.toLowerCase();
      const dup = state.projects.find(
        (x) => x.id !== Number(id) && String(x.name || "").trim().toLowerCase() === lower
      );
      if (dup) return toast(`已存在同名项目「${dup.name}」，请换一个名称`);
      // 项目改名需要管理权限密码
      const ok = await withAdmin(`把项目「${oldName}」改名为「${newName}」`, async (pw) => {
        await api("/projects/" + id, { method: "PUT", body: { name: newName }, withProject: false, adminPw: pw });
      });
      if (!ok) return; // 取消：保持改名编辑态，输入内容不丢
      state.editingProject = null;
      await loadProjects();
      renderProjects();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    setBusy(btn, false);
  }
});

// ---------- 顶部 / 表单按钮 ----------
$("#loginBtn").addEventListener("click", doLogin);
$("#passcode").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if ($("#loginBtn").dataset.busy === "1") return; // 正在登录，忽略重复回车
  doLogin();
});
$("#addFamRowBtn").addEventListener("click", () => $("#famRows").appendChild(renderFamRow()));
$("#createProjBtn").addEventListener("click", createProject);
$("#cancelProjBtn").addEventListener("click", closeNewProj);
$("#newProjModal").addEventListener("click", (e) => {
  if (e.target === $("#newProjModal")) return closeNewProj(); // 点遮罩关闭
  // 「移除」按钮在这个弹窗里，而 #homeView 的委托收不到弹窗内的点击，故在此单独处理
  const btn = e.target.closest('[data-action="del-fam-row"]');
  if (btn) removeFamRow(btn);
});
$("#logoutBtn").addEventListener("click", logout);
$("#logoutBtn2").addEventListener("click", logout);
$("#backHomeBtn").addEventListener("click", showHome);
$("#homeBtn").addEventListener("click", showHome);
// 「切换家庭」：就地下拉，不再跳到单独的选择界面
$("#switchFamilyBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  const menu = $("#familyMenu");
  if (!menu.classList.contains("hidden")) {
    menu.classList.add("hidden");
    $("#switchFamilyBtn").setAttribute("aria-expanded", "false");
    return;
  }
  // 直接用已缓存的家庭列表（state.families）展开，不再为打开下拉重新请求一次
  renderFamilyMenu();
  menu.classList.remove("hidden");
  $("#switchFamilyBtn").setAttribute("aria-expanded", "true");
  // 默认以按钮左边缘对齐（正好在「切换家庭」文字下方）；窄屏上若右边会超出视口，就把它整体左移一点
  menu.style.marginLeft = "0px";
  const wrapRect = menu.parentElement.getBoundingClientRect();
  const overflow = wrapRect.left + menu.getBoundingClientRect().width - (window.innerWidth - 8);
  if (overflow > 0) menu.style.marginLeft = `-${Math.min(overflow, Math.max(wrapRect.left - 8, 0))}px`;
});

// 点下拉里的家庭即切换（只改本机记录的操作家庭，不写库）
$("#familyMenu").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='pick-family']");
  if (!btn) return;
  state.familyId = Number(btn.dataset.id);
  localStorage.setItem(familyKey(state.projectId), String(state.familyId));
  showApp(); // 重建界面：当前家庭标识与各页数据随之更新
  toast("已切换到 " + familyName(state.familyId));
});

// 点下拉以外的地方收起下拉
document.addEventListener("click", (e) => {
  const menu = $("#familyMenu");
  if (!menu || menu.classList.contains("hidden")) return;
  if (e.target.closest("#familyMenu") || e.target.closest("#switchFamilyBtn")) return;
  menu.classList.add("hidden");
  $("#switchFamilyBtn").setAttribute("aria-expanded", "false");
});

// 管理权限密码弹窗
$("#adminOkBtn").addEventListener("click", submitAdmin);
$("#adminCancelBtn").addEventListener("click", cancelAdmin);
$("#adminPw").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (!$("#adminOkBtn").disabled) submitAdmin();
  } else if (e.key === "Escape") {
    cancelAdmin();
  }
});

// ---------- 口令管理（登录页）----------
// 一个口令对应一份独立的项目数据：登录某口令，项目中心与项目内只呈现该口令名下的项目。
// 列出 / 新增 / 修改 / 删除都需要管理权限密码（走全局的管理密码弹窗校验）；
// 本会话内验证通过后会记住，省去每次操作都重输；不写入 localStorage，退出登录即清除。
let pcAdminPw = "";
let pcRows = [];
let pcEditing = null;
let pcDeleting = null;

function renderPcList() {
  const box = $("#pcList");
  if (!box) return;
  if (!pcRows.length) {
    box.innerHTML = '<div class="empty">还没有任何口令，请先新增一个</div>';
    return;
  }
  box.innerHTML = pcRows
    .map((r) => {
      if (pcEditing === r.id) {
        return `<div class="pc-row">
          <input id="pc-edit-pw-${r.id}" value="${esc(r.passcode)}" placeholder="口令" />
          <input id="pc-edit-adminpw-${r.id}" value="${esc(r.admin_passcode)}" placeholder="管理员密码" />
          <input id="pc-edit-name-${r.id}" value="${esc(r.name)}" placeholder="备注名（可选）" />
          <button class="primary shrink" data-pc-action="save" data-id="${r.id}">保存</button>
          <button class="ghost shrink" data-pc-action="cancel">取消</button>
        </div>`;
      }
      const del =
        pcDeleting === r.id
          ? `<button class="link danger" data-pc-action="confirm-del" data-id="${r.id}">确认删除</button>` +
            `<button class="link" data-pc-action="cancel">取消</button>`
          : `<button class="link danger" data-pc-action="del" data-id="${r.id}">删除</button>`;
      return `<div class="pc-row">
        <div class="pc-fields">
          <span class="pc-label">口令：</span><span class="pc-val pc-pw">${esc(r.passcode)}</span>
          <span class="pc-label">管理员密码：</span><span class="pc-val pc-pw">${esc(r.admin_passcode || "（未设置）")}</span>
          <span class="pc-label">备注名：</span><span class="pc-val">${esc(r.name || "（无备注）")}</span>
          <span class="pc-label">项目数：</span><span class="pc-val">${Number(r.project_count) || 0}</span>
        </div>
        <div class="pc-ops">
          <button class="link" data-pc-action="edit" data-id="${r.id}">修改</button>
          ${del}
        </div>
      </div>`;
    })
    .join("");
  // 本弹窗里的密码输入框同样做软键盘加固（动态生成的编辑框也要）
  box.querySelectorAll('input[type="password"]').forEach(hardenSecret);
}

// 带管理权限密码执行一步口令管理操作：返回 { ok, value }，ok=false 表示用户在弹窗里取消了
async function pcRun(reason, run) {
  if (pcAdminPw) {
    try {
      return { ok: true, value: await run(pcAdminPw) };
    } catch (e) {
      // 记着的密码已失效（例如后台改过）就清掉、回到弹窗重新验证；其它错误直接抛出
      if (/密码不正确/.test(e.message)) pcAdminPw = "";
      else throw e;
    }
  }
  let value;
  const done = await withAdmin(reason, async (pw) => {
    value = await run(pw);
    pcAdminPw = pw;
  }, "超级密码");
  return done ? { ok: true, value } : { ok: false };
}

async function pcRefresh() {
  const r = await pcRun("查看已注册口令需要超级密码", (pw) => api("/passcodes", { withProject: false, adminPw: pw }));
  if (r.ok) {
    pcRows = r.value.data || [];
    pcEditing = null;
    pcDeleting = null;
    renderPcList();
  }
}

async function pcAdd() {
  const passcode = $("#pcNewPasscode").value.trim();
  const name = $("#pcNewName").value.trim();
  const adminPasscode = $("#pcNewAdminPw").value.trim();
  if (!passcode) return ($("#pcMsg").textContent = "请填写新口令");
  if (!adminPasscode) return ($("#pcMsg").textContent = "请为该口令设置管理员密码（同一口令下的项目共用它）");
  const btn = $("#pcAddBtn");
  if (btn.dataset.busy === "1") return;
  setBusy(btn, true, "新增中…");
  try {
    const r = await pcRun("新增口令需要超级密码", (pw) =>
      api("/passcodes", { method: "POST", body: { passcode, name, adminPasscode }, withProject: false, adminPw: pw })
    );
    if (r.ok) {
      $("#pcNewPasscode").value = "";
      $("#pcNewName").value = "";
      $("#pcNewAdminPw").value = "";
      $("#pcMsg").textContent = "";
      await pcRefresh();
      toast("已新增口令");
    }
  } catch (e) {
    $("#pcMsg").textContent = e.message;
  } finally {
    setBusy(btn, false);
  }
}

async function pcSave(id) {
  const passcode = $("#pc-edit-pw-" + id).value.trim();
  const name = $("#pc-edit-name-" + id).value.trim();
  const adminPasscode = $("#pc-edit-adminpw-" + id).value.trim();
  if (!passcode) return ($("#pcMsg").textContent = "口令不能为空");
  if (!adminPasscode) return ($("#pcMsg").textContent = "管理员密码不能为空（同一口令下的项目共用它）");
  try {
    const r = await pcRun("修改口令需要超级密码", (pw) =>
      api("/passcodes/" + id, { method: "PUT", body: { passcode, name, adminPasscode }, withProject: false, adminPw: pw })
    );
    if (r.ok) {
      $("#pcMsg").textContent = "";
      pcEditing = null;
      await pcRefresh();
      toast("已修改口令");
    }
  } catch (e) {
    $("#pcMsg").textContent = e.message;
  }
}

async function pcDelete(id) {
  try {
    const r = await pcRun("删除口令需要超级密码", (pw) =>
      api("/passcodes/" + id, { method: "DELETE", withProject: false, adminPw: pw })
    );
    if (r.ok) {
      $("#pcMsg").textContent = "";
      pcDeleting = null;
      await pcRefresh();
      toast("已删除口令");
    }
  } catch (e) {
    $("#pcMsg").textContent = e.message;
  }
}

function closePcModal() {
  setModalOpen($("#pcModal"), false);
}

if ($("#pcManageToggle")) {
  // 「管理口令」改为弹窗 + 蒙版（与「新建团建项目」同一套交互）：点蒙版或「关闭」都能退出
  $("#pcManageToggle").addEventListener("click", async () => {
    $("#pcMsg").textContent = "";
    pcEditing = null;
    pcDeleting = null;
    renderPcList();
    setModalOpen($("#pcModal"), true);
    try {
      await pcRefresh();
    } catch (e) {
      $("#pcMsg").textContent = e.message;
    }
  });
  $("#pcModal").addEventListener("click", (e) => {
    if (e.target === $("#pcModal")) closePcModal();
  });
  $("#pcCloseBtn").addEventListener("click", closePcModal);
  $("#pcAddBtn").addEventListener("click", pcAdd);
  $("#pcNewName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") pcAdd();
  });
  $("#pcList").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pc-action]");
    if (!btn || btn.dataset.busy === "1") return;
    const action = btn.dataset.pcAction;
    const id = Number(btn.dataset.id) || 0;
    if (action === "edit") {
      pcEditing = id; pcDeleting = null; renderPcList();
    } else if (action === "del") {
      pcDeleting = id; pcEditing = null; renderPcList();
    } else if (action === "cancel") {
      pcEditing = null; pcDeleting = null; renderPcList();
    } else if (action === "save") {
      setBusy(btn, true, "保存中…");
      await pcSave(id);
      setBusy(btn, false);
    } else if (action === "confirm-del") {
      setBusy(btn, true, "删除中…");
      await pcDelete(id);
      setBusy(btn, false);
    }
  });
}

// ---------- 启动 ----------
(async function init() {
  hardenSecretInputs();
  applyTheme(currentTheme(), false); // 主题已由 index.html 头部脚本定好，这里只同步按钮文案
  if (!state.token) return show("loginView");
  try {
    await afterLogin();
  } catch {
    logout();
  }
})();