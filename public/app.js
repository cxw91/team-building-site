// 团建管理 —— 前端逻辑（多项目版）
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "¥" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
// 成员姓名一次可填多个：用「、」「,」「，」「;」「/」或空格分隔
const splitNames = (s) => String(s || "").split(/[、,，;；/|\s]+/).map((x) => x.trim()).filter(Boolean);

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
};

const familyKey = (pid) => "tb_family_" + pid;

// ---------- 接口封装 ----------
async function api(path, { method = "GET", body, withProject = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (state.token) headers["authorization"] = "Bearer " + state.token;
  if (withProject && state.projectId) headers["x-project-id"] = String(state.projectId);
  if (state.familyId) headers["x-family-id"] = String(state.familyId);
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
    `<input class="fam-members" placeholder="成员姓名，用「、」分隔（可留空）" />` +
    `<button class="link" data-action="del-fam-row">移除</button>`;
  return div;
}

function showHome() {
  show("homeView");
  state.pending = null;
  const rows = $("#famRows");
  if (!rows.children.length) for (let i = 0; i < 3; i++) rows.appendChild(renderFamRow());
  $("#homeMsg").textContent = "";
  renderProjects();
}

function renderProjects() {
  const list = state.projects || [];
  $("#projCount").textContent = list.length ? list.length + " 个项目" : "";
  if (!list.length) {
    $("#projList").innerHTML = '<div class="empty">还没有项目，先在上方新建一个吧</div>';
    return;
  }
  $("#projList").innerHTML = list
    .map((p) => {
      const meta =
        `${p.family_count} 个家庭 · ${p.member_count} 位成员 · 已花费 ${money(p.total_amount)} · ` +
        `创建于 ${fmtTime(p.created_at)}` +
        (p.note ? " · " + esc(p.note) : "");
      if (state.editingProject === p.id) {
        return `<div class="proj-card">
          <div class="main">
            <input id="proj-edit-name-${p.id}" value="${esc(p.name)}" />
          </div>
          <button class="ghost shrink" data-action="save-project" data-id="${p.id}">保存</button>
          <button class="link" data-action="cancel-project-edit">取消</button>
        </div>`;
      }
      const done = p.status === "已结束";
      return `<div class="proj-card${done ? " done" : ""}">
        <div class="main">
          <div class="name">${esc(p.name)} <span class="tag${done ? " off" : ""}">${esc(p.status)}</span></div>
          <div class="meta">${meta}</div>
        </div>
        <button class="primary shrink" data-action="open-project" data-id="${p.id}" data-name="${esc(p.name)}">进入</button>
        <button class="ghost shrink" data-action="toggle-project" data-id="${p.id}" data-status="${done ? "进行中" : "已结束"}">${done ? "重启" : "结束"}</button>
        <button class="link" data-action="edit-project" data-id="${p.id}">改名</button>
        ${dangerCell("project", p.id, "del-project")}
      </div>`;
    })
    .join("");
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
  try {
    const res = await api("/projects", { method: "POST", body: { name, note, families }, withProject: false });
    $("#projName").value = "";
    $("#projNote").value = "";
    $("#famRows").innerHTML = "";
    $("#homeMsg").textContent = "";
    await loadProjects();
    toast(`项目已创建：${res.family_count} 个家庭、${res.member_count} 位成员`);
    await enterProject(res.id, name);
  } catch (e) {
    $("#homeMsg").textContent = e.message;
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
  // 项目名可能已改名，取一次最新的
  try {
    const d = (await api("/projects/" + state.projectId, { withProject: false })).data;
    if (d && d.project) state.projectName = d.project.name;
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
function familyOptions(selected) {
  return state.families
    .map((f) => `<option value="${f.id}"${f.id === selected ? " selected" : ""}>${esc(f.name)}</option>`)
    .join("");
}

function showPick() {
  show("pickView");
  $("#pickSub").textContent = `项目：${state.projectName} · 选择你所属的家庭，用于记录操作日志`;
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
  try {
    await api("/families", { method: "POST", body: { name } });
    $("#newFamilyName").value = "";
    $("#pickMsg").textContent = "";
    await loadFamilies();
    showPick();
  } catch (e) {
    $("#pickMsg").textContent = e.message;
  }
}

// ---------- 主界面 ----------
function showApp() {
  show("appView");
  $("#projTitle").textContent = state.projectName;
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

function render() {
  const fn = RENDERERS[state.tab];
  if (fn) fn().catch((e) => ($("#content").innerHTML = `<div class="empty">${esc(e.message)}</div>`));
}

// 定时轮询：同步别人的改动 + 拉取新日志
async function poll() {
  if (!state.token || $("#appView").classList.contains("hidden")) return;
  try {
    const logs = (await api("/logs?since=" + state.lastLogId)).data || [];
    if (logs.length) {
      state.lastLogId = logs[logs.length - 1].id;
      if (state.tab === "logs") render();
      else {
        state.newLogs += logs.length;
        updateBadge();
      }
    }
  } catch {}
  // 正在输入时不打断，避免刷新表单
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

function logHtml(l) {
  return `<div class="log-item">
      <div class="log-time">${fmtTime(l.created_at)}</div>
      <div class="log-body"><span class="log-who">${esc(l.actor_name || "系统")}</span> ${esc(l.action)}${l.detail ? "：" + esc(l.detail) : ""}</div>
    </div>`;
}

// ---------- 成员（手动添加 / 修改 / 删除） ----------
async function renderMembers() {
  const mems = (await api("/members")).data || [];
  const groups = state.families
    .map((f) => {
      const list = mems.filter((m) => m.family_id === f.id);
      const head =
        state.editingFamily === f.id
          ? `<div class="section-head">
               <input id="fam-edit-name-${f.id}" value="${esc(f.name)}" style="max-width:220px" />
               <span>
                 <button class="ghost shrink" data-action="save-family" data-id="${f.id}">保存</button>
                 <button class="link" data-action="cancel-family-edit">取消</button>
               </span>
             </div>`
          : `<div class="section-head">
               <span class="title">${esc(f.name)}</span>
               <span class="hint">${list.length} 人
                 <button class="link" data-action="edit-family" data-id="${f.id}">重命名</button>
                 ${dangerCell("family", f.id, "del-family", "删除家庭")}
               </span>
             </div>`;
      const rows = list
        .map((m) => {
          if (state.editingMember === m.id) {
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
            <button class="link" data-action="edit-member" data-id="${m.id}">修改</button>
            ${dangerCell("member", m.id, "del-member")}
          </div>`;
        })
        .join("");
      return `<div class="section">
        ${head}
        ${list.length ? rows : '<div class="empty">暂无成员</div>'}
        <div class="form-row" style="margin-top:10px">
          <input id="mem-name-${f.id}" placeholder="成员姓名（可一次填多个，用「、」分隔）" />
          <input id="mem-note-${f.id}" placeholder="备注（忌口/过敏）" />
          <button class="ghost shrink" data-action="add-member" data-fid="${f.id}">添加</button>
        </div>
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
  $("#content").innerHTML = `
    <div class="section">
      <div class="section-head"><span class="title">采购清单</span><span class="hint">${items.filter((i) => i.status === "待购").length} 项待购</span></div>
      <div class="form-row">
        <input id="shop-name" placeholder="采购项名称" />
        <input id="shop-qty" class="shrink" style="flex:0 0 70px" placeholder="数量" />
        <input id="shop-unit" class="shrink" style="flex:0 0 70px" placeholder="单位" />
        <button class="ghost shrink" data-action="add-shop">添加</button>
      </div>
      <div style="margin-top:10px">
        ${items.length
          ? items
              .map(
                (i) => `<div class="row">
                  <div class="main"><div class="name">${esc(i.name)}</div>
                    <div class="meta">${[i.quantity && esc(i.quantity), i.unit && esc(i.unit), i.note && esc(i.note)].filter(Boolean).join(" · ")}</div></div>
                  <button class="pill${i.status === "已购" ? " done" : ""}" data-action="toggle-shop" data-id="${i.id}" data-status="${i.status === "已购" ? "待购" : "已购"}">${esc(i.status)}</button>
                  ${dangerCell("shopping", i.id, "del-shop")}
                </div>`
              )
              .join("")
          : '<div class="empty">清单为空</div>'}
      </div>
    </div>`;
}

// ---------- 采购记录 ----------
async function renderPurchases() {
  const list = (await api("/purchases")).data || [];
  const shopItems = (await api("/shopping-items")).data || [];
  const perFamily = {};
  list.forEach((p) => (perFamily[p.family_id] = (perFamily[p.family_id] || 0) + (Number(p.amount) || 0)));
  const summary = state.families
    .map((f) => `<span class="tag" style="margin-right:6px">${esc(f.name)} ${money(perFamily[f.id] || 0)}</span>`)
    .join("");
  $("#content").innerHTML = `
    <div class="section">
      <div class="section-head"><span class="title">登记一笔采购</span></div>
      <div class="form-row">
        <input id="pur-item" list="shop-list" placeholder="物品名称" />
        <datalist id="shop-list">${shopItems.map((s) => `<option value="${esc(s.name)}"></option>`).join("")}</datalist>
        <input id="pur-amount" class="shrink" style="flex:0 0 90px" type="number" min="0" step="0.01" placeholder="金额" />
        <select id="pur-family">${familyOptions(state.familyId)}</select>
        <button class="ghost shrink" data-action="add-purchase">登记</button>
      </div>
      <p class="hint" style="margin:8px 0 0">默认记为你所在家庭购买；若清单里已有同名项，会自动标记为已购。</p>
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
                ${dangerCell("purchase", p.id, "del-purchase")}
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
  $("#content").innerHTML = logs.length
    ? `<div class="logs">${logs.slice().reverse().map(logHtml).join("")}</div>`
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
  if (!btn) return;
  const { action, id, fid, status, kind } = btn.dataset;
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
    } else if (action === "add-member") {
      const names = splitNames($("#mem-name-" + fid).value);
      if (!names.length) return toast("请输入成员姓名");
      const note = $("#mem-note-" + fid).value.trim();
      for (const n of names) await api("/members", { method: "POST", body: { name: n, family_id: Number(fid), note } });
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
      await loadFamilies();
    } else if (action === "add-carry") {
      const name = $("#carry-name").value.trim();
      if (!name) return toast("请输入物品名称");
      await api("/carry-items", { method: "POST", body: { name, quantity: $("#carry-qty").value.trim() } });
    } else if (action === "toggle-carry") {
      await api("/carry-items/" + id, { method: "PUT", body: { status } });
    } else if (action === "add-shop") {
      const name = $("#shop-name").value.trim();
      if (!name) return toast("请输入采购项名称");
      await api("/shopping-items", {
        method: "POST",
        body: { name, quantity: $("#shop-qty").value.trim(), unit: $("#shop-unit").value.trim() },
      });
    } else if (action === "toggle-shop") {
      await api("/shopping-items/" + id, { method: "PUT", body: { status } });
    } else if (action === "add-purchase") {
      const itemName = $("#pur-item").value.trim();
      const amount = Number($("#pur-amount").value);
      if (!itemName) return toast("请输入物品名称");
      if (!amount || amount <= 0) return toast("请输入金额");
      const matched = (await api("/shopping-items")).data.find((s) => s.name === itemName);
      await api("/purchases", {
        method: "POST",
        body: { item_name: itemName, amount, family_id: Number($("#pur-family").value), item_id: matched ? matched.id : null },
      });
    }
    render();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- 项目中心事件委托 ----------
$("#homeView").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const { action, id, name, status } = btn.dataset;
  try {
    if (action === "del-fam-row") {
      const row = btn.closest(".fam-row");
      const rows = $("#famRows");
      if (rows.children.length > 1) row.remove();
      else row.querySelectorAll("input").forEach((i) => (i.value = ""));
      return;
    }
    if (action === "confirm-del") {
      state.pending = null;
      await api("/projects/" + id, { method: "DELETE", withProject: false });
      if (Number(id) === state.projectId) {
        state.projectId = null;
        state.projectName = "团建管理";
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
      await api("/projects/" + id, { method: "PUT", body: { status }, withProject: false });
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
  }
});

// ---------- 顶部 / 表单按钮 ----------
$("#loginBtn").addEventListener("click", doLogin);
$("#passcode").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
$("#addFamRowBtn").addEventListener("click", () => $("#famRows").appendChild(renderFamRow()));
$("#createProjBtn").addEventListener("click", createProject);
$("#addFamilyBtn").addEventListener("click", pickAddFamily);
$("#logoutBtn").addEventListener("click", logout);
$("#logoutBtn2").addEventListener("click", logout);
$("#backHomeBtn").addEventListener("click", showHome);
$("#homeBtn").addEventListener("click", showHome);
$("#switchFamilyBtn").addEventListener("click", async () => {
  await loadFamilies();
  showPick();
});

// ---------- 启动 ----------
(async function init() {
  if (!state.token) return show("loginView");
  try {
    await afterLogin();
  } catch {
    logout();
  }
})();