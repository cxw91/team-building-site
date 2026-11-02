// 团建管理 —— 前端逻辑（多项目版）
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "¥" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
// 成员姓名一次可填多个：用逗号（中英文「,」「，」）分隔；同时兼容「、」等旧写法，避免历史习惯报错
const splitNames = (s) => String(s || "").split(/[,，、;；/|\s]+/).map((x) => x.trim()).filter(Boolean);

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
  tab: "overview",
  lastLogId: 0,
  newLogs: 0,
  timer: null,
  pending: null,        // 待确认删除：{ kind, id }
  editingMember: null,  // 正在编辑的成员 id
  editingFamily: null,  // 正在重命名的家庭 id
  editingProject: null, // 正在改名的项目 id
  projectStatus: "",    // 当前项目状态：进行中 / 已结束
  shopItems: [],        // 采购清单里的物品，供「登记一笔采购」的名称候选框使用
  purSuggestOpen: false,// 名称候选框是否展开
  purActive: -1,        // 候选框里键盘高亮到第几项
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "dark" ? "#1c1c1c" : "#eeeeee");
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
};

// 进入 / 退出加载态。原内容先存进 dataset，退出时原样还原（含行内图标与文字）。
function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.busy === "1") return; // 已在处理中，不重复进入
    btn.dataset.busy = "1";
    btn.dataset.raw = btn.innerHTML;
    btn.classList.add("is-loading");
    btn.setAttribute("aria-busy", "true");
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spin" aria-hidden="true"></span>${esc(label || "处理中…")}`;
  } else {
    if (btn.dataset.busy !== "1") return;
    delete btn.dataset.busy;
    btn.classList.remove("is-loading");
    btn.removeAttribute("aria-busy");
    if (btn.isConnected) {
      btn.disabled = false;
      if (btn.dataset.raw != null) btn.innerHTML = btn.dataset.raw;
    }
    delete btn.dataset.raw;
  }
}

// 一次性按钮 + 加载态：处理中重复点击直接忽略
async function runBusy(btn, label, fn) {
  if (btn && btn.dataset.busy === "1") return undefined;
  if (btn) setBusy(btn, true, label);
  try {
    return await fn();
  } finally {
    if (btn) setBusy(btn, false);
  }
}

// ---------- 手机软键盘适配 ----------
// 1) 口令 / 管理密码输入框：手机系统的密码管理器（华为密码保险箱、Android 自动填充、
//    部分浏览器）会无视 autocomplete="off"，只要字段是 type="password"，就在键盘上方
//    弹出「无用户名 / 管理密码」这样的凭据面板，位置还跟着键盘乱飘。支持文本遮蔽的
//    浏览器里改用 type="text"，就不再被当成密码字段；不支持则保持 type="password"。
function hardenSecretInputs() {
  if (!(window.CSS && CSS.supports && CSS.supports("-webkit-text-security", "disc"))) return;
  ["#passcode", "#adminPw"].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.type = "text";
    el.classList.add("secret-masked");
  });
}

// 2) 弹窗贴合可视区：软键盘弹出后 visualViewport 会收缩，只靠 position:fixed 屏幕居中
//    会把弹窗（连同它的输入框）压到键盘底下。这里让打开中的弹窗跟随 visualViewport 的
//    偏移与高度，可视高度不足时切成贴顶 + 内部滚动，并把被挡住的输入框滚回可视区。
const vv = window.visualViewport || null;
let openModal = null;

function syncModalToViewport() {
  if (!openModal || !vv) return;
  openModal.style.top = vv.offsetTop + "px";
  openModal.style.height = vv.height + "px";
  openModal.classList.toggle("modal-tight", vv.height <= 480);
}

function ensureFocusVisible() {
  if (!openModal || !vv) return;
  const el = document.activeElement;
  if (!el || !openModal.contains(el)) return;
  const box = el.getBoundingClientRect();
  const top = vv.offsetTop;
  const bottom = vv.offsetTop + vv.height;
  if (box.top < top + 8 || box.bottom > bottom - 12) el.scrollIntoView({ block: "center" });
}

