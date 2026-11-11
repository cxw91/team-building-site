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
// 家庭人数：只允许 0～999 的整数，留空按 0 处理；返回 null 表示填了非法值（由调用方提示）。
// 用 type="text" + inputmode="numeric" 而不是 type="number"，避免浏览器自带的加减箭头把数字挤到边缘。
const parseCountInput = (v) => {
  const s = String(v == null ? "" : v).trim();
  if (!s) return 0;
  if (!/^\d{1,3}$/.test(s)) return null;
  return Number(s) <= 999 ? Number(s) : null;
};

// 几个反复出现的时长集中在这里，避免散落在各处
const REVALIDATE_MS = 1000;        // 页签后台刷新的防抖窗口
const POLL_MS = 30000;             // 版本探针间隔：只问「数据变没变」，不拉业务数据
const POLL_IDLE_MS = 5 * 60 * 1000; // 无交互超过这么久就暂停探针，省 Workers 请求额度
let pollTimer = 0;                 // 探针定时器；声明放前面，show() 在文件更早处就会用到
let pollCursor = 0;                // 已见到的最大日志 id（项目全局版本号，只增不减）
let pollCursorReady = false;       // 是否已建立基线：第一次不该被历史日志误判成「有变化」
let lastActivity = 0;              // 最近一次用户交互时间
let bootstrapReady = false;        // 进入项目时是否已用 ?tab=all 一次取齐七个页签的数据
let useLegacyFetch = false;        // 聚合端点不可用（如前后端版本错配）：后续逐页取数改回原单接口
// 只对「服务器数据」做指纹：UI 态（筛选、编辑、候选框）不参与，
// 否则用户改个筛选条件也会被误判成数据变化而白重画一次。
const POLL_STATE_KEYS = [
  "families", "overview", "settlement", "logsList",
  "carryItems", "shoppingList", "shopItems", "purchases",
];
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

// 概览 / 结算共用的「每家应摊」卡片。
// 口径一律以后端 effective_mode 为准：项目选了「按人数」但所有家庭都是 0 人时，后端会临时
// 退回按家庭数均分（person_fallback），而 split_mode 仍是 person。用它判断展示口径会把
// 「每家」的金额标成「人均」，出现「共 0 人」却算出人均金额这种自相矛盾的展示。
// 数值由 detail 里各家的实际应摊得出：按人数加权时各家差异较大，展示最小～最大区间；
// 按家庭数均分（含 0 人兜底）时展示每家平均值，能直接和结算表对照。
// 括号里只留人数 / 家数 / 兜底原因，不再重复「按人数加权」「含奖金池」这类口径说明：
// 这些信息已由「每家结算」表头的「分摊口径」和表格下方说明承担。
function shareCardHtml(st) {
  const s = st || {};
  const detail = s.detail || [];
  const count = detail.length;
  const people = Number(s.person_count) || 0;
  // effective_mode 由后端返回；旧版本响应缺少该字段时，用可判断的组合条件兜底
  const byPerson = s.effective_mode
    ? s.effective_mode === "person" && !s.person_fallback
    : s.split_mode === "person" && !s.person_fallback && people > 0;
  if (!count) return '<div class="card"><div class="num">—</div><div class="lbl">每家应摊</div></div>';
  const shares = detail.map((d) => Number(d.share) || 0);
  const min = Math.min(...shares);
  const max = Math.max(...shares);
  if (byPerson) {
    const same = Math.abs(max - min) < 0.005;
    const numTxt = same ? money(min) : `${money(min)} ~ ${money(max)}`;
    const title = same ? "每家应摊" : "每家应摊区间";
    return `<div class="card"><div class="num${same ? "" : " range"}">${numTxt}</div><div class="lbl">${title}（共 ${people} 人）</div></div>`;
  }
  const avg = shares.reduce((a, b) => a + b, 0) / count;
  const basis = s.person_fallback ? `暂无人数 · 暂按 ${count} 家均分` : `${count} 家均分`;
  return `<div class="card"><div class="num">${money(avg)}</div><div class="lbl">每家应摊（${basis}）</div></div>`;
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
  pending: null,        // 待确认删除：{ kind, id }
  editingFamily: null,  // 正在编辑的家庭 id（名称 / 人数 / 备注一起改）
  editingShop: null,    // 正在改「数量 / 单位」的采购项 id
  editingCarry: null,   // 正在改数量的携带物品 id
  editingPurchase: null,// 正在改金额的采购记录 id
  purMenuId: null,      // 采购明细里「更多操作」菜单展开在哪一行（只允许同时开一个）
editingProject: null, // 正在改名的项目 id
  editingBudget: false, // 概览里是否正在编辑项目预算
  editingBonus: false, // 概览里是否正在编辑任务奖金
  overview: null,       // 概览接口最近一次的返回，供预算面板局部重画（不重新拉数据）
  projectStatus: "",    // 当前项目状态：进行中 / 已结束
  // 成员页改用 state.families（每家的人数与备注都在家庭上），不再单独缓存逐成员列表
  carryItems: [],       // 携带物品页缓存（同上）
  shoppingList: [],     // 采购清单页缓存（同上）
  purchases: [],        // 采购记录页缓存（同上）
  // 采购清单筛选：只存内存。切页签保持，切项目 / 退出登录 / 刷新页面时复位，
  // 免得带着上一个项目的条件进入新项目却看到空列表。
  shopFilter: { status: "all", claim: "all", family: "all", q: "" },
  shopFamilyOpen: false,// 家庭下拉面板是否展开（切页签回来按此恢复，不播入场动画）
shopItems: [],        // 采购清单里的物品，供「登记一笔采购」的名称候选框使用
  // 采购明细筛选：只有一个「按家庭」条件，约定与采购清单筛选一致（只存内存，切页签保持）
  purFilter: { family: "all" },
  purFamilyOpen: false, // 明细的家庭下拉面板是否展开（重建 DOM 后按此恢复）
  purSuggestOpen: false,// 名称候选框是否展开
  purActive: -1,        // 候选框里键盘高亮到第几项
  settlement: null,     // 结算页缓存（切页签时先画缓存、再后台刷新）
  logsList: [],         // 日志页缓存；概览取数时也会顺带刷新，切到日志页可先画缓存
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

/* ---------- 设置：强调色 + 侧边栏动画 ----------
   两项都是纯前端偏好，只落 html 属性 / class 与 localStorage，不请求后端。
   <head> 里的引导脚本会在样式表加载前先还原，避免刷新时闪一下默认色 / 默认宽边。
   强调色以「一个 RGB 三元组 + 一条渐变」的形式喂给 style.css，整套品牌令牌由 CSS 统一推导；
   第一个色卡 violet 就是改版前一直在用的品牌紫，不做任何覆盖。 */
const ACCENTS = [
  { id: "violet", name: "星云紫", from: "#8b7cff", to: "#5b4be0" },
  { id: "ocean",  name: "海洋蓝", from: "#66a3ff", to: "#2a63c8" },
  { id: "teal",   name: "青碧",   from: "#35d6e6", to: "#0a8fa5" },
  { id: "forest", name: "松绿",   from: "#4fd6a0", to: "#0f8a5c" },
  { id: "amber",  name: "暖橙",   from: "#ffb355", to: "#b7650a" },
  { id: "rose",   name: "玫瑰",   from: "#ff7aa6", to: "#c02a63" },
];
const ACCENT_KEY = "tb_accent";
const SIDE_ANIM_KEY = "tb_sidebar_anim";

function currentAccent() {
  const id = document.documentElement.getAttribute("data-accent");
  return ACCENTS.some((a) => a.id === id) ? id : "violet";
}
function renderAccentGrid() {
  $("#accentGrid").innerHTML = ACCENTS.map(
    (a) =>
      `<button class="accent-swatch" type="button" role="radio" aria-checked="false" tabindex="-1"` +
      ` data-accent="${a.id}" title="${esc(a.name)}" aria-label="${esc(a.name)}"` +
      ` style="--sw-from:${a.from};--sw-to:${a.to}">` +
      `<span class="accent-tile" aria-hidden="true"></span>` +
      `<span class="accent-name">${esc(a.name)}</span>` +
      `</button>`
  ).join("");
}
function paintAccentSelection() {
  const cur = currentAccent();
  $("#accentGrid").querySelectorAll(".accent-swatch").forEach((b) => {
    const on = b.dataset.accent === cur;
    b.setAttribute("aria-checked", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  const hit = ACCENTS.find((a) => a.id === cur);
  $("#accentName").textContent = hit ? hit.name : "默认";
}
function applyAccent(id) {
  const next = ACCENTS.some((a) => a.id === id) ? id : "violet";
  document.documentElement.setAttribute("data-accent", next);
  try { localStorage.setItem(ACCENT_KEY, next); } catch (e) {}
  paintAccentSelection();
}
function openSettings() {
  paintAccentSelection();
  $("#sideAnimToggle").checked = document.documentElement.classList.contains("side-auto");
  setModalOpen($("#settingsModal"), true);
}
function closeSettings() {
  setModalOpen($("#settingsModal"), false);
}

renderAccentGrid();
paintAccentSelection();
$("#accentGrid").addEventListener("click", (e) => {
  const btn = e.target.closest(".accent-swatch");
  if (btn) applyAccent(btn.dataset.accent);
});
// 色卡是 radiogroup：左右 / 上下方向键在色卡间移动并即时生效
$("#accentGrid").addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const list = [...$("#accentGrid").querySelectorAll(".accent-swatch")];
  const i = list.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
  const next = list[(i + step + list.length) % list.length];
  next.focus();
  applyAccent(next.dataset.accent);
});
$("#sideAnimToggle").addEventListener("change", (e) => {
  const on = e.currentTarget.checked;
  // 侧栏交互脚本在 index.html 末尾，页面加载完成后它一定已经挂好；留个兜底防时序意外
  if (typeof window.setSideAnim === "function") window.setSideAnim(on);
  else {
    document.documentElement.classList.toggle("side-auto", on);
    try { localStorage.setItem(SIDE_ANIM_KEY, on ? "1" : "0"); } catch (err) {}
  }
});
$("#settingsCloseBtn").addEventListener("click", closeSettings);
$("#settingsModal").addEventListener("click", (e) => {
  if (e.target === $("#settingsModal")) closeSettings(); // 点遮罩关闭
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#settingsModal").classList.contains("hidden")) closeSettings();
});

// ---------- 接口封装 ----------
async function api(path, { method = "GET", body, withProject = true, adminPw, signal, timeoutMs } = {}) {
  const headers = { "content-type": "application/json" };
  if (state.token) headers["authorization"] = "Bearer " + state.token;
  if (withProject && state.projectId) headers["x-project-id"] = String(state.projectId);
  if (state.familyId) headers["x-family-id"] = String(state.familyId);
  if (adminPw) headers["x-admin-passcode"] = String(adminPw);
  // 读请求默认 10s 超时，避免弱网下无限挂起、界面永远停在骨架屏；
  // 写请求默认不超时：超时后用户重试可能造成重复提交，宁可交给按钮 loading 态盯着。
  // 例外：四类删除的 DELETE 由 performDelete() 显式传 15s（DELETE_TIMEOUT_MS）——
  // 它的确认弹窗是阻塞式的，请求彻底挂起时会永远转圈。
  // signal 来自整页渲染的「代次」：切页签时会 abort 掉上一轮还在飞的请求。
  const limit = timeoutMs === undefined ? (method === "GET" ? 10000 : 0) : timeoutMs;
  const ctrl = new AbortController();
  const timer = limit > 0 ? setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), limit) : 0;
  const relay = signal ? () => ctrl.abort(signal.reason) : null;
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", relay, { once: true });
  }
  try {
    const res = await fetch("/api" + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data;
    try {
      data = await res.json();
    } catch (e) {
      if (ctrl.signal.aborted) throw e; // 取消 / 超时不当成「空响应」吞掉
      data = {};
    }
    if (res.status === 401) {
      logout();
      throw new Error("口令失效，请重新登录");
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || "请求失败");
    return data;
  } catch (e) {
    if (ctrl.signal.aborted) {
      if (signal && signal.aborted) throw new DOMException("请求已取消", "AbortError");
      const timeoutErr = new Error("网络较慢，请求超时，请重试");
      timeoutErr.timedOut = true; // 供调用方区分「超时」与普通失败：删除超时后不能引导重试
      throw timeoutErr;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && relay) signal.removeEventListener("abort", relay);
  }
}

// ---------- 聚合取数 ----------
// 后端 /api/page-data 一次返回一个页签所需的全部数据，并附带 version（项目当前最大日志 id）。
// 所有页签的取数 / 刷新 / 重建统一走这里：原来概览 4 个 GET、采购记录 3 个 GET 现在都是 1 个。
// version 与 pollVersion() 的游标口径一致，取到即可推进游标，不必再单独发一次探针。
function bumpCursor(version) {
  const v = Number(version);
  if (!Number.isFinite(v)) return;
  if (v > pollCursor) pollCursor = v;
  pollCursorReady = true;
}

function applyPageData(d) {
  if (!d || typeof d !== "object") return;
  if (d.project) {
    state.projectName = d.project.name || state.projectName;
    state.projectStatus = d.project.status || "";
  }
  if (Array.isArray(d.families)) state.families = d.families;
  if (d.overview !== undefined) state.overview = d.overview || {};
  if (d.settlement !== undefined) state.settlement = d.settlement || {};
  if (Array.isArray(d.logs)) state.logsList = d.logs;
  if (Array.isArray(d["carry-items"])) state.carryItems = d["carry-items"];
  // 采购清单与「登记采购」的名称候选共用同一批数据，两个缓存一起更新
  if (Array.isArray(d["shopping-items"])) {
    state.shoppingList = d["shopping-items"];
    state.shopItems = d["shopping-items"];
  }
  if (Array.isArray(d.purchases)) state.purchases = d.purchases;
}

// 聚合端点不可用时的逐页回退：数据集名 → 原单接口路径，与后端 PAGE_DATASETS 一一对应。
// 刻意不带 version：游标不推进，30 秒探针照常发现变化（旧后端同样有 /api/logs?since=...）。
const LEGACY_DATASETS = {
  overview: [["overview", "/overview"], ["settlement", "/settlement"], ["shopping-items", "/shopping-items"]],
  members: [["families", "/families"]],
  carry: [["carry-items", "/carry-items"]],
  shopping: [["shopping-items", "/shopping-items"]],
  purchases: [["purchases", "/purchases"], ["shopping-items", "/shopping-items"], ["overview", "/overview"]],
  settlement: [["settlement", "/settlement"]],
  logs: [["logs", "/logs?since=0"]],
};