function onViewportChange() {
  syncModalToViewport();
  ensureFocusVisible();
}

if (vv) {
  vv.addEventListener("resize", onViewportChange);
  vv.addEventListener("scroll", onViewportChange);
}
// 键盘可能在弹窗打开后才弹出：输入框获得焦点时再校正一次
document.addEventListener("focusin", () => setTimeout(onViewportChange, 80));

function setModalOpen(modal, open) {
  if (!modal) return;
  if (open) {
    if (openModal && openModal !== modal) setModalOpen(openModal, false);
    openModal = modal;
    modal.classList.remove("hidden");
    syncModalToViewport();
    setTimeout(onViewportChange, 300); // 键盘弹起有过渡动画，稍后再校正
  } else {
    modal.classList.add("hidden");
    modal.style.removeProperty("top");
    modal.style.removeProperty("height");
    modal.classList.remove("modal-tight");
    if (openModal === modal) openModal = null;
  }
}

// ---------- 管理权限密码弹窗 ----------
// 删除日志、清除全部日志、结束项目、删除项目、重启已结束项目这几类操作统一走这里：
// 弹出输入框 → 带上密码请求 → 密码不对可以重试 → 点取消则整个操作中止
function askAdmin(reason, errText = "") {
  return new Promise((resolve) => {
    const modal = $("#adminModal");
    $("#adminReason").textContent = reason;
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
  modal._resolve = null;
  setModalOpen(modal, false);
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
  if (!pw) return ($("#adminMsg").textContent = "请输入管理权限密码");
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

async function withAdmin(reason, run) {
  let errText = "";
  for (;;) {
    const pw = await askAdmin(reason, errText);
    if (pw == null) return false; // 用户取消了操作
    try {
      await run(pw);
      hideAdmin();
      return true;
    } catch (e) {
      // 只是密码不对就停在弹窗里重试；其他错误（如未配置密码）直接抛给调用方
      if (/管理权限密码/.test(e.message) && !/未配置/.test(e.message)) {
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
  clearInterval(state.timer);
  state.timer = null;
  state.lastLogId = 0;
  state.newLogs = 0;
  state.pending = null;
  state.editingMember = null;
  state.editingFamily = null;
  state.editingProject = null;
  show("loginView");
}

// ---------- 项目中心 ----------
async function loadProjects() {
  state.projects = (await api("/projects", { withProject: false })).data || [];
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
          <button class="ghost shrink" data-action="save-project" data-id="${p.id}">保存</button>
          <button class="link" data-action="cancel-project-edit">取消</button>
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
        ${dangerCell("project", p.id, "del-project")}
      </div>
    </div>`;
  });
  // 末尾始终保留一张「+」卡片：没有项目时它就是那张中间带加号的空卡片
  cards.push(`<button class="proj-add" data-action="new-project">
      <span class="plus">+</span>
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
    const res = await api("/projects", { method: "POST", body: { name, note, families }, withProject: false });
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

async function enterProject(id, name) {
  state.projectId = Number(id);
  state.projectName = name || (state.projects.find((p) => p.id === state.projectId) || {}).name || "团建管理";
  localStorage.setItem("tb_project", String(state.projectId));
  state.lastLogId = 0;
  state.newLogs = 0;
  state.pending = null;
  state.editingMember = null;
  state.editingFamily = null;
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

function showPick() {
  show("pickView");
  const ro = isReadonly();
  $("#pickSub").textContent = `项目：${state.projectName} · 选择你所属的家庭，用于记录操作日志` + (ro ? "（项目已结束，仅可查看）" : "");
  $("#newFamilyName").disabled = ro;
  $("#addFamilyBtn").disabled = ro;
  const list = $("#pickList");
  list.innerHTML = state.families.length
    ? state.families.map((f) => `<button class="pick" data-id="${f.id}">${esc(f.name)}</button>`).join("")
    : `<p class="hint">本项目还没有家庭，先在下面新增吧</p>`;
  list.querySelectorAll(".pick").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.familyId = Number(btn.dataset.id);
      localStorage.setItem(familyKey(state.projectId), String(state.familyId));
      showApp();
    })
  );
}

async function pickAddFamily() {
  const name = $("#newFamilyName").value.trim();
  if (!name) return ($("#pickMsg").textContent = "请输入家庭名称");
  const btn = $("#addFamilyBtn");
  if (btn.dataset.busy === "1") return; // 正在提交，忽略重复点击
  setBusy(btn, true, "新增中…");
  try {
    await api("/families", { method: "POST", body: { name } });
    $("#newFamilyName").value = "";
    $("#pickMsg").textContent = "";
    await loadFamilies();
    showPick();
  } catch (e) {
    $("#pickMsg").textContent = e.message;
  } finally {
    setBusy(btn, false);
    if (isReadonly()) btn.disabled = true; // 已结束项目保持只读
  }
}

// ---------- 主界面 ----------
function showApp() {
  show("appView");
  $("#projTitle").innerHTML = esc(state.projectName) + (isReadonly() ? ' <span class="tag off">已结束 · 只读</span>' : "");
  $("#whoami").textContent = "当前：" + familyName(state.familyId);
  $("#tabs").innerHTML = TABS.map(
    (t) =>
      `<button class="tab${t.key === state.tab ? " active" : ""}" data-tab="${t.key}">${t.label}` +
      (t.key === "logs" && state.newLogs ? `<span class="badge">${state.newLogs}</span>` : "") +
      `</button>`
  ).join("");
  $("#tabs")
    .querySelectorAll(".tab")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        state.tab = btn.dataset.tab;
        state.pending = null;
        if (state.tab === "logs") state.newLogs = 0;
        showApp();
        render();
      })
    );
  render();
  if (!state.timer) state.timer = setInterval(poll, 10000);
}

// ---------- 表单状态快照 ----------
// 定时同步会整体重建 #content，重建前先记住每个输入框里的值，重建后原样填回，
// 避免手机端正在填写的内容被同步刷新清空。
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
    const fn = RENDERERS[tab];
    if (!fn) return;
    const snap = snapshotForm();
    try {
      await fn();
    } catch (e) {
      if (state.tab === tab) $("#content").innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
    if (state.tab === tab) {
      restoreForm(snap);
      applyReadonly();
      return;
    }
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
    b.textContent = "项目已结束 · 当前为查看模式，内容不可修改；如需修改，请在项目中心用管理权限密码重启项目";
    c.prepend(b);
  }
}

// 定时轮询：同步别人的改动 + 拉取新日志
async function poll() {
  if (!state.token || $("#appView").classList.contains("hidden")) return;
  let changed = false;
  try {
    const logs = (await api("/logs?since=" + state.lastLogId)).data || [];
    if (logs.length) {
      state.lastLogId = logs[logs.length - 1].id;
      changed = true;
      // 日志页本身就在展示最新数据，直接重绘；其他页只加角标，不打断正在填写的内容
      if (state.tab !== "logs") {
        state.newLogs += logs.length;
        updateBadge();
      }
    }
  } catch {}
  // 没有新数据绝不重建页面：手机端每隔 10 秒重绘一次会把没提交的输入清空
  if (!changed) return;
  // 正在输入控件里打字时不打断
  const ae = document.activeElement;
  if (ae && $("#content").contains(ae) && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) return;
  render();
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
    tab.appendChild(span);
  }
}

// ---------- 概览 ----------
async function renderOverview() {
  const o = (await api("/overview")).data;
  const st = (await api("/settlement")).data;
  const logs = (await api("/logs?since=0")).data || [];
  state.lastLogId = logs.length ? logs[logs.length - 1].id : 0;
  const recent = logs.slice(-6).reverse();
  $("#content").innerHTML = `
    <div class="cards">
      <div class="card"><div class="num">${money(o.total_amount)}</div><div class="lbl">总花费</div></div>
      <div class="card"><div class="num">${st.family_count ? money(st.share) : "—"}</div><div class="lbl">每家应摊（${st.family_count} 家均分）</div></div>
      <div class="card"><div class="num">${o.family_count}</div><div class="lbl">家庭数</div></div>
      <div class="card"><div class="num">${o.member_count}</div><div class="lbl">成员数</div></div>
      <div class="card"><div class="num">${o.carry_done}/${o.carry_total}</div><div class="lbl">携带已带</div></div>
      <div class="card"><div class="num">${o.shopping_done}/${o.shopping_total}</div><div class="lbl">采购已购</div></div>
    </div>
    <h3>最近操作</h3>
    <div class="logs">${recent.length ? recent.map(logHtml).join("") : '<div class="empty">暂无记录</div>'}</div>
  `;
}