async function loadPageData(tab, signal) {
  let r;
  if (useLegacyFetch) {
    const pairs = LEGACY_DATASETS[tab] || [];
    const res = await Promise.all(pairs.map(([, path]) => api(path, { signal })));
    const data = {};
    pairs.forEach(([name], i) => { data[name] = res[i] && res[i].data; });
    r = { data };
  } else {
    r = await api("/page-data?tab=" + encodeURIComponent(tab), { signal });
  }
  applyPageData(r && r.data);
  bumpCursor(r && r.version);
  return r;
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
  "save-family": "保存中…",
  "settle-mode": "切换中…",
  "add-family-app": "新增中…",
  "add-carry": "添加中…",
  "toggle-carry": "保存中…",
  "save-carry-edit": "保存中…",
  "add-shop": "添加中…",
  "save-shop-edit": "保存中…",
  "save-purchase-amount": "保存中…",
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
// 删除确认弹窗的「确定 → 删除 + 界面重绘」加载态。它是全局 UI 状态：
// 期间禁止关闭弹窗，版本探针也暂停（pollingAllowed() 会读它），所以提前声明避免 TDZ。
let confirmBusy = false;
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
// 例外：下层是登录页的「管理口令」弹窗时，取消会连它一起关掉，直接回到输入口令界面。
function askAdmin(reason, errText = "", hint = "") {
  return new Promise((resolve) => {
    const modal = $("#adminModal");
    // 密码输错重试时会再次进入 askAdmin。此时 openModal 仍是 adminModal，
    // 不能再把它自己当作「下面的弹窗」——否则会把第一次记下的 _prev 覆盖掉，
    // 取消时就无法还原被压在下面的表单。
    if (!modal._prev && openModal && openModal !== modal) modal._prev = openModal;
    $("#adminReason").textContent = reason;
    $("#adminHint").textContent = hint || "管理员密码";
    $("#adminMsg").textContent = errText;
    $("#adminPw").value = "";
    $("#adminPw").disabled = false;
    $("#adminCancelBtn").disabled = false;
    setModalOpen(modal, true);
    modal._resolve = resolve;
    setTimeout(() => $("#adminPw").focus(), 30);
  });
}

// 关闭弹窗并恢复正常态：取消、请求成功、请求出错都会走这里。
// cancelled=true 表示用户在「需要管理权限」里主动放弃（点取消或在密码框按 Esc）。
// 若下层是登录页的「管理口令」弹窗，取消就等于放弃整个管理口令流程：不再还原它，
// 让它保持隐藏，页面直接回到输入口令的登录界面。
// 验证成功 / 请求出错仍会还原；项目内其它叠层弹窗（新建项目表单等）也照旧还原。
function hideAdmin(cancelled = false) {
  const modal = $("#adminModal");
  const prev = modal._prev || null;
  modal._prev = null;
  modal._resolve = null;
  setModalOpen(modal, false);
  const dropPrev = cancelled && prev && prev.id === "pcModal";
  if (prev && !dropPrev) setModalOpen(prev, true); // 还原被压在下面的弹窗
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
  hideAdmin(true); // 放弃管理权限验证：下层若是「管理口令」弹窗，连它一起关掉回到登录页
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

// 删除按钮：点击后弹确认框（Alert Dialog），不再行内二次确认
function isPending(kind, id) {
  return state.pending && state.pending.kind === kind && Number(state.pending.id) === Number(id);
}
// 统一带 .danger：行内「删除」和其它地方（项目卡片 / 日志 / 口令）一样用危险色，
// 不再混在「修改」的品牌紫里。禁用态另加 .del-off，由 CSS 压成中性灰，别和红色可点态混淆。
function dangerCell(kind, id, actionName, label = "删除") {
  return `<button class="link danger" data-action="${actionName}" data-kind="${kind}" data-id="${id}">${label}</button>`;
}

// ---------- 视图切换 ----------
function show(view) {
  ["loginView", "homeView", "pickView", "appView"].forEach((id) => $("#" + id).classList.toggle("hidden", id !== view));
  // 轮询只在项目内主界面跑。所有视图切换都经过这里，一处启停即可覆盖
  // 进入项目、返回项目中心、选择家庭、退出登录等全部入口，不用各处补 stop。
  if (view === "appView") startPolling();
  else stopPolling();
  // 星座连线仅用于口令登入页；其余页面清空画布、还原为原极光背景
  if (constellationCtl) {
    if (view === "loginView") constellationCtl.start();
    else constellationCtl.stop();
  }
}

// 本地已有 token 且**没有上次项目**时，启动时先跑一段串行的接口请求才切到项目中心。
// 直接用口令卡片当等待页，用户会以为「没登录成功」并可能重复输入。这里在恢复期间把口令
// 卡片换掉（CSS 里是 display:none，键盘与读屏都碰不到），只留一张不可交互的加载卡片；
// 恢复结束或失败后必须复位，否则下次退出登录回到登录页时 .auth 还是隐藏的。
// （有上次项目的刷新恢复不走这里：init() 直接进项目内铺骨架屏，见文件末尾。）
function setSessionRestoring(on) {
  const view = $("#loginView"), box = $("#sessionLoading");
  if (!view || !box) return;
  view.classList.toggle("restoring", !!on);
  box.hidden = !on;
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
  abortAllLoads(); // 退出：作废所有在途取数，别让旧项目的响应回来污染登录态
  state.token = "";
  state.projectId = null;
  state.projectName = "";
  state.projectStatus = "";
  state.familyId = null;
  localStorage.removeItem("tb_token");
  localStorage.removeItem("tb_project");
  state.pending = null;
  state.editingFamily = null;
  state.editingProject = null;
  state.editingShop = null;
  state.editingCarry = null;
  state.editingPurchase = null;
  state.purMenuId = null;
  resetTabCache();
  pcAdminPw = ""; // 退出后不再保留管理权限密码：登录页的口令管理需重新验证
  pcRows = [];
  pcEditing = null;
  pcDeleting = null;
  closePcModal(); // 退出时若口令管理弹窗开着，一并关掉
  setSessionRestoring(false); // 若正处于会话恢复中失败，回到登录页必须还原口令卡片
  show("loginView");
}

// ---------- 项目中心 ----------
// 同一个口令（租户）下项目名不能重复：去掉首尾空格 + 忽略英文大小写，
// 规则与后端 findProjectNameConflict() 保持一致。前端拿当前项目列表做即时预检，
// 让用户在弹管理员密码之前就知道重名；多端 / 并发下的冲突仍以后端 409 为准。
// excludeId 用于改名：排除自己，否则「原名保存」会被自己误判。
function projectNameConflict(name, excludeId = null) {
  const key = String(name || "").trim().toLowerCase();
  return (
    (state.projects || []).find(
      (p) => Number(p.id) !== Number(excludeId) && String(p.name || "").trim().toLowerCase() === key
    ) || null
  );
}
function projectNameConflictMsg(dup) {
  return `该口令下已存在同名项目「${dup.name}」，请换一个名称`;
}

// 家庭名唯一性：只在「当前项目内」生效，不同项目之间互不影响；
// 规则与后端 findFamilyNameConflict() 一致（去空格 + 忽略英文大小写），改名时排除自己。
// 前端先用缓存家庭列表即时预检，多端 / 并发下的冲突仍以后端 409 为准。
function familyNameConflict(name, list = state.families, excludeId = null) {
  const key = String(name || "").trim().toLowerCase();
  return (
    (list || []).find(
      (f) => Number(f.id) !== Number(excludeId) && String(f.name || "").trim().toLowerCase() === key
    ) || null
  );
}
function familyNameConflictMsg(dup) {
  return `家庭名重复`;
}
// 携带物品名只在「自己家庭内」唯一（别家带同名物品不算冲突）。
// 规则与后端一致：去空格 + 忽略英文大小写；前端用缓存即时预检，并发以后端 409 为准。
function carryNameConflict(name) {
  const mine = Number(state.familyId);
  if (!mine) return null;
  const key = String(name || "").trim().toLowerCase();
  return (
    (state.carryItems || []).find(
      (i) => Number(i.family_id) === mine && String(i.name || "").trim().toLowerCase() === key
    ) || null
  );
}
function carryNameConflictMsg(dup) {
  return `物品名重复`;
}
// 新建项目弹窗里一次填多行：这些家庭还没入库，行与行之间也要互不相同
function duplicateFamilyNameInRows(rows) {
  const seen = new Set();
  for (const f of rows) {
    const key = String(f.name || "").trim().toLowerCase();
    if (seen.has(key)) return f;
    seen.add(key);
  }
  return null;
}

async function loadProjects() {
  state.projects = (await api("/projects", { withProject: false })).data || [];
  state.projectsAt = Date.now();
}

function renderFamRow() {
  const div = document.createElement("div");
  div.className = "fam-row";
  div.innerHTML =
    `<input class="fam-name" placeholder="家庭 / 小组名称" autocomplete="off" />` +
    `<input class="fam-count" placeholder="人数（可留空）" aria-label="家庭人数（可留空）" inputmode="numeric" autocomplete="off" />` +
    `<input class="fam-note" placeholder="备注：忌口 / 过敏（可选）" autocomplete="off" />` +
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
          <input id="proj-edit-name-${p.id}" value="${esc(p.name)}" autocomplete="off" />
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
  // 先在弹管理员密码之前用本地项目列表拦一次重名；列表过期 / 别的设备刚建的同名，
  // 由后端 409 兜底，错误信息会落到下面的 catch 写进 #homeMsg。
  const dup = projectNameConflict(name);
  if (dup) return ($("#homeMsg").textContent = projectNameConflictMsg(dup));
  const note = $("#projNote").value.trim();
  // 每行是「家庭名称 + 人数 + 一条备注」；人数留空按 0 处理，非法值当场拦下。
  const families = [];
  for (const row of $("#famRows").querySelectorAll(".fam-row")) {
    const name = row.querySelector(".fam-name").value.trim();
    if (!name) continue;
    const count = parseCountInput(row.querySelector(".fam-count").value);
    if (count === null) return ($("#homeMsg").textContent = "家庭人数必须是 0～999 的整数");
    families.push({ name, member_count: count, note: row.querySelector(".fam-note").value.trim() });
  }
  // 弹窗内几行家庭名不能互相重复：在弹管理员密码之前就提示，避免白输一次密码
  const famDup = duplicateFamilyNameInRows(families);
  if (famDup) return ($("#homeMsg").textContent = `家庭名称「${famDup.name}」重复了，请合并或修改其中一行`);
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
    // 创建成功后停留在「我的项目」，由用户手动点「进入」再走 enterProject 全流程：
    // 不写 tb_project、不切 state.projectId，也不预热新项目的页签缓存。
    renderProjects(); // 原来靠 enterProject 切走再回来触发重绘，停留时必须显式重画列表
    toast(`项目已创建：${res.family_count} 个家庭、${res.member_count} 位成员，点「进入」打开`);
  } catch (e) {
    $("#homeMsg").textContent = e.message;
  } finally {
    setBusy(btn, false);
  }
}

// 切换项目 / 退出登录时清空所有页签缓存，避免把上一个项目的数据画到新项目上
function resetTabCache() {
  // 版本游标是项目级的：换项目后旧项目的日志 id 可能更大，不归零就永远探不到新变化
  resetPollingCursor();
  bootstrapReady = false;
  useLegacyFetch = false;     // 每次进项目重新试一次聚合接口，别把上次的降级结论带过来
  state.tabReady = {};
  state.tabAt = {};
  state.revalidating = {};
  state.overview = null;
  state.settlement = null;
  state.logsList = [];
  state.carryItems = [];
  state.shoppingList = [];
  state.purchases = [];
  state.shopItems = [];
  resetShopFilter();
  resetPurFilter();
}

async function enterProject(id, name) {
  // 换项目 / 自动恢复会话：先停掉上一个项目还在飞的预热与后台刷新。
  // 否则旧项目的响应可能在新项目已经 resetTabCache() 之后写回 state，串数据。
  abortAllLoads();
  state.projectId = Number(id);
  state.projectName = name || (state.projects.find((p) => p.id === state.projectId) || {}).name || "团建管理";
  localStorage.setItem("tb_project", String(state.projectId));
  state.pending = null;
  state.editingFamily = null;
  state.editingBudget = false;
  state.editingShop = null;
  state.editingCarry = null;
  state.editingPurchase = null;
  state.purMenuId = null;
  resetTabCache(); // 换项目：清掉上一个项目的页签缓存
  state.projectStatus = (state.projects.find((p) => p.id === state.projectId) || {}).status || "";
  // 「进入项目」立刻给反馈：先切到项目内视图并铺骨架屏，再等下面的 tab=all 聚合取数。
  // 弱网下最慢的就是这段等待；以前要等它跑完 showApp() 才创建骨架屏，用户全程盯着项目中心。
  // 先清掉上一个项目的家庭，否则骨架屏期间顶栏会短暂显示旧家庭名 / 旧家庭下拉。
  state.familyId = null;
  state.families = [];
  show("appView");
  renderChrome();
  showSkeleton();
  // 一次请求取齐项目信息与七个页签的数据：替代原来的「项目详情 + 家庭」两请求、
  // 首屏 render() 的当前页签取数，以及对其余页签的批量预热（约 14 个请求）。
  // tab=all 成了单点，失败时先重试一次（多数是偶发超时）；两次都失败通常是聚合端点不可用
  //（例如前后端版本错配），此时只取最小数据保证还能进项目，后续逐页取数回退到原单接口。
  let bootstrapped = false;
  for (let attempt = 0; attempt < 2 && !bootstrapped; attempt++) {
    try {
      // 第二次缩短超时：连续失败时别让用户等两个 10 秒才看到降级结果
      const r = await api("/page-data?tab=all", attempt ? { timeoutMs: 4000 } : {});
      applyPageData(r && r.data);
      bumpCursor(r && r.version);
      bootstrapped = true;
    } catch {}
  }
  if (bootstrapped) {
    const now = Date.now();
    TABS.forEach((t) => {
      state.tabReady[t.key] = true;
      state.tabAt[t.key] = now;
    });
    bootstrapReady = true;
    useLegacyFetch = false;
  } else {
    // 降级：只取项目详情与家庭列表（选择家庭界面与首屏必需），其余页签交给 render() 逐页拉。
    // 不标记任何 tabReady，showApp() 会走正常 render()，由 fetcher 用单接口把当前页签补齐。
    useLegacyFetch = true;
    bootstrapReady = false;
    try {
      const [detail] = await Promise.all([
        api("/projects/" + state.projectId, { withProject: false }).catch(() => null),
        loadFamilies().catch(() => {}),
      ]);
      const d = detail && detail.data;
      if (d && d.project) {
        state.projectName = d.project.name || state.projectName;
        state.projectStatus = d.project.status || "";
      }
    } catch {}
    toast("数据加载失败，已切换为逐页加载");
  }
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
async function loadFamilies(signal) {
  state.families = (await api("/families", { signal })).data || [];
}
function familyName(id) {
  const f = state.families.find((x) => x.id === id);
  return f ? f.name : "未分配";
}
// 侧栏头部「双色标签条」右侧的家庭名：纯展示（无点击交互），切家庭 / 改家庭名后同步文本与无障碍标签
function setWhoami(name) {
  const el = $("#whoami");
  if (!el) return;
  const label = name || "未分配";
  el.textContent = label;
  el.setAttribute("title", "当前家庭：" + label);
  el.setAttribute("aria-label", "当前家庭：" + label);
}
// 采购清单「接单家庭」：已认领 → 显示哪家接的（浅色副信息行里的蓝色标记，
// 与未认领的橙色「接任务」按钮形成颜色区分）；未认领 → 不显示
function claimInfo(i) {
  return i.claimed_family_id
    ? `<span class="tag claim">${esc(i.claimed_family_name || "已认领")} 接单</span>`
    : "";
}
// 采购清单「接任务 / 取消任务」控件：未认领 → 可接；已认领 → 只有接单家庭能取消。
// 已购的项不给「取消接任务」：要回到「未接单 + 待购」只能删掉对应的采购记录（后端同样会拦）。
function claimAction(i) {
  if (i.status === "已购") return "";
  if (i.claimed_family_id) {
    const mine = Number(i.claimed_family_id) === Number(state.familyId);
    return mine ? `<button class="pill claim-cancel" data-action="unclaim-shop" data-id="${i.id}">取消任务</button>` : "";
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
  const menu = $("#topMenuFamilyList");
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
  setWhoami(familyName(state.familyId));
  renderFamilyMenu();
  closeTopMenu(); // 界面重建时先收起下拉，同时复位汉堡按钮的 aria-expanded
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
  // 页签整体重建；高亮滑块（.nav-glider）保持同一个节点不动。
  // 文字包进 .tab-label：收起态要整块隐藏；title / aria-label 让纯图标条仍可辨认。
  nav.querySelectorAll(".tab").forEach((btn) => btn.remove());
  nav.insertAdjacentHTML(
    "beforeend",
    TABS.map((t) => {
      const on = t.key === state.tab;
      return (
        `<button class="tab${on ? " active" : ""}" data-tab="${t.key}"` +
        ` title="${esc(t.label)}" aria-label="${esc(t.label)}"${on ? ' aria-current="page"' : ""}>` +
        `<span class="tab-label">${esc(t.label)}</span>` +
        "</button>"
      );
    }).join("")
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
  // 离开采购记录页时把名称候选框收起，免得把「正开着」的状态带到下次切回来
  if (tab !== "purchases") state.purSuggestOpen = false;
  // 行内编辑态也不跨页签：切走就当放弃修改，回来是干净的列表
  if (tab !== "shopping") state.editingShop = null;
  if (tab !== "carry") state.editingCarry = null;
  if (tab !== "purchases") state.editingPurchase = null;
  if (tab !== "purchases") state.purMenuId = null;
  renderChrome();
  abortLoads(); // 切页签：上一页签还在飞的请求立即作废
  if (paintTab(tab)) revalidate(tab);
  else {
    showSkeleton(); // 没缓存时先把反馈给出来，再慢慢取数
    render();
  }
}

function showApp() {
  show("appView");
  renderChrome();
  // enterProject() 在发请求之前已经铺过骨架屏，这里重复调用是幂等的（见 showSkeleton）；
  // 从「选择家庭」页进来、或项目中心还没铺过时才真正新建。
  showSkeleton();
  // bootstrap 已把七个页签的数据取齐时只重画、不发请求；后续刷新仍由切页签 / 主动操作 /
  // 切回前台 / 30 秒版本探针驱动。探针由 show("appView") 统一启动，这里不用再管。
  render({ skipFetch: bootstrapReady }).catch(() => {});
}

// ---------- 版本探针：只在数据真的变了才拉业务接口 ----------
// 切页签 / 自己操作 / 切回前台都会刷新；停在一个页签看时，靠一个廉价心跳跟上别人的改动。
// 后端所有写操作都 addLog，logs.id 是 AUTOINCREMENT（单调递增、删日志也不复用），
// 所以「有没有 id 大于已见最大值的日志」=「项目数据有没有变」。
// 心跳只发 1 个走主键索引、最多返回 1 行的 GET；有变化才 revalidate 当前页签。
// 原来是每 10 秒无条件拉当前页签全量（概览 4 个 GET、采购记录 3 个），
// Workers Free 只有 10 万请求/天，几个人把页面开着就能打满。
async function pollVersion() {
  const r = await api("/logs?since=" + pollCursor + "&limit=1", { signal: bgSignal() });
  const rows = (r && r.data) || [];
  const maxId = rows.reduce((m, x) => Math.max(m, Number(x.id) || 0), pollCursor);
  // 首次只建立基线：项目本来就有历史日志，不该因此白拉一次全量
  const changed = pollCursorReady && rows.length > 0;
  pollCursor = maxId; // 只增不减：日志被清空后新日志 id 仍然更大，下次照样能检测到
  pollCursorReady = true;
  return changed;
}

function resetPollingCursor() {
  pollCursor = 0;
  pollCursorReady = false;
  markActivity();
}

function markActivity() {
  lastActivity = Date.now();
}

// 用户还在操作就继续探；发呆超过 POLL_IDLE_MS 就停，避免夜间挂着页面空转烧额度。
// 动一下鼠标 / 敲一下键盘 / 切回前台都会重新计时，刷新按钮也能立刻要一次数据。
["pointerdown", "keydown", "wheel", "touchstart"].forEach((ev) => {
  document.addEventListener(ev, markActivity, { passive: true });
});

function dataFingerprint() {
  return JSON.stringify(POLL_STATE_KEYS.map((k) => state[k] ?? null));
}

// 轮询会整体重建 #content，正在填写 / 编辑 / 弹窗期间一律跳过，
// 否则光标位置、输入法组合、行内未提交内容都可能被打断。
function isEditingNow() {
  const s = state;
  if (s.pending || s.editingFamily != null || s.editingProject != null ||
      s.editingShop != null || s.editingCarry != null || s.editingPurchase != null ||
      s.editingBudget || s.editingBonus || s.purMenuId != null ||
      s.purSuggestOpen || s.shopFamilyOpen || s.purFamilyOpen) return true;
  // 没进「编辑态」但正聚焦的输入框也要算：采购记录的名称框、清单搜索框等
  const ae = document.activeElement;
  const c = $("#content");
  if (ae && c && c.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return true;
  return false;
}

function pollingAllowed() {
  if (!state.token) return false;
  if ($("#appView").classList.contains("hidden")) return false;
  if (document.visibilityState !== "visible") return false;
  // 首屏 / 无缓存页签的整页取数还在飞时别轮询，否则两组请求打同一批接口
  if (!state.tabReady[state.tab]) return false;
  if (openModal) return false;      // 管理密码 / 确认删除等弹窗开着
  if (confirmBusy) return false;    // 删除确认弹窗正在等删除 + 重绘，别让探针插进来重画
  if (INFLIGHT.size) return false;  // 有写请求在途，别在提交过程中重画
  if (isEditingNow()) return false;
  if (Date.now() - lastActivity > POLL_IDLE_MS) return false; // 发呆太久就停，省额度
  return true;
}

function startPolling() {
  if (pollTimer) return;
  if ($("#appView").classList.contains("hidden")) return;
  if (document.visibilityState !== "visible") return;
  markActivity(); // 刚进入 / 刚切回来，重新起算活跃窗口
  pollTimer = setInterval(async () => {
    if (!pollingAllowed()) return;
    try {
      const changed = await pollVersion();
      // 探针期间用户可能切了页签或开始输入，再确认一次门槛
      if (!changed || !pollingAllowed()) return;
      revalidate(state.tab, { poll: true }).catch(() => {});
    } catch {
      // 探针失败静默：保留游标与缓存，下一轮再试；不弹 toast 免得变成定时骚扰
    }
  }, POLL_MS);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = 0;
}

// 从别的标签页 / 后台切回时：恢复探针并立刻补一次刷新，不必等下一个 30 秒
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    stopPolling(); // 后台连定时器都不跑，省电也省请求
    return;
  }
  if (!state.token || $("#appView").classList.contains("hidden")) return;
  markActivity();
  startPolling();
  if (pollingAllowed()) revalidate(state.tab);
});

// ---------- 表单状态快照 ----------
// 页签后台刷新会整体重建 #content，重建前先记住每个输入框里的值，重建后原样填回，
// 避免正在填写的内容被刷新清空。

// 「程序性聚焦」：只把焦点放回输入框，不代表用户想展开名称候选面板。
// 慢接口返回后 revalidate/render 会重建 #content，restoreForm 再把焦点填回 #pur-item；
// 若这次 focus 照常触发 focusin 的自动展开，用户刚选完登记项、已经收起的候选面板
// 就会过一会儿自己弹出来一次（线上反馈的正是这个，延迟越长越容易撞上）。
let quietFocus = false;
function focusQuietly(el) {
  if (!el) return;
  const prev = quietFocus;
  quietFocus = true;
  // 个别浏览器把 focus 事件推迟到下一拍才派发：给元素留一个一次性标记兜底，
  // focusin 消费掉即可；setTimeout 只是防止「压根没派发 focus」时标记残留。
  el.dataset.quietFocus = "1";
  try {
    el.focus({ preventScroll: true });
  } finally {
    quietFocus = prev;
    setTimeout(() => { delete el.dataset.quietFocus; }, 0);
  }
}

function snapshotForm() {
  const c = $("#content");
  if (!c) return null;
  const fields = {};
  let n = 0;
  c.querySelectorAll("input, select, textarea").forEach((el) => {
    const key = el.id || el.tagName + "#" + n;
    n++;
    // 筛选控件的值以 state.shopFilter 为唯一来源（重绘时会按 state 重新渲染），
    // 不参与快照：否则切项目复位条件后，旧值会被回填回来，和 state 打架。
    if (el.hasAttribute("data-filter-state")) return;
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
    if (el.hasAttribute("data-filter-state")) return; // 见 snapshotForm：筛选控件只认 state
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
        focusQuietly(el); // 回填焦点 ≠ 用户点开候选框，别让 focusin 顺手把面板展开
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

// ---------- 加载反馈：骨架屏 / 失败重试 ----------
// 整页取数期间先给 #content 一个即时反馈，避免「侧栏高亮切了、内容区毫无动静」。
// aria-busy 让读屏也知道内容还在加载；paintTab 与错误卡片负责清掉它。
// ---------- 加载反馈：骨架屏 / 失败重试 ----------
// 整页取数期间先给 #content 一个即时反馈，避免「侧栏高亮切了、内容区毫无动静」。
// aria-busy 让读屏也知道内容还在加载；paintTab 与错误卡片负责清掉它。
// 每页一套骨架屏：占位与各自真实版面一致（复用 .card / .section 等真实类名），
// 数据回来重画时不跳版。列表类（携带物品 / 采购清单 / 采购记录 / 日志）共用
// skeletonList()；成员、结算各自一套；未知页签兜底回概览。
function showSkeleton(tab = state.tab) {
  const c = $("#content");
  if (!c) return;
  // 已经处于加载态就直接复用，别重建 DOM —— 否则微光动画从头重播，弱网下看着像闪了一下。
  if (c.getAttribute("aria-busy") === "true" && c.querySelector(".loading-skeleton")) return;
  c.setAttribute("aria-busy", "true");
  const builders = {
    overview: skeletonOverview,
    members: skeletonMembers,
    carry: skeletonCarry,
    shopping: skeletonShopping,
    purchases: skeletonPurchases,
    settlement: skeletonSettlement,
    logs: skeletonLogs,
  };
  const build = builders[tab] || skeletonOverview;
  c.innerHTML = `<div class="loading-skeleton" role="status" aria-live="polite">
      <p class="hint sk-hint">正在加载…</p>
      ${build()}
    </div>`;
}

// 概览：7 张 KPI 卡（.cards 网格）+ 3 个面板（预算 / 奖励 / 任务接单）
function skeletonOverview() {
  const skCard = '<div class="card sk-card"><span class="sk sk-num"></span><span class="sk sk-lbl"></span></div>';
  const skPanel = (lines) =>
    `<div class="section sk-panel"><span class="sk sk-line w40"></span>${lines
      .map((w) => `<span class="sk sk-line${w ? " " + w : ""}"></span>`)
      .join("")}</div>`;
  return `<div class="cards">${skCard.repeat(7)}</div>`
    + skPanel(["w80", "", "w60"])
    + skPanel(["w80", "", "w60", "w40"])
    + skPanel(["w80", "", "w60"]);
}

// 携带物品：按家庭分块，每块含标题（家庭名 + 项数）+ 多条物品行 + 自家底部的「添加」输入条
function skeletonCarry() {
  const item = '<div class="sk-row"><span class="sk sk-line"></span><span class="sk sk-line"></span></div>';
  const fam = (withAdd) => `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span><span class="sk sk-line w24"></span></div>
      <div class="sk-rows">${item.repeat(3)}</div>
      ${withAdd
        ? '<div class="sk-formrow"><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span></div>'
        : ""}
    </div>`;
  return fam(true).repeat(2);
}

// 采购清单：单块外壳（标题 + 添加输入条 + 筛选条 + 列表行）
function skeletonShopping() {
  const item = '<div class="sk-row"><span class="sk sk-line"></span><span class="sk sk-line"></span></div>';
  return `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span><span class="sk sk-line w24"></span></div>
      <div class="sk-formrow"><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span></div>
      <div class="sk-filterbar"><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line w40"></span></div>
      <div class="sk-rows">${item.repeat(5)}</div>
    </div>`;
}

// 采购记录：登记表单 + 各家金额汇总（进度条 + 家庭行）+ 采购明细（含筛选条）
function skeletonPurchases() {
  const item = '<div class="sk-row"><span class="sk sk-line"></span><span class="sk sk-line"></span></div>';
  const reg = `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span></div>
      <div class="sk-formrow"><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span></div>
    </div>`;
  const summary = `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span></div>
      <span class="sk sk-line" style="height:10px"></span>
      <div class="sk-rows">${'<div class="sk-row"><span class="sk sk-line"></span><span class="sk sk-line"></span></div>'.repeat(3)}</div>
    </div>`;
  const details = `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span><span class="sk sk-line w24"></span></div>
      <div class="sk-filterbar"><span class="sk sk-line"></span><span class="sk sk-line w40"></span></div>
      <div class="sk-rows">${item.repeat(5)}</div>
    </div>`;
  return reg + summary + details;
}

// 日志：标题栏（共 N 条 + 清除）+ 多条日志条目（时间 + 正文 + 删除），
// 列表包在仿真实 .content > .logs 的卡片里 —— 浅色主题下也有明确卡片边界，不漂浮。
function skeletonLogs() {
  const item = '<div class="sk-log-item"><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span></div>';
  return `<div class="section-head sk-log-head"><span class="sk sk-line w40"></span><span class="sk sk-line w24"></span></div>
    <div class="sk-log-card"><div class="sk-logs">${item.repeat(6)}</div></div>`;
}

// 成员：每个家庭一个区块（标题 + 成员行）+ 底部「新增家庭」区块
function skeletonMembers() {
  const fam = `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span><span class="sk sk-line w24"></span></div>
      <div class="sk-rows">
        <div class="sk-row"><span class="sk sk-line"></span><span class="sk sk-line"></span></div>
        <div class="sk-row"><span class="sk sk-line"></span><span class="sk sk-line"></span></div>
      </div>
    </div>`;
  const add = `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span></div>
      <div class="sk-formrow"><span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span></div>
    </div>`;
  return fam.repeat(2) + add;
}

// 结算：卡片行（总花费 / 任务奖金 / 每家应摊）+ 两张表格（任务奖金 / 每家结算）
function skeletonSettlement() {
  const skCard = '<div class="card sk-card"><span class="sk sk-num"></span><span class="sk sk-lbl"></span></div>';
  const trow = `<div class="sk-trow">${'<span class="sk sk-line"></span>'.repeat(5)}</div>`;
  const table = `<div class="section sk-panel">
      <div class="section-head"><span class="sk sk-line w40"></span></div>
      <div class="sk-table">${trow.repeat(5)}</div>
    </div>`;
  return `<div class="cards">${skCard.repeat(3)}</div>` + table.repeat(2);
}

function showLoadError(msg) {
  const c = $("#content");
  if (!c) return;
  c.removeAttribute("aria-busy");
  // data-readonly-keep：项目已结束只是不能改数据，「重试」这种纯加载辅助按钮仍要能点
  c.innerHTML = `<div class="empty load-error"><p>${esc(msg)}</p><button type="button" class="ghost" data-action="retry-load" data-readonly-keep>重试</button></div>`;
}

// 整页渲染的「代次」：切页签 / 重开渲染时递增并 abort 上一轮请求。
// 旧请求返回后一律丢弃，不再抢占带宽，也不会把旧页内容画回来。
// 两套取消信号分开管：
//   loadCtrl —— 首屏 / 无缓存切页签的整页取数，每切一次页签作废一轮；
//   bgCtrl   —— 后台刷新与页签预热共用，只在换项目 / 退出登录时整体作废。
// 切页签不该掐掉「别的页签还没预热完」的请求，否则预热等于白做。
let renderSeq = 0;
let loadCtrl = null;
let bgCtrl = null;

function bgSignal() {
  if (!bgCtrl || bgCtrl.signal.aborted) bgCtrl = new AbortController();
  return bgCtrl.signal;
}

function abortLoads() {
  renderSeq++;
  if (loadCtrl) {
    loadCtrl.abort();
    loadCtrl = null;
  }
}

function abortAllLoads() {
  abortLoads();
  if (bgCtrl) {
    bgCtrl.abort();
    bgCtrl = null;
  }
}

async function render({ skipFetch = false } = {}) {
  // 进入项目时 bootstrap 已一次取齐七个页签：这里只重画，绝不再发请求。
  // 只有 showApp() 会传 skipFetch；写操作后的 render() 仍走下面的整页取数，保证拿到最新数据。
  if (skipFetch && state.tabReady[state.tab]) {
    const snap = snapshotForm();
    if (paintTab(state.tab)) {
      restoreForm(snap);
      return true;
    }
  }
  // 页面重建是异步的（各页先拉接口、之后再整体赋值 #content）。轮询触发的重建与用户切页签可能交错：
  // 旧页签的重建会在稍后把内容盖回旧页签，于是出现「页签高亮在新页、内容还是旧页」的错位。
  // 现在用代次 + AbortController 直接作废上一轮，再保留最多 3 轮兜底，防止打转。
  const seq = ++renderSeq;
  if (loadCtrl) loadCtrl.abort();
  const ctrl = new AbortController();
  loadCtrl = ctrl;
  try {
    for (let i = 0; i < 3; i++) {
      if (seq !== renderSeq) return; // 已有更新的渲染，本轮作废
      const tab = state.tab;
      const fn = FETCHERS[tab];
      if (!fn) return;
      try {
        await fn(ctrl.signal);
        if (seq !== renderSeq) return;
        state.tabReady[tab] = true;
        state.tabAt[tab] = Date.now();
      } catch (e) {
        if (seq !== renderSeq || (e && e.name === "AbortError")) return; // 主动取消不算错误
        if (state.tab === tab) {
          showLoadError(e.message || "加载失败");
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
        else showLoadError("页面绘制失败，请重试"); // 别把骨架屏永远留在屏幕上
        applyReadonly();
        return;
      }
    }
    // 三轮里页签都在变、没能画出来：至少用缓存把当前页签补画一次，别让内容区空着
    if (FETCHERS[state.tab] && !$("#content").firstChild) paintTab(state.tab);
  } finally {
    // 本轮仍是当前渲染才清掉引用；若已被 abortLoads() 换掉，别误伤新的一轮
    if (loadCtrl === ctrl) loadCtrl = null;
  }
}

// 用缓存把某个页签先画出来（切页签时先画缓存、网络回来再后台刷新）；没有缓存返回 false，交给整页渲染兜底
// 重建期间给 #content 挂 .no-tr 关掉过渡：新节点先按「无状态」样式排版，回填焦点 / 指针坐标 /
// 禁用态后才变成最终样式，这些差异都会按 0.2s 过渡淡入一遍，眼看着就是整块闪一下。
function paintTab(tab) {
  if (!state.tabReady[tab]) return false;
  const paint = PAINTERS[tab];
  if (!paint) return false;
  const keepSuggest = captureSuggestOpen(); // 用户正开着名称候选框时，重画不该把它关掉
  const c = $("#content");
  if (c) {
    c.classList.add("no-tr");
    c.removeAttribute("aria-busy");
  }
  try {
    paint();
    applyReadonly();
    restoreSuggestOpen(keepSuggest);
    reapplyInflight(); // 重画后把在途请求的加载态刷回到新元素上
    return true;
  } catch {
    // 画失败时立刻恢复过渡，别把「无过渡」的状态留在页面上
    if (c) c.classList.remove("no-tr");
    return false;
  } finally {
    // 两帧后再恢复过渡：新节点在本次绘制里就已经是最终样式，恢复时不会有可补间的差异
    if (c) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => c.classList.remove("no-tr"));
      });
    }
  }
}

// 后台刷新某个页签：拿到新数据后只在用户仍停在该页签时重画；失败继续用缓存。
// poll=true 用于「版本探针发现变化 / 后台自动刷新」这类非用户主动的取数：
// 失败静默、数据没变化时不重画，避免频繁打扰；主动刷新（切页签 / 切回前台 / 点刷新）不传。
let lastLoadErrToast = 0;
async function revalidate(tab, { poll = false } = {}) {
  if (!FETCHERS[tab]) return;
  if (state.revalidating[tab]) return; // 同一页签已在刷新，别叠加请求
  if (state.tabAt[tab] && Date.now() - state.tabAt[tab] < REVALIDATE_MS) return; // 刚刷新过，短时间内不再重复请求
  state.revalidating[tab] = true;
  const signal = bgSignal();
  const before = poll ? dataFingerprint() : null;
  try {
    await FETCHERS[tab](signal);
    if (signal.aborted) return; // 期间换了项目 / 退出：旧数据不要再写回 state
    state.tabReady[tab] = true;
    state.tabAt[tab] = Date.now();
    if (state.tab === tab) {
      // 轮询且数据一字未变就别整页重建：不然每 10 秒打断一次阅读、hover 和卡片动画。
      if (before !== null && dataFingerprint() === before) return;
      // 快照放到取数之后：保留用户在这次后台刷新期间刚选好的内容，
      // 避免用「请求开始前」的旧快照把它盖掉。
      const snap = snapshotForm();
      if (paintTab(tab)) restoreForm(snap);
    }
  } catch (e) {
    // 保留已画出的缓存内容。主动刷新（切页签 / 切回前台）给一次轻提示，
    // 别让用户把「刷新失败」当成「卡住不动」；轮询失败则静默，10 秒一次会变成骚扰。
    // 8 秒内只提示一次，避免切页签时连续弹 toast。
    if (!poll && e && e.name !== "AbortError" && Date.now() - lastLoadErrToast > 8000) {
      lastLoadErrToast = Date.now();
      toast("数据刷新失败，当前显示的是缓存内容");
    }
  } finally {
    state.revalidating[tab] = false;
  }
}

// 页签预热不再需要：进入项目时 /api/page-data?tab=all 已一次取齐全部页签数据并标记 ready。

// 项目已结束：整页切成查看模式，禁掉一切编辑入口（后端也会拒）
// 纯查看类控件（采购清单筛选条、空态里的「清除筛选」）带 data-readonly-keep，
// 它们不改数据，只读时应当照常可用。列表局部重绘后也要再跑一次这个函数。
function disableEditControlsIn(root) {
  if (!isReadonly() || !root) return;
  root.querySelectorAll("input, select, textarea, button").forEach((el) => {
    if (el.hasAttribute("data-readonly-keep")) return;
    el.disabled = true;
  });
}
function applyReadonly() {
  const c = $("#content");
  if (!isReadonly()) return;
  disableEditControlsIn(c);
  if (!c.querySelector(".banner")) {
    const b = document.createElement("div");
    b.className = "banner";
    b.setAttribute("role", "status");
    // 锁图标表示只读；引用 index.html 顶部的 sprite。整句包在一个 span 里，
    // 窄屏折行时每一行都按 text-align:center 居中对齐（图标是 inline 的，不占独立一行）
    b.innerHTML =
      '<svg class="banner-ico" aria-hidden="true" focusable="false"><use href="#icon-lock"></use></svg>' +
      '<span class="banner-text">项目已结束<span class="banner-dot">·</span>当前为查看模式，内容不可修改</span>';
    c.prepend(b);
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
               <input id="budget-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="预算金额（元）" value="${hasBudget ? o.budget : ""}" autocomplete="off" />
               <button class="primary shrink" data-action="save-budget">保存</button>
               <button class="ghost shrink" data-action="cancel-budget">取消</button>
             </div>
             <p class="hint" style="margin:8px 0 0">填 0 可取消预算设置；设置 / 修改预算需要管理员密码。</p>`
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
        <input id="bonus-input" type="number" min="0" step="0.01" inputmode="decimal" placeholder="奖金金额（元）" value="${has ? pool : ""}" autocomplete="off" />
        <button class="primary shrink" data-action="save-bonus">保存</button>
        <button class="ghost shrink" data-action="cancel-bonus">取消</button>
      </div>
      <p class="hint" style="margin:8px 0 0">填 0 可取消奖金设置；设置 / 修改任务奖金需要管理员密码。</p>`;
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
    ${rows.map((d) => bonusRowHtml(d, max)).join("")}`;
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
async function fetchOverview(signal) {
  // 概览 + 结算摘要 + 日志缓存 + 接单统计，后端聚合成 1 个 /api/page-data?tab=overview
  return loadPageData("overview", signal);
}

function paintOverview() {
  const o = state.overview;
  const st = state.settlement || {};
  const hasBudget = Number(o.budget) > 0;
  $("#content").innerHTML = `
    <div class="cards">
      <div class="card"><div class="num">${money(o.total_amount)}</div><div class="lbl">总花费</div></div>
      <div class="card"><div class="num">${hasBudget ? money(o.budget) : "无"}</div><div class="lbl">项目预算</div></div>
      ${shareCardHtml(st)}
      <div class="card"><div class="num">${o.family_count}</div><div class="lbl">家庭数</div></div>
      <div class="card"><div class="num">${o.member_count}</div><div class="lbl">总人数</div></div>
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

async function fetchMembers(signal) {
  // 人数与备注都挂在家庭上，成员页直接读 state.families；只需确保家庭列表是最新的。
  return loadPageData("members", signal);
}

// 只重画成员页内容（用 state.families 缓存），供纯前端切换调用。
// 每个家庭是一张卡片：标题 + 「人数 / 备注」一行；自家可编辑名称、人数、备注，其他家庭只读。
// 姓名不再录入也不再展示；历史 members 表里的姓名数据保留在库里，不影响这里的人数口径。
function paintMembers() {
  const mine = state.familyId;
  const groups = state.families
    .map((f) => {
      const count = Math.max(0, Math.floor(Number(f.member_count) || 0));
      const note = String(f.note || "").trim();
      const isMine = Number(f.id) === Number(mine);
      const editing = isMine && state.editingFamily === f.id;
      const head = !isMine
        ? `<div class="section-head">
             <span class="title">${esc(f.name)} <span class="ro-badge">其他家庭 · 只读</span></span>
             <span class="hint">${count} 人</span>
           </div>`
        : editing
          ? `<div class="section-head"><span class="title">编辑家庭</span><span class="hint">名称 / 人数 / 备注</span></div>`
          : `<div class="section-head">
               <span class="title">${esc(f.name)} <span class="mine">（我的家庭）</span></span>
               <span class="hint">${count} 人
                 <button class="link" data-action="edit-family" data-id="${f.id}">修改</button>
                 ${dangerCell("family", f.id, "del-family", "删除家庭")}
               </span>
             </div>`;
      const body = editing
        ? `<div class="form-row fam-edit-row">
             <input id="fam-edit-name-${f.id}" value="${esc(f.name)}" placeholder="家庭 / 小组名称" aria-label="家庭名称" autocomplete="off" />
             <input id="fam-edit-count-${f.id}" value="${count}" placeholder="人数" inputmode="numeric" aria-label="成员人数" style="flex:0 0 92px" autocomplete="off" />
             <input id="fam-edit-note-${f.id}" value="${esc(note)}" placeholder="备注：忌口 / 过敏" aria-label="忌口或过敏备注" autocomplete="off" />
             <button class="primary shrink" data-action="save-family" data-id="${f.id}">保存</button>
             <button class="ghost shrink" data-action="cancel-family-edit">取消</button>
           </div>`
        : `<div class="row fam-info-row">
             <div class="main"><div class="name">成员人数：${count} 人</div>
               <div class="meta">${note ? "忌口 / 过敏：" + esc(note) : "暂无忌口 / 过敏备注"}</div></div>
             ${isMine ? "" : '<span class="tag off">只读</span>'}
           </div>`;
      return `<div class="section${isMine ? "" : " readonly"}">
        ${head}
        ${body}
        ${isMine && !editing ? '<p class="hint" style="margin:8px 0 0">人数会用于「按人数均分」结算口径，请在结算前核对。</p>' : ""}
      </div>`;
    })
    .join("");
  const addFamily = `<div class="section">
    <div class="section-head"><span class="title">新增家庭 / 小组</span></div>
    <div class="form-row">
      <input id="new-family-in-app" placeholder="家庭 / 小组名称" autocomplete="off" />
      <input id="new-family-count" placeholder="人数" inputmode="numeric" aria-label="成员人数" style="flex:0 0 92px" autocomplete="off" />
      <input id="new-family-note" placeholder="备注：忌口 / 过敏（可选）" autocomplete="off" />
      <button class="ghost shrink" data-action="add-family-app">新增家庭</button>
    </div>
  </div>`;
  $("#content").innerHTML =
    (state.families.length ? groups : '<div class="empty">本项目还没有家庭，先新增一个</div>') + addFamily;
}

// ---------- 携带物品 ----------
async function fetchCarry(signal) {
  return loadPageData("carry", signal);
}

// 携带物品单行：只放开「数量」编辑，名称是添加时定的标识、不提供改名；
// 别家的行只显示状态，不给「修改 / 删除」。编辑态复用 .row-edit / .shop-actions 的窄屏排版。
// 物品信息区：名称与数量各自成列，多行之间上下左对齐（列起点由 .carry-line 的 grid 固定）。
// 数量留空也保留「数量：未填」这一列，否则该行少一列会破坏与相邻行的对齐。
function carryInfoHtml(i) {
  const qty = String(i.quantity == null ? "" : i.quantity).trim();
  return `<div class="main carry-info">
    <div class="carry-line">
      <div class="carry-cell carry-name"><span class="carry-label">物品名字：</span><span class="carry-val">${esc(i.name)}</span></div>
      <div class="carry-cell carry-qty${qty ? "" : " is-empty"}"><span class="carry-label">数量：</span><span class="carry-val">${qty ? esc(qty) : "未填"}</span></div>
    </div>
    ${i.note ? `<div class="meta">${esc(i.note)}</div>` : ""}
  </div>`;
}
function carryRowHtml(i, isMine) {
  if (isMine && state.editingCarry === i.id) {
    return `<div class="row shop-row row-edit">
      <div class="main">
        <div class="name">${esc(i.name)}</div>
      </div>
      <div class="edit-fields">
        <input id="carry-edit-qty-${i.id}" class="shrink" value="${esc(i.quantity || "")}" placeholder="数量" aria-label="数量" autocomplete="off" />
      </div>
      <div class="edit-btns">
        <button class="primary shrink" data-action="save-carry-edit" data-id="${i.id}">保存</button>
        <button class="ghost shrink" data-action="cancel-carry-edit">取消</button>
      </div>
    </div>`;
  }
  return `<div class="row shop-row">
    ${carryInfoHtml(i)}
    <div class="shop-actions">
      <button class="pill${i.status === "已带" ? " done" : ""}" ${isMine ? `data-action="toggle-carry" data-id="${i.id}" data-status="${i.status === "已带" ? "待带" : "已带"}"` : "disabled"}>
        ${esc(i.status)}
      </button>
      ${isMine ? `<button class="link" data-action="edit-carry" data-id="${i.id}" title="修改这一项的数量（不改名称）">修改</button>` : ""}
      ${isMine ? dangerCell("carry", i.id, "del-carry") : ""}
    </div>
  </div>`;
}

// 只重画携带物品页内容（用缓存数据）
function paintCarry() {
  const items = state.carryItems || [];
  const mine = state.familyId;
  // 整页重画前留住在编辑框里还没保存的数量；物品若已被删掉就退出编辑态
  const editId = state.editingCarry;
  let draft = null;
  if (editId != null) {
    const el = $("#carry-edit-qty-" + editId);
    if (el) draft = el.value;
    if (!items.some((i) => Number(i.id) === Number(editId))) state.editingCarry = null;
  }
  const groups = state.families
    .map((f) => {
      const list = items.filter((i) => i.family_id === f.id);
      const isMine = f.id === mine;
return `<div class="section${isMine ? "" : " readonly"}">
        <div class="section-head">
          <span class="title">${esc(f.name)}${isMine ? ' <span class="mine">（我的家庭）</span>' : ' <span class="ro-badge">其他家庭 · 只读</span>'}</span>
          <span class="hint">${list.length} 项</span>
        </div>
        ${list.length ? list.map((i) => carryRowHtml(i, isMine)).join("") : '<div class="empty">暂无</div>'}
        ${isMine
          ? `<div class="form-row" style="margin-top:10px">
               <input id="carry-name" placeholder="物品名称" autocomplete="off" />
               <input id="carry-qty" class="shrink" style="flex:0 0 90px" placeholder="数量" autocomplete="off" />
               <button class="ghost shrink" data-action="add-carry">添加</button>
             </div>`
          : ''}
      </div>`;
    })
    .join("");
  const orphan = items.filter((i) => !i.family_id);
  const orphanHtml = orphan.length
    ? `<div class="section"><div class="section-head"><span class="title">未分配</span></div>${orphan
        .map((i) => `<div class="row">${carryInfoHtml(i)}<span class="tag">${esc(i.status)}</span></div>`)
        .join("")}</div>`
    : "";
  $("#content").innerHTML = (groups || "") + orphanHtml;
  if (draft != null && state.editingCarry != null) {
    const el = $("#carry-edit-qty-" + editId);
    if (el) el.value = draft;
  }
}

// ---------- 采购清单 ----------
async function fetchShopping(signal) {
  return loadPageData("shopping", signal);
}

// ---------- 采购清单筛选 ----------
// 条件只存在内存里：切页签保持，切项目 / 退出登录（resetTabCache）与刷新页面复位，
// 免得带着上一个项目的条件进入新项目却看到空列表。
function resetShopFilter() {
  state.shopFilter = { status: "all", claim: "all", family: "all", q: "" };
  state.shopFamilyOpen = false;
}
function shopFilterActive() {
  const f = state.shopFilter || {};
  return f.status !== "all" || f.claim !== "all" || f.family !== "all" || !!String(f.q || "").trim();
}
// 「接单」与「家庭」是同一件事的两个粒度，天然互斥：
//   具体家庭 X 隐含「已接单且属于 X」；「未接单」没有家庭；「我家接单」等价于家庭=我家。
// 按「用户这次改的是哪个条件」来联动，而不是事后无条件规范化——否则已选家庭时
// 点「我家接单」，规范化会把用户刚点的 mine 又改回 claimed，点击等于没生效。
function shopFilterDisabled() {
  const f = state.shopFilter || {};
  return {
    family: f.claim === "unclaimed" || f.claim === "mine", // 家庭下拉禁用
    claim: f.family !== "all" ? ["unclaimed", "mine"] : [], // 接单分段里禁用哪几项
  };
}
function setShopFilter(patch) {
  const f = Object.assign({}, state.shopFilter, patch);
  if (patch.claim !== undefined) {
    // 点「未接单 / 我家接单」→ 家庭归回全部家庭；点「全部 / 已接单」保留已选家庭（AND 语义一致）
    if (f.claim === "unclaimed" || f.claim === "mine") f.family = "all";
  } else if (patch.family !== undefined && f.family !== "all") {
    // 选具体家庭 → 接单自动归「已接单」，不再与「未接单 / 我家接单」并存
    f.claim = "claimed";
  }
  state.shopFilter = f;
}
function filteredShopping(items) {
  const f = state.shopFilter || {};
  // 搜索只匹配名称：数量 / 单位 / 备注 / 接单家庭名都不参与
  const q = String(f.q || "").trim().toLowerCase();
  const mine = Number(state.familyId) || null;
  return (items || []).filter((i) => {
    if ((f.status === "待购" || f.status === "已购") && i.status !== f.status) return false;
    const claimed = !!i.claimed_family_id;
    if (f.claim === "unclaimed" && claimed) return false;
    if (f.claim === "claimed" && !claimed) return false;
    if (f.claim === "mine" && (!mine || Number(i.claimed_family_id) !== mine)) return false;
    if (f.family !== "all" && (!claimed || Number(i.claimed_family_id) !== Number(f.family))) return false;
    if (q && !String(i.name == null ? "" : i.name).toLowerCase().includes(q)) return false;
    return true;
  });
}
// 下拉：现有家庭 + 清单里仍挂着、但家庭可能已被删掉的接单方
function shopFilterFamilies() {
  const rows = (state.families || []).map((f) => ({ id: f.id, name: f.name }));
  const known = new Set(rows.map((r) => Number(r.id)));
  (state.shoppingList || []).forEach((i) => {
    if (i.claimed_family_id && !known.has(Number(i.claimed_family_id))) {
      known.add(Number(i.claimed_family_id));
      rows.push({ id: i.claimed_family_id, name: i.claimed_family_name || "已移除的家庭" });
    }
  });
  const cur = state.shopFilter && state.shopFilter.family;
  if (cur !== "all" && !known.has(Number(cur))) rows.push({ id: cur, name: "已移除的家庭" });
  return rows;
}
function shopSegHtml(key, label, opts) {
  const f = state.shopFilter;
  const dis = shopFilterDisabled();
  const buttons = opts
    .map(([v, text]) => {
      const off = key === "claim" && dis.claim.includes(v);
      return `<button type="button" class="seg-btn${f[key] === v ? " on" : ""}" data-action="shop-filter-${key}" data-v="${v}" aria-pressed="${f[key] === v ? "true" : "false"}"${off ? ' disabled title="与已选家庭互斥：先把家庭改回「全部家庭」"' : ""} data-readonly-keep>${text}</button>`;
    })
    .join("");
  return `<div class="shop-filter-line shop-seg-line">
    <span class="shop-filter-label">${label}</span>
    <div class="shop-seg" role="group" aria-label="${label}筛选">${buttons}</div>
  </div>`;
}
// 家庭下拉改为自绘：原生 <select> 的选项面板由系统绘制，深色主题下仍是白底，
// 这里触发器与选项列表全部走主题令牌，浅 / 深两套配色都能对上。
function shopFamilyLabel() {
  const f = state.shopFilter;
  if (f.family === "all") return "全部家庭";
  const row = shopFilterFamilies().find((r) => String(r.id) === String(f.family));
  return row ? row.name : "已移除的家庭";
}
function shopFamilyOptionsHtml() {
  const f = state.shopFilter;
  const opts = [{ id: "all", name: "全部家庭" }].concat(shopFilterFamilies());
  return opts
    .map((r) => {
      const on = String(r.id) === String(f.family);
      return `<button type="button" class="shop-select-opt${on ? " on" : ""}" role="menuitemradio" aria-checked="${on ? "true" : "false"}" data-action="shop-family-pick" data-v="${esc(r.id)}" data-readonly-keep>${esc(r.name)}</button>`;
    })
    .join("");
}
function shopFamilySignature() {
  return shopFilterFamilies().map((r) => String(r.id) + ":" + r.name).join("|");
}
// 面板开合统一走这里：paint / 后台刷新重建 DOM 后按 state 恢复开合，
// 不播入场动画、不抢焦点，避免切回本页时「闪一下」。
function paintShopFamilyOpen(focus = false, animate = false) {
  const menu = $("#shop-family-menu"), trigger = $("#shop-filter-family");
  if (!menu || !trigger) return;
  const want = !!state.shopFamilyOpen && !trigger.disabled;
  menu.hidden = !want;
  trigger.setAttribute("aria-expanded", want ? "true" : "false");
  const sec = trigger.closest(".section");
  if (sec) sec.classList.toggle("has-open-menu", want);
  menu.classList.toggle("enter", want && animate);
  if (want && focus) {
    const cur = menu.querySelector(".shop-select-opt.on") || menu.querySelector(".shop-select-opt");
    if (cur) cur.focus({ preventScroll: true });
  }
}
function setShopFamilyOpen(open) {
  const trigger = $("#shop-filter-family");
  if (open && trigger && trigger.disabled) return;
  state.shopFamilyOpen = !!open;
  paintShopFamilyOpen(!!open, !!open);
}
function shopFilterBarHtml() {
  const f = state.shopFilter;
  const dis = shopFilterDisabled();
  return `<div id="shop-filter" class="shop-filter" role="search" aria-label="采购清单筛选">
    <div class="shop-filter-segs">
      ${shopSegHtml("status", "状态", [["all", "全部"], ["待购", "待购"], ["已购", "已购"]])}
      ${shopSegHtml("claim", "接单", [["all", "全部"], ["unclaimed", "未接单"], ["claimed", "已接单"], ["mine", "我家接单"]])}
    </div>
    <div class="shop-filter-line">
      <div class="shop-select" id="shop-family-select">
        <button type="button" class="shop-select-trigger" id="shop-filter-family" aria-label="按接单家庭筛选" aria-haspopup="menu" aria-expanded="false" data-action="shop-family-toggle" data-readonly-keep data-filter-state${dis.family ? ' disabled title="「未接单 / 我家接单」下没有接单家庭可筛"' : ""}>
          <span class="shop-select-value" id="shop-family-value">${esc(shopFamilyLabel())}</span>
          <span class="shop-select-caret" aria-hidden="true"></span>
        </button>
        <div class="shop-select-menu" id="shop-family-menu" role="menu" aria-label="选择接单家庭" hidden>${shopFamilyOptionsHtml()}</div>
      </div>
      <input id="shop-filter-q" placeholder="按名称搜索采购项" value="${esc(f.q || "")}" aria-label="按名称搜索采购项" autocomplete="off" data-readonly-keep data-filter-state />
      <button type="button" class="ghost shrink" data-action="shop-filter-clear" data-readonly-keep${shopFilterActive() ? "" : " hidden"}>清除筛选</button>
    </div>
  </div>`;
}

// 采购清单外壳：表单与筛选条只在这里建一次，之后筛选只换 #shop-list，
// 否则每敲一个搜索字都重建 #content，输入框会失焦、中文输入法组合会被打断。
function paintShopping() {
  $("#content").innerHTML = `
    <div class="section">
      <div class="section-head">
        <span class="title">采购清单</span>
        <span class="hint" id="shop-count"></span>
      </div>
      <div class="form-row">
        <input id="shop-name" placeholder="采购项名称" autocomplete="off" />
        <input id="shop-qty" class="shrink" style="flex:0 0 70px" placeholder="数量" autocomplete="off" />
        <input id="shop-unit" class="shrink" style="flex:0 0 70px" placeholder="单位" autocomplete="off" />
        <button class="ghost shrink" data-action="add-shop">添加</button>
      </div>
      ${shopFilterBarHtml()}
      <div id="shop-list" style="margin-top:10px"></div>
    </div>`;
  renderShopRows();
}

// 单行模板
function shopRowHtml(i) {
  // 编辑态：只放开「数量 / 单位」两个输入。名称是关联键（候选框、已购派生、老记录的按名匹配），
  // 改名会断掉历史关联，所以这里连输入框都不给。
  if (state.editingShop === i.id) {
    return `<div class="row shop-row row-edit">
      <div class="main">
        <div class="name">${esc(i.name)}</div>
        <div class="meta">修改数量 / 单位（所有家庭都能改）</div>
      </div>
      <div class="edit-fields">
        <input id="shop-edit-qty-${i.id}" class="shrink" value="${esc(i.quantity || "")}" placeholder="数量" inputmode="text" aria-label="数量" autocomplete="off" />
        <input id="shop-edit-unit-${i.id}" class="shrink" value="${esc(i.unit || "")}" placeholder="单位" aria-label="单位" autocomplete="off" />
      </div>
      <div class="edit-btns">
        <button class="primary shrink" data-action="save-shop-edit" data-id="${i.id}">保存</button>
        <button class="ghost shrink" data-action="cancel-shop-edit">取消</button>
      </div>
    </div>`;
  }
  // 名称同一行右侧显示「数量·单位」，接单信息（接单家庭标记 + 接单时间）单独排在下一行左对齐
  const qty = [i.quantity && esc(i.quantity), i.unit && esc(i.unit)].filter(Boolean).join(" ");
  const note = i.note && esc(i.note);
  const metaParts = [];
  if (claimInfo(i)) metaParts.push(claimInfo(i));
  if (i.claimed_at) metaParts.push(`<span class="m">接单于 ${fmtTime(i.claimed_at)}</span>`);
  if (note) metaParts.push(`<span class="m">${note}</span>`);
  const metaHtml = metaParts.length ? `<div class="meta shop-meta">${metaParts.join("")}</div>` : "";
  return `<div class="row shop-row">
    <div class="main">
      <div class="shop-head">
        <div class="name">${esc(i.name)}</div>
        ${qty ? `<span class="shop-qty">${qty}</span>` : ""}
      </div>
      ${metaHtml}
    </div>
    <div class="shop-actions">
      ${shopStatusCell(i)}
      <button class="link" data-action="edit-shop" data-id="${i.id}" title="修改这一项的数量和单位（不改名称）">修改</button>
      ${
        i.status === "已购"
          ? // 已经登记过采购记录的项不能删：删除控件保持占用但不可用，原因写进 title / aria-label，
            // 页面下方的规则说明里也写清「删掉采购记录即可恢复可删除」。删掉记录后 status 回「待购」，删除自动恢复可用。
            `<button class="link danger del-off" data-action="del-shop" data-id="${i.id}" disabled aria-disabled="true" title="这一项已经登记过采购记录，不能删除；删掉对应的采购记录后它会回到「未接单 + 待购」，那时才能删" aria-label="删除不可用：这一项已经登记过采购记录，删掉对应的采购记录后即可删除">删除</button>`
          : dangerCell("shopping", i.id, "del-shop")
      }${claimAction(i)}
    </div>
  </div>`;
}

// 只重画列表行 + 计数 + 控件状态；输入区完全不动，所以焦点不会丢。
// force=true 用于「清除筛选 / 新增项后复位」这类显式动作：此时允许回写搜索框的值。
function renderShopRows(force = false) {
  const list = $("#shop-list");
  if (!list) return;
  const all = state.shoppingList || [];
  const shown = filteredShopping(all);
  // 编辑态跨重绘：被筛掉就退出编辑；仍匹配则把未保存的数量 / 单位回填，别让用户白填
  const editId = state.editingShop;
  let draft = null;
  if (editId != null) {
    const q = $("#shop-edit-qty-" + editId), u = $("#shop-edit-unit-" + editId);
    if (q && u) draft = { qty: q.value, unit: u.value };
    if (!shown.some((i) => Number(i.id) === Number(editId))) state.editingShop = null;
  }
  list.innerHTML = shown.length
    ? shown.map(shopRowHtml).join("")
    : `<div class="empty shop-empty">${all.length ? "没有符合条件的采购项" : "清单为空"}</div>`;
  if (draft && state.editingShop != null) {
    const q = $("#shop-edit-qty-" + editId), u = $("#shop-edit-unit-" + editId);
    if (q && u) { q.value = draft.qty; u.value = draft.unit; }
  }
  const waiting = shown.filter((i) => i.status === "待购").length;
  const claimed = shown.filter((i) => i.claimed_family_id).length;
  const count = $("#shop-count");
  if (count) {
    count.textContent = shopFilterActive()
      ? `显示 ${shown.length} / 共 ${all.length} 项 · ${waiting} 项待购 · ${claimed} 项已被接单`
      : `共 ${all.length} 项 · ${waiting} 项待购 · ${claimed} 项已被接单`;
  }
  syncShopFilterControls(force);
  disableEditControlsIn(list); // 局部重绘出的新控件也要遵守只读
}

function syncShopFilterControls(force = false) {
  const f = state.shopFilter;
  const bar = $("#shop-filter");
  if (!bar) return;
  const dis = shopFilterDisabled();
  // 分段按钮：选中态 + 互斥禁用态。禁用项永远不会被选中（setShopFilter 保证），
  // 所以不会出现「选中且置灰」的怪状态。
  bar.querySelectorAll("[data-action='shop-filter-status'], [data-action='shop-filter-claim']").forEach((b) => {
    const key = b.dataset.action === "shop-filter-status" ? "status" : "claim";
    const on = f[key] === b.dataset.v;
    const off = key === "claim" && dis.claim.includes(b.dataset.v);
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.disabled = off;
    if (off) b.title = "与已选家庭互斥：先把家庭改回「全部家庭」";
    else if (key === "claim") b.removeAttribute("title");
  });
  const trigger = $("#shop-filter-family");
  if (trigger) {
    trigger.disabled = dis.family;
    if (dis.family) trigger.title = "「未接单 / 我家接单」下没有接单家庭可筛，先切回「全部」或「已接单」";
    else trigger.removeAttribute("title");
    const label = $("#shop-family-value");
    if (label) label.textContent = shopFamilyLabel();
  }
  // 家庭列表只在内容变化时重建选项，避免每次筛选都打断面板里的键盘焦点
  const menu = $("#shop-family-menu");
  if (menu) {
    const sig = shopFamilySignature();
    if (menu.dataset.sig !== sig) {
      const active = document.activeElement;
      const activeV = active && active.classList && active.classList.contains("shop-select-opt") ? active.dataset.v : null;
      menu.dataset.sig = sig;
      menu.innerHTML = shopFamilyOptionsHtml();
      if (activeV) {
        const back = [...menu.querySelectorAll(".shop-select-opt")].find((o) => o.dataset.v === activeV);
        if (back) back.focus({ preventScroll: true });
      }
    }
    menu.querySelectorAll(".shop-select-opt").forEach((o) => {
      const on = String(o.dataset.v) === String(f.family);
      o.classList.toggle("on", on);
      o.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  paintShopFamilyOpen(); // 恢复开合（不抢焦点、不播入场动画）
  const q = $("#shop-filter-q");
  // 正在逐字输入的搜索框不回写：输入法组合过程中 value 可能领先 state 一拍。
  // 但「清除筛选」等显式复位必须强制回写，否则框里还留着旧关键词、state 却已清空。
  if (q && q.value !== String(f.q || "") && (force || document.activeElement !== q)) q.value = f.q || "";
  const clear = bar.querySelector("[data-action='shop-filter-clear']");
  if (clear) clear.hidden = !shopFilterActive();
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
// open：目标开合状态；animate：是否播入场动画。
// 只有「用户主动打开」（点击 / 聚焦 / 键盘）才播；重建后的恢复必须传 false，
// 否则整块 #content 重建时面板会重新淡入，看起来就是闪一下。
function setSuggestOpen(open, animate = true) {
  const box = $("#pur-suggest"), input = $("#pur-item"), toggle = $("#pur-combo .combo-toggle");
  if (!box || !input) return;
  const want = !!open;
  // 以「DOM 实际开合」为准：整页重建后新节点自带 hidden，state 可能还停在 true。
  // 若把 state 也掺进判断，重建后调 setSuggestOpen(false) 会被误判成「本来就收着」而直接
  // 返回，true 就一直留在 state 里；下一轮 captureSuggestOpen() 会当成「用户正开着」把面板
  // 恢复成打开 —— 这也是「面板自己弹出来」的一条隐蔽路径。
  const isOpen = !box.hidden;
  // 已经处于目标状态就直接返回：不重填列表、更不重播入场动画。
  // 点输入框会先触发 focusin（开一次），松手后再触发 click（又调一次）；
  // 第二次如果照旧从 .enter 重来，刚淡入一两帧的面板会被拉回 translateY(-6px) scale(.97)，
  // 观感就是面板「抖一下」（实测 opacity 0 → 0.25 → 0 → 0.76 → 1）。
  // 三角按钮同样是两次调用，只是都落在同一帧内，所以那边看不出问题。
  if (want === isOpen) {
    state.purSuggestOpen = want; // 幂等返回前把 state 对齐 DOM，杜绝上面的状态漂移
    return;
  }
  state.purSuggestOpen = want;
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
      : `<li class="combo-empty" role="presentation">${state.familyId ? "当前没有可登记项" : "请先选择你所属家庭"}</li>`;
  } else {
    state.purActive = -1;
    input.removeAttribute("aria-activedescendant");
  }
  box.hidden = !state.purSuggestOpen;
  if (state.purSuggestOpen) {
    // 摘掉上一次的 .enter 再按需加回：同一个节点反复开合时，只有先摘掉并强制结算，
    // 动画才会从头播一次（否则类名没变化，浏览器不会重新开始动画）。
    box.classList.remove("enter");
    if (animate) {
      void box.offsetWidth;
      box.classList.add("enter");
    }
  }
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
  if (state.tab !== "purchases") return false;
  // 记用户「实际看到」的开合：state 可能与重建后的新节点短暂不一致，DOM 才作准。
  const box = $("#pur-suggest");
  return !!(box && !box.hidden);
}
function restoreSuggestOpen(keep) {
  // 重建后的恢复：不播入场动画，否则面板会重新淡入 = 闪一下。
  // 这里不再判断 state.purSuggestOpen —— 新节点一定是 hidden 的，setSuggestOpen 内部会按
  // 「DOM 实际状态」判断要不要展开；提前判断 state 反而会在重建后漏掉恢复。
  if (keep && state.tab === "purchases") setSuggestOpen(true, false);
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
  if (e.target.id !== "pur-item") return;
  // 程序性聚焦（后台刷新回填焦点、选完候选项后把焦点放回输入框）不等于用户想展开面板：
  // 直接忽略，否则慢接口返回后用户已经收起的候选面板会自己再弹出来一次。
  // 已经展开时也不重开：重开会重建列表 + 重播入场动画，观感就是「面板闪一下」。
  if (quietFocus || e.target.dataset.quietFocus) {
    delete e.target.dataset.quietFocus;
    return;
  }
  if (!state.purSuggestOpen) setSuggestOpen(true);
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
// 触摸端没有 hover：点一下把气泡固定在那一行，再点一次收起（同时只留一个）。
// 用 .tip-open 而不是让 :focus-within 负责显示 —— 鼠标点击同样会让行拿到焦点，
// 那就会「点过 A 行、再悬停 B 行」时两个气泡同时亮着。
$("#content").addEventListener("pointerdown", (e) => {
  const row = e.target.closest && e.target.closest(".task-row");
  const tip = row && row.querySelector(".task-tip");
  // 鼠标（以及个别浏览器报空的 pointerType）走 :hover 即可，这里只清掉触摸留下的固定气泡
  if (e.pointerType !== "touch" && e.pointerType !== "pen") {
    document.querySelectorAll(".task-row.tip-open").forEach((r) => r.classList.remove("tip-open"));
    return;
  }
  const wasOpen = !!(row && row.classList.contains("tip-open"));
  document.querySelectorAll(".task-row.tip-open").forEach((r) => r.classList.remove("tip-open"));
  if (!tip) return;
  if (!wasOpen) row.classList.add("tip-open");
  placeTaskTip(row, tip, e.clientX);
});

// 点在别处（侧栏、顶栏、空白）时收起触摸固定的气泡
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest && e.target.closest(".task-row")) return;
  document.querySelectorAll(".task-row.tip-open").forEach((r) => r.classList.remove("tip-open"));
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
  // 行内编辑（采购项数量/单位、携带物品数量、采购记录金额）：回车 = 保存，Esc = 取消，和旁边的按钮等价
  if (/^(shop-edit-qty|shop-edit-unit|carry-edit-qty|pur-edit-amount)-/.test(e.target.id || "")) {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    const row = e.target.closest(".row-edit");
    const btn = row && row.querySelector(e.key === "Enter" ? '[data-action^="save-"]' : '[data-action^="cancel-"]');
    if (btn) btn.click();
    return;
  }
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
async function fetchPurchases(signal) {
  // 采购明细 + 名称候选 + 预算，后端聚合成 1 个 /api/page-data?tab=purchases
  return loadPageData("purchases", signal);
}

// 采购明细里的一行。抽成函数是为了让「整页重画」与「登记成功后就地插一行」共用同一份模板，
// 两条路径产出的 DOM 必须完全一致，否则同一笔记录在两种路径下会长得不一样。
// 自家登记的这一行可以改金额 / 删除（其他家庭只看得到，没有这个入口；后端也会再拦一次）。
// 「改金额 / 删除」两个文字按钮合成行尾一个「⋯」图标 + 下拉菜单，行宽紧张时（手机）不会把
// 金额挤到换行。删除仍走行内二次确认，菜单只是换了入口，不改变危险操作的确认流程。
function purchaseRowHtml(p) {
  const id = Number(p.id);
  const mine = Number(p.family_id) === Number(state.familyId);
  const meta = `${esc(familyName(p.family_id))} · ${fmtTime(p.purchased_at)}${p.quantity ? " · " + esc(p.quantity) : ""}`;

  if (mine && Number(state.editingPurchase) === id) {
    return `<div class="row row-edit">
      <div class="main"><div class="name">${esc(p.item_name)}</div>
        <div class="meta">${meta} · 只可修改金额</div></div>
      <div class="edit-fields">
        <input id="pur-edit-amount-${p.id}" class="shrink amt-input" type="text" inputmode="decimal" value="${esc(String(Number(p.amount) || 0))}" placeholder="金额" aria-label="金额" autocomplete="off" />
      </div>
      <div class="edit-btns">
        <button class="primary shrink" data-action="save-purchase-amount" data-id="${p.id}">保存</button>
        <button class="ghost shrink" data-action="cancel-purchase-edit">取消</button>
      </div>
    </div>`;
  }

  // 删除的二次确认态：菜单里点「删除」后本行直接变成「确认删除 / 取消」，
  // 不放回菜单里，免得用户在菜单还开着的时候点到不可撤销的按钮。
  if (mine && isPending("purchase", id)) {
    return `<div class="row">
      <div class="main"><div class="name">${esc(p.item_name)}</div>
        <div class="meta">${meta}</div></div>
      <span class="amt">${money(p.amount)}</span>
      <div class="row-confirm">
        <button class="link danger" data-action="confirm-del" data-kind="purchase" data-id="${p.id}">确认删除</button>
        <button class="link" data-action="cancel-del">取消</button>
      </div>
    </div>`;
  }

  const menuOpen = mine && Number(state.purMenuId) === id;
  return `<div class="row">
    <div class="main"><div class="name">${esc(p.item_name)}</div>
      <div class="meta">${meta}</div></div>
    <span class="amt">${money(p.amount)}</span>
    ${
      mine
        ? `<div class="row-more" data-id="${p.id}">
            <button class="tag more-btn${menuOpen ? " on" : ""}" data-action="toggle-pur-menu" data-id="${p.id}"
              aria-haspopup="true" aria-expanded="${menuOpen ? "true" : "false"}"
              aria-label="自家登记：可改金额或删除" title="可改金额或删除">自家登记</button>
            <div class="row-menu" role="menu" aria-label="可改金额或删除"${menuOpen ? "" : " hidden"}>
              <button class="row-menu-item" role="menuitem" data-action="edit-purchase" data-id="${p.id}">改金额</button>
              <button class="row-menu-item danger" role="menuitem" data-action="del-purchase" data-kind="purchase" data-id="${p.id}">删除</button>
            </div>
          </div>`
        : '<span class="tag off" title="只有登记这笔采购的家庭能修改或删除">他家登记</span>'
    }
  </div>`;
}

// 「更多操作」菜单的开关：只切 hidden / aria / 位置，不重画整页 ——
// 整页重画会重建整张列表，正是之前修过的「列表闪一下」。
// state.purMenuId 记当前展开那一行的 id，天然保证同时只开一个。
function syncPurMenus() {
  document.querySelectorAll("#pur-rows .row-more").forEach((wrap) => {
    const open = state.purMenuId !== null && Number(state.purMenuId) === Number(wrap.dataset.id);
    const menu = wrap.querySelector(".row-menu");
    const btn = wrap.querySelector(".more-btn");
    if (menu) menu.hidden = !open;
    if (btn) {
      btn.classList.toggle("on", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
  });
}

function closePurMenu() {
  if (state.purMenuId === null) return;
  state.purMenuId = null;
  syncPurMenus();
}

function openPurMenu(btn) {
  state.purMenuId = Number(btn.dataset.id);
  syncPurMenus();
  const menu = btn.parentElement && btn.parentElement.querySelector(".row-menu");
  if (!menu) return;
  // 默认向下弹；下方放不下（最后几行尤其常见）且上方更宽裕时改成向上弹。
  // 菜单刚从 hidden 变可见，同一帧内量 offsetHeight 已有值，不会闪。
  menu.classList.remove("up");
  const b = btn.getBoundingClientRect();
  const need = menu.offsetHeight + 12;
  if (b.bottom + need > window.innerHeight - 8 && b.top - need > 8) menu.classList.add("up");
}

// 点菜单外的任何地方都收起；Esc 同样收起（键盘用户唯一的出路）
document.addEventListener("pointerdown", (e) => {
  if (state.purMenuId === null) return;
  if (e.target instanceof Element && e.target.closest(".row-more")) return;
  closePurMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePurMenu();
});

// ---------- 采购明细筛选（只有「按家庭」一个条件） ----------
// 约定与采购清单筛选一致：条件只存内存，切页签保持，切项目 / 退出登录 / 刷新页面复位。
// 作用范围只限「采购明细」列表与它的计数；上方「各家采购金额」是全项目预算口径，
// 本身已按家庭分列，始终按全部家庭汇总，不随筛选变化。
function resetPurFilter() {
  state.purFilter = { family: "all" };
  state.purFamilyOpen = false;
}
function purFilterActive() {
  const f = state.purFilter || {};
  return !!f.family && String(f.family) !== "all";
}
function purMatches(p) {
  return !purFilterActive() || Number(p.family_id) === Number(state.purFilter.family);
}
function filteredPurchases(list) {
  return (list || []).filter(purMatches);
}
// 选项：项目内全部家庭 + 明细里出现过、但家庭可能已被移除的登记方
function purFilterFamilies() {
  const rows = (state.families || []).map((f) => ({ id: f.id, name: f.name }));
  const known = new Set(rows.map((r) => Number(r.id)));
  (state.purchases || []).forEach((p) => {
    if (p.family_id && !known.has(Number(p.family_id))) {
      known.add(Number(p.family_id));
      rows.push({ id: p.family_id, name: "已移除的家庭" });
    }
  });
  const cur = (state.purFilter || {}).family;
  if (purFilterActive() && !known.has(Number(cur))) rows.push({ id: cur, name: "已移除的家庭" });
  return rows;
}
function purFamilyLabel() {
  if (!purFilterActive()) return "全部家庭";
  const row = purFilterFamilies().find((r) => String(r.id) === String(state.purFilter.family));
  return row ? row.name : "已移除的家庭";
}
function purFamilyOptionsHtml() {
  const cur = (state.purFilter || {}).family;
  return [{ id: "all", name: "全部家庭" }]
    .concat(purFilterFamilies())
    .map((r) => {
      const on = String(r.id) === String(cur);
      return `<button type="button" class="shop-select-opt${on ? " on" : ""}" role="menuitemradio" aria-checked="${on ? "true" : "false"}" data-action="pur-family-pick" data-v="${esc(r.id)}" data-readonly-keep>${esc(r.name)}</button>`;
    })
    .join("");
}
function purFamilySignature() {
  return purFilterFamilies().map((r) => String(r.id) + ":" + r.name).join("|");
}
// 复用采购清单那套自绘下拉：原生 <select> 的选项面板由系统绘制，深色主题下仍是白底
function paintPurFamilyOpen(focus = false, animate = false) {
  const menu = $("#pur-family-menu"), trigger = $("#pur-filter-family");
  if (!menu || !trigger) return;
  const want = !!state.purFamilyOpen && !trigger.disabled;
  menu.hidden = !want;
  trigger.setAttribute("aria-expanded", want ? "true" : "false");
  const sec = trigger.closest(".section");
  if (sec) sec.classList.toggle("has-open-menu", want);
  menu.classList.toggle("enter", want && animate);
  if (want && focus) {
    const cur = menu.querySelector(".shop-select-opt.on") || menu.querySelector(".shop-select-opt");
    if (cur) cur.focus({ preventScroll: true });
  }
}
function setPurFamilyOpen(open) {
  const trigger = $("#pur-filter-family");
  if (open && trigger && trigger.disabled) return;
  state.purFamilyOpen = !!open;
  paintPurFamilyOpen(!!open, !!open);
}
function purFilterBarHtml() {
  return `<div id="pur-filter" class="pur-filter" role="search" aria-label="采购明细按家庭筛选">
    <span class="pur-filter-label">家庭</span>
    <div class="shop-select pur-select" id="pur-family-select">
      <button type="button" class="shop-select-trigger" id="pur-filter-family" aria-label="按登记家庭筛选采购明细" aria-haspopup="menu" aria-expanded="false" data-action="pur-family-toggle" data-readonly-keep>
        <span class="shop-select-value" id="pur-family-value">${esc(purFamilyLabel())}</span>
        <span class="shop-select-caret" aria-hidden="true"></span>
      </button>
      <div class="shop-select-menu" id="pur-family-menu" role="menu" aria-label="选择登记家庭" hidden>${purFamilyOptionsHtml()}</div>
    </div>
    <button type="button" class="ghost shrink" data-action="pur-filter-clear" data-readonly-keep${purFilterActive() ? "" : " hidden"}>清除筛选</button>
  </div>`;
}
function syncPurFilterControls() {
  const bar = $("#pur-filter"), trigger = $("#pur-filter-family");
  if (!bar || !trigger) return;
  const val = $("#pur-family-value");
  if (val) val.textContent = purFamilyLabel();
  const menu = $("#pur-family-menu");
  if (menu) {
    const sig = purFamilySignature();
    if (menu.dataset.sig !== sig) {
      const active = document.activeElement;
      const activeV = active && active.classList && active.classList.contains("shop-select-opt") ? active.dataset.v : null;
      menu.dataset.sig = sig;
      menu.innerHTML = purFamilyOptionsHtml();
      if (activeV) {
        const back = [...menu.querySelectorAll(".shop-select-opt")].find((o) => o.dataset.v === activeV);
        if (back) back.focus({ preventScroll: true });
      }
    }
    const cur = (state.purFilter || {}).family;
    menu.querySelectorAll(".shop-select-opt").forEach((o) => {
      const on = String(o.dataset.v) === String(cur);
      o.classList.toggle("on", on);
      o.setAttribute("aria-checked", on ? "true" : "false");
    });
  }
  const clear = bar.querySelector("[data-action='pur-filter-clear']");
  if (clear) clear.hidden = !purFilterActive();
  paintPurFamilyOpen(); // 重建后按 state 恢复开合，不抢焦点、不播入场动画
}
// 选家庭只重画明细行 + 计数 + 控件状态，筛选条本身不动，也不重建上方三张卡片
// （整页重画会让卡片的光斑 / 边框动效重播，观感就是「闪一下」）。
function renderPurRows() {
  const rows = $("#pur-rows");
  if (!rows) return;
  const all = state.purchases || [];
  const shown = filteredPurchases(all);
  // 编辑态跨重绘：被筛掉就退出编辑；仍匹配则把未保存的金额回填
  const editId = state.editingPurchase;
  let draft = null;
  if (editId != null) {
    const el = $("#pur-edit-amount-" + editId);
    if (el) draft = el.value;
    if (!shown.some((p) => Number(p.id) === Number(editId))) state.editingPurchase = null;
  }
  state.purMenuId = null; // 行重建后旧菜单 DOM 已不存在
  rows.innerHTML = shown.length
    ? shown.map(purchaseRowHtml).join("")
    : `<div class="empty pur-empty">${all.length ? "这个家庭还没有采购记录" : "暂无采购记录"}</div>`;
  if (draft != null && state.editingPurchase != null) {
    const el = $("#pur-edit-amount-" + editId);
    if (el) el.value = draft;
  }
  const count = $("#pur-count");
  if (count) {
    const sum = shown.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    count.textContent = purFilterActive()
      ? `显示 ${shown.length} / 共 ${all.length} 笔 · 合计 ${money(sum)}`
      : `${all.length} 笔`;
  }
  syncPurFilterControls();
  disableEditControlsIn(rows); // 局部重绘出的新控件也要遵守只读
}

// 「各家采购金额」下面那排家庭标签
function famSummaryHtml(perFamily) {
  if (!state.families.length) return '<span class="hint">还没有家庭</span>';
  return `<div class="fam-summary">${state.families
    .map((f) => `<span class="tag">${esc(f.name)} ${money(perFamily[f.id] || 0)}</span>`)
    .join("")}</div>`;
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
  state.purMenuId = null;        // 整页重画后菜单自然收起，避免留下一个位置不对的浮层
  const perFamily = {};
  list.forEach((p) => (perFamily[p.family_id] = (perFamily[p.family_id] || 0) + (Number(p.amount) || 0)));
$("#content").innerHTML = `
    <div class="section">
      <div class="section-head"><span class="title">登记一笔采购</span></div>
      <div class="form-row">
        <div class="combo" id="pur-combo">
          <input id="pur-item" class="combo-input" placeholder="从你已接单的项目里选" autocomplete="off" spellcheck="false" readonly role="combobox" aria-expanded="false" aria-controls="pur-suggest" aria-autocomplete="none" />
          <button class="combo-toggle" type="button" data-action="toggle-suggest" aria-expanded="false" aria-label="展开或收起物品名称候选" title="展开或收起候选"><svg class="combo-caret" aria-hidden="true" focusable="false" width="16" height="16"><use href="#icon-chevron"></use></svg></button>
          <ul class="combo-list" id="pur-suggest" role="listbox" aria-label="物品名称候选" hidden></ul>
        </div>
        <input id="pur-amount" class="shrink" style="flex:0 0 90px" type="number" min="0" step="0.01" placeholder="金额" autocomplete="off" />
        <button class="ghost shrink" data-action="add-purchase">登记</button>
      </div>
<p class="hint" style="margin:8px 0 0"></p>
    </div>
    <!-- 「各家采购金额」面板用普通面板底色（与上方「登记一笔采购」一致）；进度条与百分比仍按档位着色 -->
    <div class="section budget-summary">
      <div class="section-head"><span class="title">各家采购金额</span></div>
      <div id="pur-summary">${budgetProgressHtml(spent, budget)}<div style="margin-top:10px">${famSummaryHtml(perFamily)}</div></div>
    </div>
    <div class="section">
      <div class="section-head"><span class="title">采购明细</span><span class="hint" id="pur-count">${list.length} 笔</span></div>
      ${purFilterBarHtml()}
      <div id="pur-rows"></div>
    </div>`;
  // DOM 已重建。若重建前候选面板是打开的，把它恢复到打开状态并重新填充候选项，
  // 这样后台刷新 / 轮询不会把用户正在做的选择打断。
  // 恢复必须是「静态出现」（animate=false）：否则 0.18s 的 menu-in 会重放一遍，
  // 用户看到的就是候选面板闪一下。
  if (suggestWasOpen) {
    state.purSuggestOpen = true;
    setSuggestOpen(true, false);
  }
  // 按当前筛选条件填充明细：条件存在 state 里，切页签 / 后台刷新重建 DOM 后仍一致。
  // 同时按 state.purFamilyOpen 静态恢复下拉开合（不播入场动画，避免闪烁）。
  renderPurRows();
}

// 登记成功后【就地】把新行插到采购明细顶部，并更新两处汇总 —— 不再整页重建 #content。
// 以前这里走的是 await render()：整页重建会把三张卡片连同各自的光斑 / 边框动效一起重建，
// 观感上就是「列表闪一下」，代价还有一次完整重排和三次接口往返。
// 返回 false 表示当前 DOM 已经不在采购记录页（用户切走了），交给调用方整页兜底。
function applyPurchaseAdded(rec) {
  state.purchases = [rec].concat(state.purchases || []);
  // 清单里的这一项随之变「已购」：候选框里不该再出现它，采购清单页也不该再显示「待购」。
  const markDone = (list) => {
    const it = (list || []).find((x) => Number(x.id) === Number(rec.item_id));
    if (!it) return;
    it.status = "已购";
    if (!it.claimed_family_id) it.claimed_family_id = rec.family_id;
  };
  markDone(state.shopItems);
  markDone(state.shoppingList);
  // 概览页的「总花费」用的是缓存，顺手加上这一笔，切回概览时不会先显示旧数
  if (state.overview && state.overview.total_amount !== undefined) {
    state.overview.total_amount = (Number(state.overview.total_amount) || 0) + (Number(rec.amount) || 0);
  }

  const rows = $("#pur-rows");
  const count = $("#pur-count");
  if (!rows || !count) return false;

  // 新登记的一笔若不匹配当前家庭筛选，清掉条件并提示，避免「登记成功却看不到」
  let cleared = false;
  if (purFilterActive() && !purMatches(rec)) {
    resetPurFilter();
    cleared = true;
    toast("已清除家庭筛选，以便显示刚登记的这笔采购");
  }
  if (cleared || purFilterActive()) {
    renderPurRows(); // 筛选变化 / 生效时统一按条件重画，计数与筛选条一并同步
  } else {
    const empty = rows.querySelector(".empty");
    if (empty) empty.remove();
    rows.insertAdjacentHTML("afterbegin", purchaseRowHtml(rec));
    count.textContent = state.purchases.length + " 笔";
  }

  const summary = $("#pur-summary");
  if (summary) {
    const perFamily = {};
    let spent = 0;
    state.purchases.forEach((p) => {
      const a = Number(p.amount) || 0;
      spent += a;
      perFamily[p.family_id] = (perFamily[p.family_id] || 0) + a;
    });
    const budget = Number((state.overview || {}).budget) || 0;
    summary.innerHTML =
      budgetProgressHtml(spent, budget) + `<div style="margin-top:10px">${famSummaryHtml(perFamily)}</div>`;
  }
  return true;
}

// ---------- 结算 ----------
async function fetchSettlement(signal) {
  return loadPageData("settlement", signal);
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
  // 分摊方式：project.split_mode 决定，按人数口径时表格补一列人数。
  // person_fallback = 项目选了按人数但所有家庭都是 0 人，此时后端临时退回按家庭数均分。
  // 顶部「每家应摊」卡片由 shareCardHtml 统一生成（概览页共用），口径以 effective_mode 为准，
  // 不再用 split_mode 判断，避免 0 人兜底时把「每家」金额标成「人均」。
  const byPerson = s.split_mode === "person";
  const showPeopleCol = byPerson;
  const modeSwitch = `<div class="split-switch" role="group" aria-label="结算分摊方式">
      <span class="split-switch-label">分摊方式</span>
      <div class="split-switch-seg">
        <button type="button" class="seg-btn${byPerson ? "" : " on"}" data-action="settle-mode" data-v="family" aria-pressed="${byPerson ? "false" : "true"}" title="总花费按家庭数均分">按家庭数</button>
        <button type="button" class="seg-btn${byPerson ? " on" : ""}" data-action="settle-mode" data-v="person" aria-pressed="${byPerson ? "true" : "false"}" title="总花费按各家庭人数加权均分">按人数</button>
      </div>
    </div>`;
  // 奖金明细按「获得」从多到少排，拿得多的排前面
  const bonusRows = detail
    .slice()
    .sort((a, b) => (Number(b.bonus_out) || 0) - (Number(a.bonus_out) || 0) || (Number(b.done) || 0) - (Number(a.done) || 0));
  $("#content").innerHTML = `
    ${modeSwitch}
<div class="cards">
      <div class="card"><div class="num">${money(s.total)}</div><div class="lbl">总花费</div></div>
      ${bonus > 0 ? `<div class="card"><div class="num">${money(bonus)}</div><div class="lbl">任务奖金池${bonusActive ? `（已完成 ${s.bonus_total_done} 项）` : "（未生效）"}</div></div>` : ""}
      ${shareCardHtml(s)}
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
    </div>`
        : ""
    }
    <div class="section">
      <div class="section-head"><span class="title">每家结算</span><span class="hint">分摊口径：${esc(s.basis || "按家庭数均分")}</span></div>
      <table class="settle-table">
        <thead><tr><th>家庭</th>${showPeopleCol ? '<th class="r">人数</th>' : ""}<th class="r">已垫付</th><th class="r">应摊</th>${showBonusCol ? '<th class="r">任务奖金</th>' : ""}<th class="r">差额</th></tr></thead>
        <tbody>
          ${detail
            .map(
              (d) => `<tr>
                <td>${esc(d.name)}</td>
                ${showPeopleCol ? `<td class="r">${Number(d.member_count) || 0} 人</td>` : ""}
                <td class="r">${money(d.paid)}</td>
                <td class="r">${money(d.share)}</td>
                ${showBonusCol ? `<td class="r">${money(d.bonus_out)}</td>` : ""}
                <td class="r ${d.balance > 0 ? "pos" : d.balance < 0 ? "neg" : ""}">${signedMoney(d.balance)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p class="hint" style="margin-top:10px">${
        byPerson
          ? `每家应摊=总花费/总人数*家庭人数 ${bonusActive ? "+ 任务奖金/家庭数" : ""}`
          : `${bonusActive ? "每家应摊=(总花费+任务奖金)/家庭数" : "每家应摊=总花费/家庭数"}`
      }。</p>
      ${s.person_fallback ? '<p class="hint split-fallback">当前项目还没有登记任何人数，已临时按家庭数均分。</p>' : ""}
    </div>
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
async function fetchLogs(signal) {
  return loadPageData("logs", signal);
}

function paintLogs() {
  const logs = state.logsList || [];
  const canDel = !isReadonly();
  $("#content").innerHTML = logs.length
    ? `<div class="section-head" style="margin-bottom:6px">
         <span class="hint">共 ${logs.length} 条${canDel ? " · 删除/清除需要管理员密码" : ""}</span>
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

// 采购清单筛选：逐字搜索只更新内存条件与列表行，筛选条本身原样保留，
// 因此焦点、光标位置与中文输入法组合都不会被打断。家庭下拉改为自绘按钮，
// 选择动作统一走 click 委托（shop-family-pick），不再有原生 change 事件。
$("#content").addEventListener("input", (e) => {
  if (!e.target || e.target.id !== "shop-filter-q") return;
  setShopFilter({ q: e.target.value });
  renderShopRows();
});
// 自绘家庭下拉的键盘操作：向下键打开、方向键在选项间移动、Esc 收起并归还焦点。
$("#content").addEventListener("keydown", (e) => {
  const trigger = $("#shop-filter-family"), menu = $("#shop-family-menu");
  if (!trigger || !menu) return;
  if (e.target === trigger && e.key === "ArrowDown" && !state.shopFamilyOpen) {
    setShopFamilyOpen(true);
    e.preventDefault();
    return;
  }
  if (menu.hidden) return;
  if (e.key === "Escape") {
    setShopFamilyOpen(false);
    trigger.focus({ preventScroll: true });
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const opts = [...menu.querySelectorAll(".shop-select-opt")];
    if (!opts.length) return;
    const i = opts.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? opts[(i + 1) % opts.length]
      : opts[(i - 1 + opts.length) % opts.length];
    next.focus({ preventScroll: true });
    e.preventDefault();
  }
});
// 点面板以外（含非交互空白）或焦点移出时收起，避免下拉一直浮在列表上。
document.addEventListener("pointerdown", (e) => {
  if (!state.shopFamilyOpen) return;
  const sel = $("#shop-family-select");
  if (sel && !sel.contains(e.target)) setShopFamilyOpen(false);
}, true);
document.addEventListener("focusin", (e) => {
  if (!state.shopFamilyOpen) return;
  const sel = $("#shop-family-select");
  if (sel && !sel.contains(e.target)) setShopFamilyOpen(false);
});

// 采购明细的家庭下拉：同一套键盘导航 / 外部点击收起，但状态与采购清单下拉互不干扰。
// 上面的清单监听在本页会直接 return（#shop-filter-family 不存在），两套不会抢同一个按键。
$("#content").addEventListener("keydown", (e) => {
  const trigger = $("#pur-filter-family"), menu = $("#pur-family-menu");
  if (!trigger || !menu) return;
  if (e.target === trigger && e.key === "ArrowDown" && !state.purFamilyOpen) {
    setPurFamilyOpen(true);
    e.preventDefault();
    return;
  }
  if (menu.hidden) return;
  if (e.key === "Escape") {
    setPurFamilyOpen(false);
    trigger.focus({ preventScroll: true });
    e.preventDefault();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const opts = [...menu.querySelectorAll(".shop-select-opt")];
    if (!opts.length) return;
    const i = opts.indexOf(document.activeElement);
    const next = e.key === "ArrowDown"
      ? opts[(i + 1) % opts.length]
      : opts[(i - 1 + opts.length) % opts.length];
    next.focus({ preventScroll: true });
    e.preventDefault();
  }
});
document.addEventListener("pointerdown", (e) => {
  if (!state.purFamilyOpen) return;
  const sel = $("#pur-family-select");
  if (sel && !sel.contains(e.target)) setPurFamilyOpen(false);
}, true);
document.addEventListener("focusin", (e) => {
  if (!state.purFamilyOpen) return;
  const sel = $("#pur-family-select");
  if (sel && !sel.contains(e.target)) setPurFamilyOpen(false);
});

// ---------- 项目内事件委托 ----------
// 点输入框要能「开 / 收」切换，但点下去会先触发 focusin 把面板打开，等 click 时
// state 已经变过一轮了，直接取反就会「刚开又立刻关」。所以开合意图在按下的那一刻就定下来：
// pointerdown 早于聚焦（触屏也是，focus 要等 touchend），一套逻辑桌面和手机通吃。
let purPressWasOpen = null;
$("#content").addEventListener("pointerdown", (e) => {
  if (e.target && e.target.id === "pur-item") {
    const box = $("#pur-suggest");
    purPressWasOpen = !!(box && !box.hidden);
  }
});
$("#content").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) {
    // 只读的名称输入框没有 data-action：点它就是开合候选面板。
    // 只靠 focusin 有个死角——从候选里选完一项后输入框仍是聚焦的，再点它不触发 focusin，
    // 于是就「选过一次就拉不下来了」；所以这里也要能开。
    // 目标状态取「按下那一刻」的相反：按下时是收起的就开（focusin 已经开过，幂等跳过），
    // 按下时是展开的就收。没有按下记录（键盘 / 脚本 .click()）时按当前状态取反。
    if (e.target.id === "pur-item") {
      const wasOpen = purPressWasOpen === null ? !!state.purSuggestOpen : purPressWasOpen;
      purPressWasOpen = null;
      setSuggestOpen(!wasOpen);
    }
    return;
  }
  if (btn.dataset.busy === "1") return; // 正在处理中，忽略重复点击
  const { action, id, fid, status, kind } = btn.dataset;
  // 加载失败后的「重试」：立刻换回骨架屏，再走一遍当前页签的整页渲染。
  // render() 自己会递增代次并作废上一轮请求，连点也不会叠加出多份取数。
  // 放在 try 外面：按钮随即被 innerHTML 替换掉，不该再落到末尾 finally 的 setBusy(btn, false)。
  if (action === "retry-load") {
    showSkeleton();
    render();
    return;
  }
  const busyLabel = BUSY_ACTIONS[action];
  if (busyLabel) setBusy(btn, true, busyLabel);
  try {
    // 采购清单筛选：纯前端，只换列表行。必须 return —— 落到末尾的 await render()
    // 会整页重建 #content，搜索框随即失焦，连续输入 / 输入法组合会被打断。
    if (action === "shop-filter-status" || action === "shop-filter-claim") {
      const key = action === "shop-filter-status" ? "status" : "claim";
      setShopFilter({ [key]: btn.dataset.v });
      state.shopFamilyOpen = false; // 切条件时收起家庭面板
      renderShopRows();
      return;
    } else if (action === "shop-family-toggle") {
      setShopFamilyOpen(!state.shopFamilyOpen);
      return;
    } else if (action === "shop-family-pick") {
      setShopFilter({ family: btn.dataset.v });
      state.shopFamilyOpen = false;
      renderShopRows();
      const t = $("#shop-filter-family");
      if (t) t.focus({ preventScroll: true });
      return;
    } else if (action === "shop-filter-clear") {
      resetShopFilter();
      renderShopRows(true); // 强制清空搜索框里的旧关键词（此时它可能仍有焦点）
      return;
    } else if (action === "pur-family-toggle") {
      setPurFamilyOpen(!state.purFamilyOpen);
      return;
    } else if (action === "pur-family-pick") {
      state.purFilter = { family: btn.dataset.v };
      state.purFamilyOpen = false;
      renderPurRows();
      const t = $("#pur-filter-family");
      if (t) t.focus({ preventScroll: true });
      return;
    } else if (action === "pur-filter-clear") {
      resetPurFilter();
      renderPurRows();
      return;
    }
    if (action === "toggle-pur-menu") {
      // 开 / 收切换：同一个按钮再点一次就收起来
      if (state.purMenuId !== null && Number(state.purMenuId) === Number(id)) closePurMenu();
      else openPurMenu(btn);
      return;
    }
    if (action === "del-family" || action === "del-carry" || action === "del-shop" || action === "del-purchase") {
      // 点「删除」先弹确认框（Alert Dialog），确认后才真正删除；并收起采购记录行的「⋯」菜单
      // 用 closePurMenu() 而非只置空 state：它内部会 syncPurMenus() 把菜单 DOM 一并隐藏，
      // 否则状态已关、DOM 仍开，确认框点「取消」后面板还在，之后点别处也关不掉（守卫直接 return）。
      closePurMenu();
      askDelete(kind, id);
      return;
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
      toast("全部日志已清除");
    } else if (action === "settle-mode") {
      // 项目级口径，写库 + 管理员密码；成功后落到末尾的 await render() 统一重新取数重画。
      const mode = btn.dataset.v;
      const cur = String((state.settlement || {}).split_mode || "family");
      if (mode === cur) return;
      const label = mode === "person" ? "按人数均分" : "按家庭数均分";
      const ok = await withAdmin(`把结算分摊方式改为「${label}」`, async (pw) => {
        await api("/projects/" + state.projectId, {
          method: "PUT", body: { split_mode: mode }, withProject: false, adminPw: pw,
        });
      });
      if (!ok) return; // 取消：口径不变，也不必重渲染
      state.tabAt.settlement = 0; // 概览与结算都吃 /settlement，切过去时立即重取
      state.tabAt.overview = 0;
      toast("分摊方式已改为「" + label + "」");
    } else if (action === "edit-family") {
      // 进入编辑态：纯前端切换，只重画成员页（名称 / 人数 / 备注一起改）
      state.editingFamily = Number(id);
      if (paintCurrentTab()) return;
    } else if (action === "cancel-family-edit") {
      state.editingFamily = null;
      if (paintCurrentTab()) return;
    } else if (action === "save-family") {
      const name = $("#fam-edit-name-" + id).value.trim();
      const count = parseCountInput($("#fam-edit-count-" + id).value);
      if (!name) return toast("请输入家庭名称");
      if (count === null) return toast("人数必须是 0～999 的整数");
      const dup = familyNameConflict(name, state.families, Number(id));
      if (dup) return toast(familyNameConflictMsg(dup));
      await api("/families/" + id, {
        method: "PUT",
        body: { name, member_count: count, note: $("#fam-edit-note-" + id).value.trim() },
      });
      state.editingFamily = null;
      await loadFamilies();
      if (Number(state.familyId) === Number(id)) setWhoami(familyName(state.familyId));
      clearFields("fam-edit-name-" + id, "fam-edit-count-" + id, "fam-edit-note-" + id);
      state.tabAt.settlement = 0;
      state.tabAt.overview = 0;
    } else if (action === "add-family-app") {
      const name = $("#new-family-in-app").value.trim();
      const count = parseCountInput($("#new-family-count").value);
      if (!name) return toast("请输入家庭名称");
      if (count === null) return toast("人数必须是 0～999 的整数");
      const dup = familyNameConflict(name);
      if (dup) return toast(familyNameConflictMsg(dup));
      await api("/families", {
        method: "POST",
        body: { name, member_count: count, note: $("#new-family-note").value.trim() },
      });
      clearFields("new-family-in-app", "new-family-count", "new-family-note");
      await loadFamilies();
      state.tabAt.settlement = 0;
      state.tabAt.overview = 0;
    } else if (action === "add-carry") {
      if (!state.familyId) return toast("请先选择你所属的家庭");
      const name = $("#carry-name").value.trim();
      if (!name) return toast("请输入物品名称");
      // 先在前端拦一次同名：省一趟往返，提示也更即时（后端 409 兜住并发与多端）
      const dup = carryNameConflict(name);
      if (dup) {
        toast(carryNameConflictMsg(dup));
        const el = $("#carry-name");
        if (el) el.select();
        return;
      }
      await api("/carry-items", { method: "POST", body: { name, quantity: $("#carry-qty").value.trim() } });
      clearFields("carry-name", "carry-qty");
    } else if (action === "edit-carry") {
      // 纯前端切换到编辑态：只重画当前页签，不重新拉数据；别家的行根本没有这个按钮
      state.editingCarry = Number(id);
      if (paintCurrentTab()) {
        const el = $("#carry-edit-qty-" + id);
        if (el) { el.focus(); el.select(); }
        return;
      }
    } else if (action === "cancel-carry-edit") {
      state.editingCarry = null;
      if (paintCurrentTab()) return;
    } else if (action === "save-carry-edit") {
      const qtyEl = $("#carry-edit-qty-" + id);
      if (!qtyEl) return;
      const quantity = qtyEl.value.trim();
      await api("/carry-items/" + id, { method: "PUT", body: { quantity } });
      // 就地更新缓存再重画：不整页重建，列表不闪；留空即清空数量
      const it = (state.carryItems || []).find((x) => Number(x.id) === Number(id));
      if (it) it.quantity = quantity;
      state.editingCarry = null;
      if (paintCurrentTab()) {
        toast("已更新数量");
        return;
      }
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
      // 先在前端拦一次同名：省一趟往返，提示也更即时（后端同样会校验，防并发重复提交）
      const dup = (state.shoppingList || []).find((x) => String(x.name).trim() === name);
      if (dup) {
        toast("清单里已经有「" + name + "」了，不能重复添加");
        const el = $("#shop-name");
        if (el) el.select();
        return;
      }
      const quantity = $("#shop-qty").value.trim(), unit = $("#shop-unit").value.trim();
      await api("/shopping-items", {
        method: "POST",
        body: { name, quantity, unit },
      });
      clearFields("shop-name", "shop-qty", "shop-unit");
      // 新项固定是「待购 + 未接单」：若当前筛选把它挡在外面，看起来就像没添加成功。
      // 用同一套判定试一次，不匹配就清掉条件；同时立刻把筛选条控件复位，
      // 免得末尾 render() 之前这一段界面还显示着已失效的旧条件。
      const draft = { name, quantity, unit, status: "待购", claimed_family_id: null, note: "" };
      if (shopFilterActive() && !filteredShopping([draft]).length) {
        resetShopFilter();
        syncShopFilterControls(true);
        toast("已清除筛选，以便显示新增的「" + name + "」");
      }
    } else if (action === "edit-shop") {
      // 纯前端切换：只重画当前页签，不重新拉数据
      state.editingShop = Number(id);
      state.editingPurchase = null;
      if (paintCurrentTab()) {
        const el = $("#shop-edit-qty-" + id);
        if (el) el.focus();
        return;
      }
    } else if (action === "cancel-shop-edit") {
      state.editingShop = null;
      if (paintCurrentTab()) return;
    } else if (action === "save-shop-edit") {
      const qtyEl = $("#shop-edit-qty-" + id), unitEl = $("#shop-edit-unit-" + id);
      if (!qtyEl || !unitEl) return;
      const quantity = qtyEl.value.trim(), unit = unitEl.value.trim();
      await api("/shopping-items/" + id, { method: "PUT", body: { quantity, unit } });
      // 就地更新缓存再重画：不整页重建，列表不会闪
      // （采购记录页的候选框用的是另一份 shopItems 缓存，同样补上，免得切过去还显示旧的数量）
      [state.shoppingList, state.shopItems].forEach((list) => {
        const it = (list || []).find((x) => Number(x.id) === Number(id));
        if (it) {
          it.quantity = quantity;
          it.unit = unit;
        }
      });
      state.editingShop = null;
      if (paintCurrentTab()) {
        toast("已更新数量 / 单位");
        return;
      }
    } else if (action === "edit-purchase") {
      state.editingPurchase = Number(id);
      state.editingShop = null;
      state.purMenuId = null;
      if (paintCurrentTab()) {
        const el = $("#pur-edit-amount-" + id);
        if (el) {
          el.focus();
          el.select();
        }
        return;
      }
    } else if (action === "cancel-purchase-edit") {
      state.editingPurchase = null;
      if (paintCurrentTab()) return;
    } else if (action === "save-purchase-amount") {
      const el = $("#pur-edit-amount-" + id);
      if (!el) return;
      // 容忍「¥1,200」这类写法：去掉货币符号、千分位与空白再解析
      const amount = Number(String(el.value).replace(/[,\s¥￥]/g, ""));
      if (!Number.isFinite(amount) || amount <= 0) return toast("请输入大于 0 的金额");
      const rec = (state.purchases || []).find((x) => Number(x.id) === Number(id));
      if (rec && Number(rec.family_id) !== Number(state.familyId)) return toast("只能修改自家登记的采购金额");
      await api("/purchases/" + id, { method: "PUT", body: { amount } });
      const delta = rec ? amount - (Number(rec.amount) || 0) : 0;
      if (rec) rec.amount = amount;
      // 概览的「总花费」走的是另一份缓存，先按差额补上，并标记该页签需重新取数，
      // 免得切回概览时还看到旧的总花费
      if (state.overview && state.overview.total_amount !== undefined) {
        state.overview.total_amount = (Number(state.overview.total_amount) || 0) + delta;
      }
      state.tabAt.overview = 0;
      state.editingPurchase = null;
      if (paintCurrentTab()) {
        toast("金额已更新为 " + money(amount));
        return;
      }
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
        // 安静聚焦只还原焦点，展开由下一句显式完成（只播一次入场动画）。
        // 特别是「刚从候选里选完一项、输入框仍聚焦而面板已收起」的情形，
        // 不能靠 focusin 补开，否则会变成收起后又自己弹出来。
        focusQuietly($("#pur-item"));
        setSuggestOpen(true);
      }
      return;
    } else if (action === "pick-suggest") {
      $("#pur-item").value = btn.dataset.value || "";
      setSuggestOpen(false);
      focusQuietly($("#pur-item")); // 焦点留在输入框方便接着填金额，但别把面板又打开
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
      const r = await api("/purchases", {
        method: "POST",
        body: { item_name: itemName, amount, family_id: Number(state.familyId), item_id: matched.id },
      });
      clearFields("pur-item", "pur-amount");
      // 就地插一行、更新汇总，然后直接结束 —— 不再走末尾那次整页 render。
      // 后端返回的只有 id，其余字段用这次提交的值补齐（purchased_at 与数据库 datetime('now') 同为 UTC）。
      const rec = {
        id: r && r.id,
        item_id: matched.id,
        item_name: itemName,
        family_id: Number(state.familyId),
        amount,
        quantity: "",
        purchased_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      };
      if (!applyPurchaseAdded(rec)) await render(); // DOM 已不在本页时才整页兜底
      return;
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
        isRestart ? `重启已结束的项目「${label}」` : `结束项目${label}」（结束后项目内只读，需管理员密码才能重启）`,
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
      // 同名检查：与新建项目共用一套规则（同一口令下、去空格、忽略大小写、排除自己）
      const dup = projectNameConflict(newName, id);
      if (dup) return toast(projectNameConflictMsg(dup));
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
$("#logoutBtn2").addEventListener("click", logout);
$("#backHomeBtn").addEventListener("click", showHome);
// 「项目中心」入口已挪进右上角汉堡菜单（#topMenu 里的 data-action="go-home"），
// 顶栏不再单独占一个按钮；选择家庭页的「返回项目中心」仍直接调 showHome。
// 手动刷新：绕开 1 秒防抖立刻重取当前页签。聚合响应的 version 会顺手把版本游标推进到最新，
// 免得紧接着的探针又拿同一批变化触发一次重复拉取，因此这里只需 1 个请求。
// 按钮只在点击时发请求，零空闲开销。
// 动画：点下就加 .is-refreshing（图标转圈 + 品牌色高亮），转满至少一圈再收，
// 结束时放一圈扩散光环（.is-done）。网络再快也不会「闪一下就没了」。
const REFRESH_SPIN_MS = 600; // 与 style.css 里 #refreshBtn.is-refreshing .ico 的 spin 周期一致
let refreshDoneTimer = 0;
$("#refreshBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  clearTimeout(refreshDoneTimer);
  btn.classList.remove("is-done");
  btn.disabled = true;
  btn.classList.add("is-refreshing");
  btn.setAttribute("aria-busy", "true");
  markActivity();
  const started = Date.now();
  try {
    state.tabAt[state.tab] = 0;
    await revalidate(state.tab);
  } finally {
    // 至少转满一圈：请求比一圈还快时补一点时间，避免图标刚启动就被掐掉
    const rest = Math.max(0, REFRESH_SPIN_MS - (Date.now() - started));
    if (rest) await new Promise((r) => setTimeout(r, rest));
    btn.classList.remove("is-refreshing");
    btn.removeAttribute("aria-busy");
    btn.disabled = false;
    // 光环只表示「这次刷新动作结束了」，不暗示成功；失败另有 toast 提示
    btn.classList.add("is-done");
    refreshDoneTimer = setTimeout(() => btn.classList.remove("is-done"), 620);
  }
});
// 收起下拉并同步汉堡按钮的可访问状态。菜单里所有「点了就离开当前界面」的分支都要走它：
// 否则 #appView 被隐藏后 aria-expanded 仍停在 true，下次进项目会看到状态不一致。
function closeTopMenu() {
  $("#topMenu").classList.add("hidden");
  $("#topMenuBtn").setAttribute("aria-expanded", "false");
}

// 汉堡菜单：切换家庭（展开子菜单）、项目中心、退出。项目中心原先是顶栏独立按钮，
// 现在收进菜单、放在「退出」上面，顶栏少一个按钮，窄屏也不挤。
$("#topMenuBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("#topMenu");
  if (!menu.classList.contains("hidden")) {
    closeTopMenu();
    return;
  }
  // 直接用已缓存的家庭列表（state.families）展开，不再为打开下拉重新请求一次
  renderFamilyMenu();
  menu.classList.remove("hidden");
  $("#topMenuBtn").setAttribute("aria-expanded", "true");
  // 「切换家庭」子菜单默认收起，点开下拉后再点该项才展开名单
  const sub0 = $("#topMenuFamilyList");
  if (sub0) sub0.classList.add("hidden");
  const swBtn0 = $("#switchFamilyBtn");
  if (swBtn0) swBtn0.setAttribute("aria-expanded", "false");
});

// 菜单内的点击委托：切换家庭 / 设置 / 项目中心 / 退出
$("#topMenu").addEventListener("click", (e) => {
  // 「设置」：先收下拉再开弹窗，避免 #appView 隐藏后 aria-expanded 还停在 true
  const st = e.target.closest("[data-action='open-settings']");
  if (st) {
    closeTopMenu();
    openSettings();
    return;
  }
  // 点「切换家庭」：展开 / 收起家庭名单子菜单（不关闭整个下拉）
  const sw = e.target.closest("[data-action='switch-family']");
  if (sw) {
    const sub = $("#topMenuFamilyList");
    const willOpen = sub.classList.contains("hidden");
    sub.classList.toggle("hidden");
    sw.setAttribute("aria-expanded", String(willOpen));
    return;
  }
  const fam = e.target.closest("[data-action='pick-family']");
  if (fam) {
    state.familyId = Number(fam.dataset.id);
    localStorage.setItem(familyKey(state.projectId), String(state.familyId));
    closeTopMenu();
    showApp(); // 重建界面：当前家庭标识与各页数据随之更新
    toast("已切换到 " + familyName(state.familyId));
    return;
  }
  // 「项目中心」：和原来顶栏那个按钮完全一样回到项目列表，先收起菜单再切视图
  const home = e.target.closest("[data-action='go-home']");
  if (home) {
    closeTopMenu();
    showHome();
    return;
  }
  const out = e.target.closest("[data-action='logout']");
  if (out) {
    closeTopMenu();
    logout();
  }
});

// 点下拉以外的地方收起下拉
document.addEventListener("click", (e) => {
  const menu = $("#topMenu");
  if (!menu || menu.classList.contains("hidden")) return;
  if (e.target.closest("#topMenu") || e.target.closest("#topMenuBtn")) return;
  closeTopMenu();
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

// ---------- 删除确认弹窗（Alert Dialog） ----------
// 家庭 / 携带物品 / 采购清单 / 自家登记的采购记录，四类行内删除共用这一条路径：
// 确认 → 弹窗原地切成加载态 → 等 DELETE + 附加取数 + 整页重画完成 → 关闭 + toast。
// 危险确认不做「轻关闭」：点遮罩 / 按 Esc 都不关，只能显式点「取消」；
// 删除流程结束后由 hideConfirm(true) 统一收起，加载期间连「取消」也被挡住。
const CONFIRM_BUSY_MIN_MS = 450; // 至少转这么久，网络快时加载态不会一闪而过
const DELETE_TIMEOUT_MS = 15000; // 四类删除的写请求超时：极端弱网下别让确认弹窗永远转圈
let confirmOpts = null;
let confirmBusyAt = 0;

function setConfirmBusy(on) {
  const modal = $("#confirmModal");
  confirmBusy = on;
  modal.classList.toggle("is-busy", on);
  $("#confirmOkBtn").disabled = on;
  $("#confirmCancelBtn").disabled = on;
  if (on) {
    modal.setAttribute("aria-busy", "true");
    confirmBusyAt = Date.now();
    // 按钮被隐藏后焦点会掉回 body：挪到卡片上，键盘用户不会 Tab 到底层页面
    const card = modal.querySelector(".modal-card");
    if (card) card.focus({ preventScroll: true });
  } else {
    modal.removeAttribute("aria-busy");
  }
}

function showConfirm({ title, message, okText = "确定", danger = false, busyText = "正在处理…", onOk }) {
  if (confirmBusy) return; // 上一轮删除还没结束，不接受新的确认框
  confirmOpts = { onOk };
  $("#confirmTitle").textContent = title || "确认";
  $("#confirmDesc").textContent = message || "";
  $("#confirmLoadingText").textContent = busyText;
  const okBtn = $("#confirmOkBtn");
  okBtn.textContent = okText;
  okBtn.classList.toggle("danger", !!danger);
  setConfirmBusy(false); // 复位上一轮可能残留的加载态外观（含 disabled）
  $("#confirmModal").classList.remove("hidden");
  okBtn.focus();
}

// force=true 只在删除流程结束时调用；加载态期间的普通关闭一律拒绝
function hideConfirm(force = false) {
  if (confirmBusy && !force) return;
  setConfirmBusy(false);
  $("#confirmModal").classList.add("hidden");
  confirmOpts = null;
}

async function performDelete(kind, id) {
  const path = { family: "families", carry: "carry-items", shopping: "shopping-items", purchase: "purchases" }[kind];
  if (!path) return;
  try {
    // 其它写请求一律不超时，唯独删除例外：确认弹窗是阻塞式的，请求彻底挂起时会永远转圈。
    await api("/" + path + "/" + id, { method: "DELETE", timeoutMs: DELETE_TIMEOUT_MS });
  } catch (e) {
    // 写请求超时 ≠ 删除失败：可能已删成功、只是响应没回来。不能引导「重试」（会二次提交），
    // 让用户稍后点「刷新」看最新数据；弹窗由外层 finally 关闭，toast 说清现状。
    if (e && e.timedOut) throw new Error("网络较慢，删除结果未知，请稍后点「刷新」确认");
    throw e;
  }
  if (kind === "family") {
    await loadFamilies();
    if (state.familyId && !state.families.some((f) => f.id === Number(state.familyId))) {
      state.familyId = null;
      localStorage.removeItem(familyKey(state.projectId));
    }
    renderChrome();
  }
  state.pending = null;
  await render();
  // render() 取数失败时是把 #content 画成「加载失败 + 重试」后正常返回（不抛错）。
  // 界面没真正更新就别报「已删除」：这里补一刀，交给外层 toast 说清现状。
  if ($("#content .load-error")) throw new Error("已删除，但界面刷新失败，请点刷新重试");
}
function askDelete(kind, id) {
  const labels = { family: "家庭", carry: "携带物品", shopping: "采购项", purchase: "采购记录" };
  const name = labels[kind] || "该项";
  showConfirm({
    title: "确认删除",
    message: `确定要删除这个${name}吗？删除后不可恢复。`,
    okText: "确定删除",
    danger: true,
    busyText: `正在删除${name}…`,
    onOk: () => performDelete(kind, id),
  });
}
$("#confirmOkBtn").addEventListener("click", async () => {
  if (confirmBusy) return; // 连点保护：第二次点击时加载态已经挂上
  const opts = confirmOpts;
  if (!opts) return;
  setConfirmBusy(true);
  try {
    if (opts.onOk) await opts.onOk(); // DELETE + /families + render() 整页取数重画，全部等完
    toast("已删除");
  } catch (e) {
    toast(e.message || "删除失败，请重试");
  } finally {
    // 至少显示满 CONFIRM_BUSY_MIN_MS 再收，避免网络快时弹窗一闪而过
    const wait = CONFIRM_BUSY_MIN_MS - (Date.now() - confirmBusyAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    hideConfirm(true);
  }
});
// 只能点「取消」关闭：故意不挂遮罩 click 与全局 Esc 监听。
// 删除是不可撤销操作，误点弹窗外一片、或顺手按一下 Esc 就把确认框关掉属于「轻关闭」，
// 这里一律不提供；其它弹窗（管理密码 / 口令管理 / 新建项目）的关闭行为不受影响。
$("#confirmCancelBtn").addEventListener("click", () => hideConfirm());

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
          <input id="pc-edit-pw-${r.id}" value="${esc(r.passcode)}" placeholder="口令" autocomplete="off" />
          <input id="pc-edit-adminpw-${r.id}" value="${esc(r.admin_passcode)}" placeholder="管理员密码" autocomplete="off" />
          <input id="pc-edit-name-${r.id}" value="${esc(r.name)}" placeholder="备注名（可选）" autocomplete="off" />
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
  if (!adminPasscode) return ($("#pcMsg").textContent = "请为该口令设置管理员密码");
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
  if (!adminPasscode) return ($("#pcMsg").textContent = "管理员密码不能为空");
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

// ---------- 星座连线背景（Constellation Links） ----------
// 仅「深色主题 + 口令登入页」：数十个缓慢漂浮的发光节点，距离小于阈值时连极细的线；
// 光标附近节点被轻微吸向光标，移开后平滑回弹（位置每帧从基础坐标重算，不累积速度）。
// 浅色主题下完全不显示：停掉动画帧并清空画布，切到深色时即时恢复（无需刷新）。
// 沿用参考的青 / 蓝 / 紫 / 粉 5 色 + lighter 发光；极光色团 / 网格 / 暗角由 CSS 提供。
let constellationCtl = null;
function initConstellation() {
  const canvas = document.getElementById("bg-particles");
  if (!canvas) return { start() {}, stop() {} };
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TAU = Math.PI * 2;
  const PALETTE = ["34,211,238", "59,130,246", "168,85,247", "236,72,153", "103,232,249"];
  let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  let raf = 0, active = false;
  let ox = 0, oy = 0;                       // canvas 左上角相对视口的偏移
  let mx = -9999, my = -9999, mouseOn = false;
  let infl = 0, lastNow = 0;                // 聚拢强度的平滑系数
  let nodes = [], lim = 0, radius = 0, pullMax = 0;

  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }
  const rgba = (rgb, a) => "rgba(" + rgb + "," + a + ")";

  function resize() {
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rect = canvas.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    // 参考用 W*13% 作阈值，在 390px 窄屏只剩约 50px，几乎连不出线；
    // 这里改成按平均节点间距换算的密度自适应，桌面与手机连线密度接近。
    const n = Math.max(42, Math.min(96, Math.round((w * h) / 14000)));
    lim = Math.sqrt((w * h) / n) * 1.35;
    // 登录卡片遮住视口正中：影响半径太小时聚拢全发生在卡片底下，用户看不见反馈。
    // 取 0.38 覆盖到卡片外圈，位移仍只有半径的 15%，不会把连线拉成长条打结。
    radius = Math.min(w, h) * 0.38;
    pullMax = radius * 0.15;
    if (nodes.length !== n) {
      nodes = [];
      for (let i = 0; i < n; i++) {
        nodes.push({
          bx: Math.random(), by: Math.random(),
          phase: Math.random() * TAU,
          size: Math.random(),
          ci: i % PALETTE.length,
        });
      }
    }
  }

  function draw(t, k) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    const pts = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      let x = (nd.bx + Math.sin(t * 0.3 + nd.phase) * 0.02) * w;
      let y = (nd.by + Math.cos(t * 0.25 + nd.phase) * 0.02) * h;
      if (k > 0.001) {
        const dx = mx - x, dy = my - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < radius && d > 0.001) {
          const f = 1 - d / radius;
          const pull = f * f * pullMax * k;
          x += (dx / d) * pull;
          y += (dy / d) * pull;
        }
      }
      pts[i] = { x, y, ci: nd.ci, size: nd.size };
    }
    // 连线：alpha 随距离线性衰减；n <= 96 时两两比较约 4500 次/帧
    ctx.lineWidth = 0.7;
    const lim2 = lim * lim;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= lim2) continue;
        const fade = 1 - Math.sqrt(d2) / lim;
        ctx.strokeStyle = rgba(PALETTE[a.ci], 0.22 * fade);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    // 节点
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      ctx.fillStyle = rgba(PALETTE[p.ci], 0.8);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1 + p.size * 1.8, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // 浅色主题 / 后台标签页 / 非登录页都不画：停掉整条 rAF 链，也不留上一帧的残影
  function enabled() {
    return active && isDark() && !document.hidden;
  }

  function halt() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    mouseOn = false;
    infl = 0; lastNow = 0;
    ctx.clearRect(0, 0, w || canvas.clientWidth || window.innerWidth, h || canvas.clientHeight || window.innerHeight);
  }

  function resume() {
    if (!enabled()) return;
    resize();
    if (reduce) draw(0, 0); // 静态一帧：不漂浮、不响应光标
    else if (!raf) frame(performance.now());
  }

  function frame(now) {
    if (!enabled()) { raf = 0; return; } // 主题刚切到浅色时，已排队的回调直接收尾
    if (!lastNow) lastNow = now;
    const dt = Math.max(0, Math.min(64, now - lastNow));
    lastNow = now;
    // 同一时间戳重复调用时 dt = 0 → infl 不变，重画结果保持一致
    infl += ((mouseOn ? 1 : 0) - infl) * Math.min(1, dt * 0.009);
    draw(now * 0.001, infl);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    active = true;
    if (enabled()) resume();
    else halt();
  }

  function stop() {
    active = false;
    halt();
  }

  // 光标追踪：触屏抬手后必须复位，否则粒子会一直聚在最后的触摸点
  if (!reduce) {
    window.addEventListener("pointermove", (e) => {
      if (!enabled()) return;
      mx = e.clientX - ox; my = e.clientY - oy; mouseOn = true;
    }, { passive: true });
    window.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") mouseOn = false; });
    window.addEventListener("pointercancel", () => { mouseOn = false; });
    document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) mouseOn = false; });
    window.addEventListener("blur", () => { mouseOn = false; });
  }

  // 主题切换即时生效：切到浅色停画并清空，切回深色重新起帧（含减少动效的静态帧）
  new MutationObserver(() => {
    if (!active) return;
    if (enabled()) resume();
    else halt();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  // 给 canvas.width 赋值会清空画布：动态模式下一帧自然补上，静态模式必须立刻补画
  window.addEventListener("resize", () => {
    if (!enabled()) return; // 浅色下不画，尺寸等切回深色时由 resume() 重算
    resize();
    if (reduce) draw(0, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (!active) return;
    if (enabled()) resume();
    else halt();
  });

  return { start, stop };
}

// ---------- 关闭浏览器表单数据保存与输入建议 ----------
// 站点里的输入框多数由 JS 模板动态生成，逐个模板写 autocomplete 容易漏；这里在页面启动和
// 每次 DOM 重建后统一补齐：普通字段 off（不记忆、不弹历史建议），口令字段 new-password
// （Chrome 会忽略 password 字段上的 off），并打上常见密码管理器的忽略标记。
// 静态 HTML 与所有模板仍各自显式声明，本函数只作兜底，保证以后新增字段不会重新漏配。
function disableAutofill(root) {
  if (!root || !root.querySelectorAll) return;
  const nodes = (root.matches && root.matches("input, select, textarea") ? [root] : [])
    .concat([...root.querySelectorAll("input, select, textarea")]);
  for (const el of nodes) {
    const secret = el.type === "password" || el.classList.contains("secret-masked");
    const want = secret ? "new-password" : "off";
    if (el.getAttribute("autocomplete") !== want) el.setAttribute("autocomplete", want);
    // 第三方密码管理器会无视 autocomplete，靠这组 data-* 标记才不会在输入框旁弹面板
    if (!el.hasAttribute("data-lpignore")) el.setAttribute("data-lpignore", "true");
    if (!el.hasAttribute("data-1p-ignore")) el.setAttribute("data-1p-ignore", "");
    if (!el.hasAttribute("data-form-type")) el.setAttribute("data-form-type", "other");
  }
}
function watchAutofill() {
  disableAutofill(document);
  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1) disableAutofill(n);
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// ---------- 启动 ----------
(async function init() {
  hardenSecretInputs();
  watchAutofill();
  applyTheme(currentTheme(), false); // 主题已由 index.html 头部脚本定好，这里只同步按钮文案
  constellationCtl = initConstellation();
  if (!state.token) return show("loginView");
  // 上次停在某个项目里：刷新后不再显示「正在恢复会话」卡片，直接进项目内铺骨架屏。
  // loadProjects() 与 enterProject() 的 tab=all 两段等待全程都有反馈；
  // 口令失效由 api() 的 401 处理踢回登录页，项目已不存在则回到项目中心（骨架屏会被换掉）。
  // 顶栏先用占位名，真实项目名等 loadProjects 回来后由 enterProject() 覆盖。
  if (state.projectId) {
    state.projectName = state.projectName || "团建管理";
    show("appView");
    renderChrome();
    showSkeleton();
    try {
      await afterLogin();
    } catch {
      logout();
    }
    return;
  }
  // 本地有 token 但没有上次项目（上次停在项目中心）：目的地是项目中心而非项目内，
  // 没有对应的骨架屏，仍用「正在恢复会话」卡片兜住这段等待。
  show("loginView"); // 显式进入登录视图：同时启动深色主题下的星座背景，供加载态复用
  setSessionRestoring(true);
  try {
    await afterLogin();
  } catch {
    logout();
  } finally {
    setSessionRestoring(false); // 成功切走、或失败退回登录页，都要还原口令卡片
  }
})();