function logHtml(l, deletable = false) {
  return `<div class="log-item">
      <div class="log-time">${fmtTime(l.created_at)}</div>
      <div class="log-body"><span class="log-who">${esc(l.actor_name || "系统")}</span> ${esc(l.action)}${l.detail ? "：" + esc(l.detail) : ""}</div>
      ${deletable ? `<button class="link danger log-del" data-action="del-log" data-id="${l.id}">删除</button>` : ""}
    </div>`;
}

// ---------- 成员（手动添加 / 修改 / 删除） ----------
async function renderMembers() {
  const mems = (await api("/members")).data || [];
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
                 <button class="ghost shrink" data-action="save-family" data-id="${f.id}">保存</button>
                 <button class="link" data-action="cancel-family-edit">取消</button>
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
              <button class="ghost shrink" data-action="save-member" data-id="${m.id}">保存</button>
              <button class="link" data-action="cancel-member-edit">取消</button>
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
async function renderCarry() {
  const items = (await api("/carry-items")).data || [];
  const mine = state.familyId;
  const groups = state.families
    .map((f) => {
      const list = items.filter((i) => i.family_id === f.id);
      const isMine = f.id === mine;
      return `<div class="section">
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
async function renderShopping() {
  const items = (await api("/shopping-items")).data || [];
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
      <p class="hint" style="margin:8px 0 0">点「接任务」即可认领某一项，别人就能看到是你家在负责；只有接单的家庭能取消。「待购 / 已购」由「采购记录」自动同步：登记了采购就变已购，删掉那笔记录就回到待购，并清空接单家庭、回到没人接任务。已经登记过采购记录的项（「已购」）不能从清单里删除，「删除」按钮会变成不可点；把对应的采购记录删掉后它回到「未接单 + 待购」，删除就恢复可用。</p>
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
  }, 150);
});
$("#content").addEventListener("mousedown", (e) => {
  // 候选项目不可获得焦点，按下时别让输入框失焦（否则会先收起来再点不到）
  if (e.target.closest && e.target.closest('#pur-suggest li[role="option"]')) e.preventDefault();
});
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
async function renderPurchases() {
  const list = (await api("/purchases")).data || [];
  const shopItems = (await api("/shopping-items")).data || [];
  state.shopItems = shopItems;   // 供名称候选框过滤
  state.purSuggestOpen = false;  // #content 会被重建成新 DOM，候选框回到收起状态
  state.purActive = -1;
  const perFamily = {};
  list.forEach((p) => (perFamily[p.family_id] = (perFamily[p.family_id] || 0) + (Number(p.amount) || 0)));
  const summary = state.families
    .map((f) => `<span class="tag" style="margin-right:6px">${esc(f.name)} ${money(perFamily[f.id] || 0)}</span>`)
    .join("");
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
      <p class="hint" style="margin:8px 0 0">只记当前家庭「${esc(familyName(state.familyId))}」已经接单、且还没登记过采购的项：点名称框右侧箭头（或点输入框）展开候选选一个，不能自己新增名称；登记后该项在清单里变成「已购」，也不再出现在候选里。</p>
    </div>
    <div class="section">
      <div class="section-head"><span class="title">各家采购金额</span></div>
      <div>${summary || '<span class="hint">还没有家庭</span>'}</div>
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
}

// ---------- 结算 ----------
async function renderSettlement() {
  const s = (await api("/settlement")).data;
  $("#content").innerHTML = `
    <div class="cards" style="margin-bottom:12px">
      <div class="card"><div class="num">${money(s.total)}</div><div class="lbl">总花费</div></div>
      <div class="card"><div class="num">${money(s.share)}</div><div class="lbl">每家应摊（${s.family_count} 家均分）</div></div>
    </div>
    <div class="section">
      <div class="section-head"><span class="title">每家结算</span><span class="hint">分摊口径：${esc(s.basis || "按家庭数均分")}</span></div>
      <table>
        <thead><tr><th>家庭</th><th class="r">已垫付</th><th class="r">应摊</th><th class="r">差额</th></tr></thead>
        <tbody>
          ${s.detail
            .map(
              (d) => `<tr>
                <td>${esc(d.name)}</td>
                <td class="r">${money(d.paid)}</td>
                <td class="r">${money(d.share)}</td>
                <td class="r ${d.balance > 0 ? "pos" : d.balance < 0 ? "neg" : ""}">${money(d.balance)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
      <p class="hint" style="margin-top:10px">差额为正 = 该家庭多垫付、应收回；为负 = 应补付。</p>
    </div>
    <div class="section">
      <div class="section-head"><span class="title">结算建议</span></div>
      ${s.transfers.length
        ? s.transfers
            .map((t) => `<div class="row"><div class="main"><span class="name">${esc(t.from)}</span> 应付给 <span class="name">${esc(t.to)}</span></div><span class="amt">${money(t.amount)}</span></div>`)
            .join("")
        : '<div class="empty">无需转账，账目已平</div>'}
    </div>`;
}

// ---------- 日志 ----------
async function renderLogs() {
  const logs = (await api("/logs?since=0")).data || [];
  state.lastLogId = logs.length ? logs[logs.length - 1].id : 0;
  state.newLogs = 0;
  updateBadge();
  const canDel = !isReadonly();
  $("#content").innerHTML = logs.length
    ? `<div class="section-head" style="margin-bottom:6px">
         <span class="hint">共 ${logs.length} 条${canDel ? " · 删除/清除需要管理权限密码" : ""}</span>
         ${canDel ? `<button class="link danger" data-action="clear-logs">清除全部日志</button>` : ""}
       </div>
       <div class="logs">${logs.slice().reverse().map((l) => logHtml(l, canDel)).join("")}</div>`
    : '<div class="empty">暂无操作记录</div>';
}

const RENDERERS = {
  overview: renderOverview,
  members: renderMembers,
  carry: renderCarry,
  shopping: renderShopping,
  purchases: renderPurchases,
  settlement: renderSettlement,
  logs: renderLogs,
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
      }
    } else if (action === "cancel-del") {
      state.pending = null;
    } else if (action === "del-member" || action === "del-family" || action === "del-carry" || action === "del-shop" || action === "del-purchase") {
      state.pending = { kind, id: Number(id) };
    } else if (action === "del-log") {
      const ok = await withAdmin("删除这条操作日志", async (pw) => {
        await api("/logs/" + id, { method: "DELETE", adminPw: pw });
      });
      if (ok) toast("日志已删除");
    } else if (action === "clear-logs") {
      // 一键清除本项目全部日志：不可恢复，清除前必须输入管理权限密码
      const ok = await withAdmin("清除本项目全部操作日志（清除后不可恢复）", async (pw) => {
        await api("/logs", { method: "DELETE", adminPw: pw });
      });
      if (ok) {
        state.lastLogId = 0;
        state.newLogs = 0;
        toast("全部日志已清除");
      }
    } else if (action === "add-member") {
      const names = splitNames($("#mem-name-" + fid).value);
      if (!names.length) return toast("请输入成员姓名");
      const note = $("#mem-note-" + fid).value.trim();
      for (const n of names) await api("/members", { method: "POST", body: { name: n, family_id: Number(fid), note } });
      clearFields("mem-name-" + fid, "mem-note-" + fid);
    } else if (action === "edit-member") {
      state.editingMember = Number(id);
      state.editingFamily = null;
    } else if (action === "cancel-member-edit") {
      state.editingMember = null;
    } else if (action === "save-member") {
      const name = $("#mem-edit-name-" + id).value.trim();
      if (!name) return toast("请输入成员姓名");
      await api("/members/" + id, { method: "PUT", body: { name, note: $("#mem-edit-note-" + id).value.trim() } });
      state.editingMember = null;
    } else if (action === "edit-family") {
      state.editingFamily = Number(id);
      state.editingMember = null;
    } else if (action === "cancel-family-edit") {
      state.editingFamily = null;
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
      const name = $("#carry-name").value.trim();
      if (!name) return toast("请输入物品名称");
      await api("/carry-items", { method: "POST", body: { name, quantity: $("#carry-qty").value.trim() } });
      clearFields("carry-name", "carry-qty");
    } else if (action === "toggle-carry") {
      await api("/carry-items/" + id, { method: "PUT", body: { status } });
    } else if (action === "add-shop") {
      const name = $("#shop-name").value.trim();
      if (!name) return toast("请输入采购项名称");
      await api("/shopping-items", {
        method: "POST",
        body: { name, quantity: $("#shop-qty").value.trim(), unit: $("#shop-unit").value.trim() },
      });
      clearFields("shop-name", "shop-qty", "shop-unit");
    } else if (action === "claim-shop") {
      const r = await api("/shopping-items/" + id, { method: "PUT", body: { claim: true } });
      toast("已接下任务" + (r.claimed_by ? "：" + r.claimed_by : ""));
    } else if (action === "unclaim-shop") {
      await api("/shopping-items/" + id, { method: "PUT", body: { claim: false } });
      toast("已取消接任务");
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
    if (action === "del-fam-row") {
      const row = btn.closest(".fam-row");
      const rows = $("#famRows");
      if (rows.children.length > 1) row.remove();
      else row.querySelectorAll("input").forEach((i) => (i.value = ""));
      return;
    }
    if (action === "new-project") {
      openNewProj();
      return;
    }
    if (action === "confirm-del") {
      state.pending = null;
      const target = state.projects.find((x) => x.id === Number(id));
      const label = target ? target.name : "该项目";
      const ok = await withAdmin(`删除项目「${label}」及其全部数据`, async (pw) => {
        await api("/projects/" + id, { method: "DELETE", withProject: false, adminPw: pw });
      });
      if (!ok) return renderProjects();
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
    if (action === "cancel-del") {
      state.pending = null;
      return renderProjects();
    }
    if (action === "del-project") {
      state.pending = { kind: "project", id: Number(id) };
      return renderProjects();
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
        isRestart ? `重启已结束的项目「${label}」` : `结束项目「${label}」（结束后项目内只读，需用管理权限密码才能重启）`,
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
      await api("/projects/" + id, { method: "PUT", body: { name: newName }, withProject: false });
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
  if (e.target === $("#newProjModal")) closeNewProj();
});
$("#addFamilyBtn").addEventListener("click", pickAddFamily);
$("#logoutBtn").addEventListener("click", logout);
$("#logoutBtn2").addEventListener("click", logout);
$("#backHomeBtn").addEventListener("click", showHome);
$("#homeBtn").addEventListener("click", showHome);
$("#switchFamilyBtn").addEventListener("click", () =>
  runBusy($("#switchFamilyBtn"), "加载中…", async () => {
    await loadFamilies();
    showPick();
  })
);

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