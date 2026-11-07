// 团建管理网站 —— Pages Functions 统一 API 入口（多项目版）
// 路由：/api/<route>[/<id>]
// 鉴权：全队单一共享口令。登录后返回 token，后续请求携带 Authorization: Bearer <token>
// 项目上下文：除 /auth/login、/health、/projects 外，其余接口都需要 X-Project-Id 头（或 ?project_id=），
//             所有读写都限定在该项目内，不同项目之间数据互不影响。
// 操作身份：进入项目后选择“我属于哪个家庭”，通过 X-Family-Id 头传入，日志记到家庭粒度。
// 两套密码，各管一段：
//  1) 超级密码（环境变量 SUPER_PASSCODE）：只管「口令管理」——登录页列出 / 新增 / 修改 / 删除口令；
//     未配置 SUPER_PASSCODE 时口令管理直接停用。
//  2) 每个口令自己的「管理员密码」（存在 passcodes.admin_passcode，同一口令下的项目共用它）：
//     用于项目级高风险操作 ——
//   1) 删除单条日志        DELETE /api/logs/<id>
//   2) 清除项目全部日志    DELETE /api/logs      （不带 id，仅清当前项目）
//   3) 删除项目（历史项目）DELETE /api/projects/<id>
//   4) 结束项目            PUT /api/projects/<id>  状态 进行中 → 已结束
//   5) 重启已结束的项目    PUT /api/projects/<id>  状态 已结束 → 进行中
//   6) 设置预算 / 任务奖金、切换结算分摊方式  PUT /api/projects/<id>
//   调用时通过 X-Admin-Passcode 头传入，密码不对返回 403，未配置该环境变量返回 500。
// 已结束项目只读：status 为「已结束」的项目，除读取外的一切写操作都返回 403；
//   唯一出路是用管理权限密码把项目重启为「进行中」。

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function err(message, status = 400) {
  return json({ ok: false, error: message }, status);
}
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
function toId(v) {
  const n = typeof v === "number" ? v : parseInt(String(v == null ? "" : v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// 家庭人数：只允许 0～999 的整数。空值按 0（允许先建家庭、之后再补人数），
// 非法值返回 null，由调用方回 400，避免把字符串/负数悄悄写进库里。
function parseMemberCount(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 999) return null;
  return n;
}
const SPLIT_LABEL = { family: "按家庭数均分", person: "按人数均分" };

// ---------- 鉴权与上下文 ----------
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// 登录令牌绑定到「哪个口令」（passcodes 表主键 id）：
//   token = "<id>.<sha256('team-building::<id>::<passcode>')>"
// 因此：改口令文本会让旧令牌失效（需重新登录），只改备注名则不受影响。
async function tokenFor(row) {
  return row.id + "." + (await sha256Hex("team-building::" + row.id + "::" + (row.passcode || "")));
}
// 解析请求里的令牌并找回它对应的口令行；无效 / 已失效都返回 null
async function authPasscode(request, env) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const id = toId(token.slice(0, dot));
  if (!id) return null;
  const row = await env.DB.prepare("SELECT id, passcode, name, admin_passcode FROM passcodes WHERE id = ?").bind(id).first();
  if (!row) return null;
  return token === (await tokenFor(row)) ? row : null;
}
function actorFamilyId(request) {
  return toId(request.headers.get("x-family-id"));
}
function requestProjectId(request) {
  const h = toId(request.headers.get("x-project-id"));
  if (h) return h;
  try {
    return toId(new URL(request.url).searchParams.get("project_id"));
  } catch {
    return null;
  }
}

// ---------- 超级密码（只用于「口令管理」：列出 / 新增 / 修改 / 删除口令）----------
// 独立环境变量 SUPER_PASSCODE；未配置时口令管理直接停用（拒绝并提示）。
// 返回 null 表示校验通过；返回 Response 表示应直接把它作为结果返回。
function requireSuper(request, env) {
  const expected = String(env.SUPER_PASSCODE || "").trim();
  if (!expected) {
    return err(
      "服务器未配置超级密码（环境变量 SUPER_PASSCODE），口令管理暂不可用；请先在 Cloudflare 后台或本地 .dev.vars 配置后重试",
      500
    );
  }
  const provided = String(request.headers.get("x-admin-passcode") || "").trim();
  if (!provided) return err("该操作需要超级密码", 403);
  if (provided !== expected) return err("超级密码不正确", 403);
  return null;
}

// ---------- 口令的管理员密码（同一口令下的所有项目共用它）----------
// 项目级高风险操作（新建 / 改名 / 结束 / 重启 / 删除项目，删除 / 清空日志，设置预算）用它校验；
// 只用「当前登录口令」自己的管理员密码，不回退全局 ADMIN_PASSCODE。
function requireProjectAdmin(request, me) {
  const expected = String((me && me.admin_passcode) || "").trim();
  if (!expected) {
    return err("该口令还没有设置管理员密码，请先在登录页「管理口令」里为本口令设置", 403);
  }
  const provided = String(request.headers.get("x-admin-passcode") || "").trim();
  if (!provided) return err("该操作需要本口令的管理员密码", 403);
  if (provided !== expected) return err("管理员密码不正确", 403);
  return null;
}

// ---------- 家庭自助约束 ----------
// 家庭 / 成员 的写操作只能由「该家庭自己」发起：请求头里的 X-Family-Id 必须与目标家庭一致。
// 返回 null 表示校验通过；返回 Response 表示应直接把它作为结果返回。
function requireOwnFamily(request, familyId) {
  const myFamily = actorFamilyId(request);
  if (!myFamily) return err("请先选择你所属的家庭", 403);
  if (Number(myFamily) !== Number(familyId)) return err("只能管理自己家庭的信息，其他家庭只能查看", 403);
  return null;
}

// ---------- 操作日志（家庭粒度；项目创建/删除等无家庭上下文的记到“系统”）----------
async function addLog(env, projectId, { familyId, action, targetType, targetId, detail }) {
  let familyName = "系统";
  if (familyId) {
    const f = await env.DB.prepare("SELECT name FROM families WHERE id = ?").bind(familyId).first();
    familyName = f ? f.name : "系统";
  }
  await env.DB
    .prepare(
      "INSERT INTO logs (project_id, actor_family_id, actor_name, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(projectId, familyId ?? null, familyName, action, targetType || "", targetId ?? null, detail || "")
    .run();
}

// ---------- 口令（注册表）与数据隔离 ----------
// 一个口令 = 一个租户：项目的归属记在 projects.passcode_id，登录某口令只能看到本口令名下的项目。
// schema.sql 之外再做一次幂等的「自愈」：表 / 字段缺失时补建；口令表为空时用环境变量口令建一条
// 「默认口令」，并把还没有归属的历史项目都归到它名下，保证升级后旧项目依旧可见（每次进程只跑一次）。
let schemaEnsured = false;
async function ensureSchema(env) {
  if (schemaEnsured) return;
  try {
    await env.DB
      .prepare(
        "CREATE TABLE IF NOT EXISTS passcodes (id INTEGER PRIMARY KEY AUTOINCREMENT, passcode TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', admin_passcode TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))"
      )
      .run();
    try {
      await env.DB.prepare("ALTER TABLE projects ADD COLUMN passcode_id INTEGER").run();
    } catch {}
    try {
      await env.DB.prepare("ALTER TABLE passcodes ADD COLUMN admin_passcode TEXT NOT NULL DEFAULT ''").run();
    } catch {}
    // 任务奖金版升级：projects 补 bonus 字段（已存在时会抛错，忽略即可）
    try {
      await env.DB.prepare("ALTER TABLE projects ADD COLUMN bonus REAL NOT NULL DEFAULT 0").run();
    } catch {}
    // 「家庭人数 + 分摊方式」版升级：
    //   families.member_count —— 每个家庭的人数；备注复用已有的 families.note
    //   projects.split_mode   —— family（按家庭数均分，默认）/ person（按人数均分）
    // 历史库 upgrade 时，只有「这一列是本次真的新建的」才把旧 members 表的行数回填成人数，
    // 否则用户主动设成 0 人的家庭会在每次进程启动时被旧数据改回去。
    let memberCountAdded = false;
    try {
      await env.DB.prepare("ALTER TABLE families ADD COLUMN member_count INTEGER NOT NULL DEFAULT 0").run();
      memberCountAdded = true;
    } catch {}
    if (memberCountAdded) {
      try {
        await env.DB
          .prepare("UPDATE families SET member_count = (SELECT COUNT(*) FROM members m WHERE m.family_id = families.id)")
          .run();
      } catch {}
    }
    try {
      await env.DB.prepare("ALTER TABLE projects ADD COLUMN split_mode TEXT NOT NULL DEFAULT 'family'").run();
    } catch {}
    const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM passcodes").first();
    if ((!c || !c.c) && String(env.PASSCODE || "").trim()) {
      await env.DB
        .prepare("INSERT INTO passcodes (passcode, name, admin_passcode) VALUES (?, ?, ?)")
        .bind(String(env.PASSCODE).trim(), "默认口令", String(env.ADMIN_PASSCODE || "").trim())
        .run();
    }
    // 老库升级：还没有管理员密码的口令，先用当前 ADMIN_PASSCODE 初始化（之后可在「管理口令」里各自改）
    const legacyAdmin = String(env.ADMIN_PASSCODE || "").trim();
    if (legacyAdmin) {
      await env.DB
        .prepare("UPDATE passcodes SET admin_passcode = ? WHERE admin_passcode IS NULL OR admin_passcode = ''")
        .bind(legacyAdmin)
        .run();
    }
    const def = await env.DB.prepare("SELECT id FROM passcodes ORDER BY id LIMIT 1").first();
    if (def) {
      await env.DB.prepare("UPDATE projects SET passcode_id = ? WHERE passcode_id IS NULL").bind(def.id).run();
    }
    schemaEnsured = true;
  } catch {}
}

// ---------- 口令管理（登录页也要用，因此不要求登录令牌，只认超级密码 SUPER_PASSCODE）----------
async function handlePasscodes(env, method, id, request) {
  const denied = requireSuper(request, env);
  if (denied) return denied;

  if (method === "GET" && !id) {
    const rows = await env.DB
      .prepare(
        `SELECT pc.id, pc.passcode, pc.name, pc.admin_passcode,
           (SELECT COUNT(*) FROM projects p WHERE p.passcode_id = pc.id) AS project_count
         FROM passcodes pc
         ORDER BY pc.id`
      )
      .all();
    return json({ ok: true, data: rows.results });
  }

  if (method === "POST") {
    const b = await readJson(request);
    const passcode = String((b && b.passcode) || "").trim();
    const name = String((b && b.name) || "").trim();
    const adminPasscode = String((b && (b.adminPasscode || b.admin_passcode)) || "").trim();
    if (!passcode) return err("请填写口令");
    if (passcode.length > 64) return err("口令过长，请不超过 64 个字符");
    if (name.length > 40) return err("备注名过长，请不超过 40 个字");
    if (!adminPasscode) return err("请为该口令设置管理员密码（同一口令下的项目共用它）");
    if (adminPasscode.length > 64) return err("管理员密码过长，请不超过 64 个字符");
    const dup = await env.DB.prepare("SELECT id FROM passcodes WHERE passcode = ?").bind(passcode).first();
    if (dup) return err("该口令已存在");
    const r = await env.DB
      .prepare("INSERT INTO passcodes (passcode, name, admin_passcode) VALUES (?, ?, ?)")
      .bind(passcode, name, adminPasscode)
      .run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  if (method === "PUT") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT id, passcode, name, admin_passcode FROM passcodes WHERE id = ?").bind(id).first();
    if (!old) return err("口令不存在", 404);
    const b = (await readJson(request)) || {};
    const passcode = b.passcode === undefined ? old.passcode : String(b.passcode).trim();
    const name = b.name === undefined ? old.name : String(b.name).trim();
    const rawAdmin = b.adminPasscode !== undefined ? b.adminPasscode : b.admin_passcode;
    const adminPasscode = rawAdmin === undefined ? old.admin_passcode : String(rawAdmin).trim();
    if (!passcode) return err("口令不能为空");
    if (passcode.length > 64) return err("口令过长，请不超过 64 个字符");
    if (name.length > 40) return err("备注名过长，请不超过 40 个字");
    if (!adminPasscode) return err("管理员密码不能为空（同一口令下的项目共用它）");
    if (adminPasscode.length > 64) return err("管理员密码过长，请不超过 64 个字符");
    if (passcode !== old.passcode) {
      const dup = await env.DB.prepare("SELECT id FROM passcodes WHERE passcode = ? AND id != ?").bind(passcode, id).first();
      if (dup) return err("该口令已存在");
    }
    await env.DB
      .prepare("UPDATE passcodes SET passcode = ?, name = ?, admin_passcode = ? WHERE id = ?")
      .bind(passcode, name, adminPasscode, id)
      .run();
    return json({ ok: true });
  }

  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT id, passcode FROM passcodes WHERE id = ?").bind(id).first();
    if (!old) return err("口令不存在", 404);
    const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM projects WHERE passcode_id = ?").bind(id).first();
    if (c && c.c > 0) return err(`该口令名下还有 ${c.c} 个项目，请先删除或转移这些项目再删除口令`);
    await env.DB.prepare("DELETE FROM passcodes WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  return err("不支持的方法", 405);
}

// ---------- 主入口 ----------
export async function onRequest(context) {
  const { request, env, params } = context;
  const segs = Array.isArray(params.path) ? params.path : [];
  const method = request.method.toUpperCase();
  const route = segs[0] || "";
  const id = toId(segs[1]);

  try {
    if (route === "health" && method === "GET") {
      return json({ ok: true, service: "team-building" });
    }

    await ensureSchema(env);

    if (route === "auth" && segs[1] === "login" && method === "POST") {
      const body = await readJson(request);
      const pc = String((body && body.passcode) || "").trim();
      const row = pc
        ? await env.DB.prepare("SELECT id, passcode, name FROM passcodes WHERE passcode = ?").bind(pc).first()
        : null;
      if (!row) return err("口令不正确", 401);
      return json({ ok: true, token: await tokenFor(row) });
    }

    // 口令管理：登录页也要能用，因此只认超级密码（SUPER_PASSCODE），不要求登录令牌
    if (route === "passcodes") {
      return handlePasscodes(env, method, id, request);
    }

    // 以下接口均需登录；登录身份就是「哪个口令」
    const me = await authPasscode(request, env);
    if (!me) return err("未登录或口令已失效", 401);

    // 项目本身的管理（列表 / 新建 / 详情 / 改名 / 结束 / 删除）不需要项目上下文
    if (route === "projects") {
      return handleProjects(env, method, id, request, me);
    }

    // 其余业务接口都需要项目上下文，且项目必须真实存在、且属于当前登录口令
    const projectId = requestProjectId(request);
    if (!projectId) return err("缺少项目信息，请先选择或新建团建项目", 400);
    const proj = await env.DB
      .prepare("SELECT id, name, status, budget, bonus, passcode_id FROM projects WHERE id = ?")
      .bind(projectId)
      .first();
    if (!proj || Number(proj.passcode_id) !== Number(me.id)) return err("项目不存在或已被删除", 404);

    // 已结束的项目只读：查看没问题，但项目内任何内容都不能再改
    if (proj.status === "已结束" && method !== "GET") {
      return err("项目已结束，只能查看；如需修改请先用本口令的管理员密码重启项目", 403);
    }

    switch (route) {
      case "families":
        return handleFamilies(env, method, id, request, projectId);
      case "members":
        return handleMembers(env, method, id, request, projectId);
      case "carry-items":
        return handleCarryItems(env, method, id, request, projectId);
      case "shopping-items":
        return handleShoppingItems(env, method, id, request, projectId);
      case "purchases":
        return handlePurchases(env, method, id, request, projectId);
      case "settlement":
        if (method !== "GET") return err("不支持的方法", 405);
        return json({ ok: true, data: await computeSettlement(env, projectId) });
      case "overview":
        if (method !== "GET") return err("不支持的方法", 405);
        return json({ ok: true, data: await computeOverview(env, projectId, proj) });
      case "logs":
        if (method === "GET") return handleLogs(env, request, projectId);
        if (method === "DELETE") {
          // 带 id → 删除单条；不带 id → 一键清除当前项目的全部日志
          if (id) return handleLogDelete(env, id, request, projectId, me);
          return handleLogClear(env, request, projectId, me);
        }
        return err("不支持的方法", 405);
      default:
        return err("接口不存在", 404);
    }
  } catch (e) {
    return err("服务器错误：" + (e && e.message ? e.message : String(e)), 500);
  }
}

// ---------- 名称唯一性（项目名 / 家庭名） ----------
// 统一归一化：去掉首尾空格 + 忽略英文大小写，与前端 String.trim().toLowerCase() 完全一致。
// 把已有的名称取回来用 JS 比较，而不是 SQL 的 LOWER(TRIM(name))：SQLite 的 LOWER 只折叠
// ASCII 大小写、TRIM 只去半角空格；每个口令下项目、每个项目下家庭都很少，全取回来更稳妥。
// 历史库里可能已经有重名数据：因此不建唯一索引、也不改历史数据，只在「新增 / 改成重名」时拦下。
function normalizeName(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

// 项目名：只在「同一个口令（passcode_id）」下唯一，不同口令各有一个「2026 秋季团建」互不冲突。
async function findProjectNameConflict(env, tenant, name, excludeId = null) {
  const rows = await env.DB.prepare("SELECT id, name FROM projects WHERE passcode_id = ?").bind(tenant).all();
  const key = normalizeName(name);
  return (
    (rows.results || []).find(
      (p) => Number(p.id) !== Number(excludeId) && normalizeName(p.name) === key
    ) || null
  );
}
function projectNameConflictError(dup) {
  return err("该口令下已存在同名项目「" + dup.name + "」，请换一个名称", 409);
}

// 家庭名：只在「同一个项目（project_id）」内唯一，不同项目之间不冲突；改名时排除自己。
async function findFamilyNameConflict(env, projectId, name, excludeId = null) {
  const rows = await env.DB.prepare("SELECT id, name FROM families WHERE project_id = ?").bind(projectId).all();
  const key = normalizeName(name);
  return (
    (rows.results || []).find(
      (f) => Number(f.id) !== Number(excludeId) && normalizeName(f.name) === key
    ) || null
  );
}
function familyNameConflictError(dup) {
  return err("本项目已存在同名家庭「" + dup.name + "」，请换一个名称", 409);
}
// 新建项目会一次性提交多行家庭：这些行还没入库，得在数组内部单独查一次重名。
function duplicateFamilyInRows(rows) {
  const seen = new Set();
  for (const f of rows) {
    const key = normalizeName(f.name);
    if (seen.has(key)) return f;
    seen.add(key);
  }
  return null;
}

async function handleProjects(env, method, id, request, me) {
  // 只认「本口令名下」的项目：不同口令之间互相看不到、也改不到，达到数据隔离
  const tenant = me ? me.id : null;
  if (method === "GET" && !id) {
    // 项目列表（含统计），最新创建的排前面 —— 也就是「历史项目」列表
    const rows = await env.DB
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*)                    FROM families f  WHERE f.project_id  = p.id) AS family_count,
           (SELECT COALESCE(SUM(f.member_count), 0) FROM families f WHERE f.project_id = p.id) AS member_count,
           (SELECT COALESCE(SUM(amount), 0) FROM purchases u WHERE u.project_id  = p.id) AS total_amount
         FROM projects p
         WHERE p.passcode_id = ?
         ORDER BY p.id DESC`
      )
      .bind(tenant)
      .all();
    return json({ ok: true, data: rows.results });
  }

  if (method === "GET" && id) {
    const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND passcode_id = ?").bind(id, tenant).first();
    if (!project) return err("项目不存在", 404);
    const families = (await env.DB.prepare("SELECT * FROM families WHERE project_id = ? ORDER BY id").bind(id).all())
      .results;
    const members = (
      await env.DB.prepare("SELECT * FROM members WHERE project_id = ? ORDER BY family_id, id").bind(id).all()
    ).results;
    return json({ ok: true, data: { project, families, members } });
  }

if (method === "POST") {
    // 新建项目属于高风险操作：用「当前口令的管理员密码」校验（同一口令下的项目共用它）
    const denied = requireProjectAdmin(request, me);
    if (denied) return denied;
    const b = await readJson(request);
    const name = String((b && b.name) || "").trim();
    if (!name) return err("缺少项目名称");
    // 同一口令下不允许重名：先判重，再校验家庭行、再写库（避免留下没有家庭的空壳项目）
    const dup = await findProjectNameConflict(env, tenant, name);
    if (dup) return projectNameConflictError(dup);
    const note = String((b && b.note) || "").trim();
    const families = Array.isArray(b && b.families) ? b.families : [];

    // 创建项目时手动写入的家庭：每行是「家庭名称 + 人数 + 一条备注（忌口/过敏）」。
    // 人数直接落在 families.member_count，不再按姓名逐条写 members 表；
    // 历史项目里已有的 members 行保留不动，只是界面不再展示。
    // 先在写库之前把全部行校验完：否则人数非法时项目已经建出来、却没有任何家庭。
    const parsed = [];
    for (const f of families) {
      const famName = String((f && f.name) || "").trim();
      if (!famName) continue;
      const n = parseMemberCount(f && f.member_count);
      if (n === null) return err("家庭人数必须是 0～999 的整数");
      parsed.push({ name: famName, note: String((f && f.note) || "").trim(), count: n });
    }
    // 同一个项目内家庭名不能重复：这次提交的各行之间也要互不相同，
    // 同样在建项目之前拦下，避免留下「名字分不清」的半截数据。
    const rowDup = duplicateFamilyInRows(parsed);
    if (rowDup) return err("家庭名称「" + rowDup.name + "」重复了，请合并或修改其中一行", 409);

    const r = await env.DB
      .prepare("INSERT INTO projects (name, note, status, split_mode, passcode_id) VALUES (?, ?, ?, ?, ?)")
      .bind(name, note, "进行中", "family", tenant)
      .run();
    const pid = r.meta.last_row_id;

    let familyCount = 0;
    let memberCount = 0;
    for (const f of parsed) {
      await env.DB
        .prepare("INSERT INTO families (project_id, name, note, member_count) VALUES (?, ?, ?, ?)")
        .bind(pid, f.name, f.note, f.count)
        .run();
      familyCount++;
      memberCount += f.count;
    }
    await addLog(env, pid, {
      familyId: null,
      action: "新建项目",
      targetType: "project",
      targetId: pid,
      detail: note ? `${name}（${note}）` : name,
    });
    return json({ ok: true, id: pid, family_count: familyCount, member_count: memberCount });
  }

  if (method === "PUT") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND passcode_id = ?").bind(id, tenant).first();
    if (!old) return err("项目不存在", 404);
    const b = (await readJson(request)) || {};
    const nextName = String(b.name ?? old.name).trim() || old.name;
    const nextStatus = String(b.status ?? old.status).trim() || old.status;

    // 预算（元）：可设置、修改或清零（0 表示未设置，页面显示「无」）。
    // 请求体里没带 budget 字段时保持原值；带了就按数字校验并写库。
    const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const budgetWas = round2(old.budget);
    const hasBudget = b.budget !== undefined && b.budget !== null && b.budget !== "";
    let nextBudget = budgetWas;
    if (hasBudget) {
      const bv = Number(b.budget);
      if (!Number.isFinite(bv) || bv < 0) return err("预算必须是不小于 0 的数字");
      if (bv > 100000000) return err("预算金额过大，请填写不超过 1 亿元的数字");
      nextBudget = round2(bv);
    }
    const budgetChanged = hasBudget && nextBudget !== budgetWas;
    // 设置 / 修改 / 取消预算都属于高风险操作，需要本口令的管理员密码
    if (hasBudget) {
      const denied = requireProjectAdmin(request, me);
      if (denied) return denied;
    }
    // 任务奖金池（元）：口径与预算一致——0 表示未设置；设置 / 修改 / 取消同样需要管理员密码
    const bonusWas = round2(old.bonus);
    const hasBonus = b.bonus !== undefined && b.bonus !== null && b.bonus !== "";
    let nextBonus = bonusWas;
    if (hasBonus) {
      const nv = Number(b.bonus);
      if (!Number.isFinite(nv) || nv < 0) return err("奖金必须是不小于 0 的数字");
      if (nv > 100000000) return err("奖金金额过大，请填写不超过 1 亿元的数字");
      nextBonus = round2(nv);
    }
    const bonusChanged = hasBonus && nextBonus !== bonusWas;
    if (hasBonus) {
      const denied = requireProjectAdmin(request, me);
      if (denied) return denied;
    }
    // 项目改名同样需要本口令的管理员密码；只改备注等其它字段不需要
    if (nextName !== old.name) {
      const denied = requireProjectAdmin(request, me);
      if (denied) return denied;
    }
    // 分摊方式：family=按家庭数均分 / person=按人数均分。项目级口径，所有家庭共用，
    // 因此切换与设置预算 / 奖金同级别，需要本口令的管理员密码。老库没有该列时按 family 处理。
    const modeWas = String(old.split_mode || "family") === "person" ? "person" : "family";
    const hasMode = b.split_mode !== undefined && b.split_mode !== null && b.split_mode !== "";
    let nextMode = modeWas;
    if (hasMode) {
      const m = String(b.split_mode).trim();
      if (m !== "family" && m !== "person") return err("分摊方式只能是 family（按家庭数）或 person（按人数）");
      nextMode = m;
    }
    const modeChanged = hasMode && nextMode !== modeWas;
    if (modeChanged) {
      const denied = requireProjectAdmin(request, me);
      if (denied) return denied;
    }

    // 已结束的项目只能查看：改名 / 改备注 / 改预算 / 再次结束都不允许
    const isRestart = old.status === "已结束" && nextStatus === "进行中";
    if (old.status === "已结束" && !isRestart) {
      return err("项目已结束，只能查看；如需修改请先用本口令的管理员密码重启项目", 403);
    }
    // 结束项目 / 重启已结束的项目都属于高风险操作，需要本口令的管理员密码
    const isEnd = old.status !== "已结束" && nextStatus === "已结束";
    if (isRestart || isEnd) {
      const denied = requireProjectAdmin(request, me);
      if (denied) return denied;
    }

    // 改名也要过同一口令下的重名校验，且必须排除自己：
    // 历史库里若已有同名项目，只改预算 / 状态（或原名保存）不应该被误拦，所以只在名称真的变了才查。
    if (nextName !== old.name) {
      const dup = await findProjectNameConflict(env, tenant, nextName, id);
      if (dup) return projectNameConflictError(dup);
    }

    await env.DB
      .prepare("UPDATE projects SET name = ?, note = ?, status = ?, budget = ?, bonus = ?, split_mode = ? WHERE id = ?")
      .bind(nextName, String(b.note ?? old.note), nextStatus, nextBudget, nextBonus, nextMode, id)
      .run();
    const fmtBudget = (v) => (Number(v) > 0 ? `¥${round2(v).toFixed(2)}` : "无");
    if (budgetChanged) {
      await addLog(env, id, {
        familyId: null,
        action: nextBudget > 0 ? (budgetWas > 0 ? "修改预算" : "设置预算") : "取消预算设置",
        targetType: "project",
        targetId: id,
        detail: `预算 ${fmtBudget(budgetWas)} → ${fmtBudget(nextBudget)}`,
      });
    }
    if (bonusChanged) {
      await addLog(env, id, {
        familyId: null,
        action: nextBonus > 0 ? (bonusWas > 0 ? "修改任务奖金" : "设置任务奖金") : "取消任务奖金",
        targetType: "project",
        targetId: id,
        detail: `任务奖金 ${fmtBudget(bonusWas)} → ${fmtBudget(nextBonus)}`,
      });
    }
    if (modeChanged) {
      await addLog(env, id, {
        familyId: null,
        action: "修改分摊方式",
        targetType: "project",
        targetId: id,
        detail: `${SPLIT_LABEL[modeWas]} → ${SPLIT_LABEL[nextMode]}`,
      });
    }
    if (nextStatus !== old.status) {
      await addLog(env, id, {
        familyId: null,
        action: `项目状态改为「${nextStatus}」`,
        targetType: "project",
        targetId: id,
        detail: nextName,
      });
    }
    // 已经为预算 / 奖金 / 分摊方式写过专门日志时，不再补一条泛泛的「修改项目」
    if (!budgetChanged && !bonusChanged && !modeChanged && nextStatus === old.status) {
      await addLog(env, id, {
        familyId: null,
        action: "修改项目",
        targetType: "project",
        targetId: id,
        detail: nextName,
      });
    }
    return json({ ok: true });
  }

  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND passcode_id = ?").bind(id, tenant).first();
    if (!old) return err("项目不存在", 404);
    // 删除项目（含历史项目）属于高风险操作，需要本口令的管理员密码
    const denied = requireProjectAdmin(request, me);
    if (denied) return denied;
    // 级联清理该项目下的全部数据
    for (const table of ["logs", "purchases", "shopping_items", "carry_items", "members", "families"]) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE project_id = ?`).bind(id).run();
    }
    await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  return err("不支持的方法", 405);
}

// ---------- 家庭（项目内）----------
async function handleFamilies(env, method, id, request, projectId) {
  if (method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM families WHERE project_id = ? ORDER BY id").bind(projectId).all();
    return json({ ok: true, data: rows.results });
  }
  if (method === "POST") {
    const b = await readJson(request);
    if (!b || !String(b.name || "").trim()) return err("缺少家庭名称");
    const count = parseMemberCount(b.member_count);
    if (count === null) return err("家庭人数必须是 0～999 的整数");
    const name = String(b.name).trim();
    const dup = await findFamilyNameConflict(env, projectId, name);
    if (dup) return familyNameConflictError(dup);
    const r = await env.DB
      .prepare("INSERT INTO families (project_id, name, note, member_count) VALUES (?, ?, ?, ?)")
      .bind(projectId, name, String(b.note || "").trim(), count)
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "新增家庭",
      targetType: "family",
      targetId: r.meta.last_row_id,
      detail: `${name}（${count} 人）`,
    });
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (method === "PUT") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM families WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!old) return err("家庭不存在", 404);
    const ownGuard = requireOwnFamily(request, id);
    if (ownGuard) return ownGuard;
    const b = (await readJson(request)) || {};
    const nextName = String(b.name ?? old.name).trim() || old.name;
    const nextNote = String(b.note ?? old.note ?? "").trim();
    const hasCount = b.member_count !== undefined && b.member_count !== null && b.member_count !== "";
    let nextCount = Math.max(0, Math.floor(Number(old.member_count) || 0));
    if (hasCount) {
      const c = parseMemberCount(b.member_count);
      if (c === null) return err("家庭人数必须是 0～999 的整数");
      nextCount = c;
    }
    // 只在名称真的变了才判重：只改人数 / 备注、或原名保存时放行，
    // 历史库里已存在的重名家庭因此仍能正常维护自己的数据。
    if (normalizeName(nextName) !== normalizeName(old.name)) {
      const dup = await findFamilyNameConflict(env, projectId, nextName, id);
      if (dup) return familyNameConflictError(dup);
    }
    await env.DB
      .prepare("UPDATE families SET name = ?, note = ?, member_count = ? WHERE id = ? AND project_id = ?")
      .bind(nextName, nextNote, nextCount, id, projectId)
      .run();
    const parts = [];
    if (nextName !== old.name) parts.push(`${old.name} → ${nextName}`);
    if (hasCount && nextCount !== Math.max(0, Math.floor(Number(old.member_count) || 0)))
      parts.push(`人数 ${Math.max(0, Math.floor(Number(old.member_count) || 0))} → ${nextCount}`);
    if (nextNote !== String(old.note || "")) parts.push("备注已更新");
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "修改家庭",
      targetType: "family",
      targetId: id,
      detail: parts.join(" · ") || nextName,
    });
    return json({ ok: true });
  }
  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const ownGuard = requireOwnFamily(request, id);
    if (ownGuard) return ownGuard;
    const p = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM purchases WHERE family_id = ? AND project_id = ?")
      .bind(id, projectId)
      .first();
    if (p && p.c > 0) return err("该家庭已有采购记录，请先处理相关采购记录再删除");
    const f = await env.DB.prepare("SELECT name FROM families WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!f) return err("家庭不存在", 404);
    await env.DB.prepare("DELETE FROM members WHERE family_id = ? AND project_id = ?").bind(id, projectId).run();
    await env.DB.prepare("DELETE FROM carry_items WHERE family_id = ? AND project_id = ?").bind(id, projectId).run();
    await env.DB.prepare("DELETE FROM families WHERE id = ? AND project_id = ?").bind(id, projectId).run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "删除家庭",
      targetType: "family",
      targetId: id,
      detail: f ? f.name : "",
    });
    return json({ ok: true });
  }
  return err("不支持的方法", 405);
}

// ---------- 成员（历史数据只读）----------
// 成员已改为「按家庭登记人数 + 一条备注」，人数落在 families.member_count。
// 旧 members 表里的姓名数据保留、GET 仍可查，但不再提供写入入口，避免绕过界面写出的
// 匿名行与人数口径不一致。前端成员页也不再调用这些写接口。
async function handleMembers(env, method, id, request, projectId) {
  if (method === "GET") {
    const rows = await env.DB
      .prepare("SELECT * FROM members WHERE project_id = ? ORDER BY family_id, id")
      .bind(projectId)
      .all();
    return json({ ok: true, data: rows.results });
  }
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    return err("成员已改为按「家庭人数」登记，请到成员页修改人数与备注", 403);
  }
  return err("不支持的方法", 405);
}

// ---------- 携带物品（各家庭自管自己的，全员可见）----------
async function handleCarryItems(env, method, id, request, projectId) {
  if (method === "GET") {
    const rows = await env.DB
      .prepare("SELECT * FROM carry_items WHERE project_id = ? ORDER BY family_id, id")
      .bind(projectId)
      .all();
    return json({ ok: true, data: rows.results });
  }
  if (method === "POST") {
    const b = await readJson(request);
    if (!b || !String(b.name || "").trim()) return err("缺少物品名称");
    const myFamily = actorFamilyId(request);
    const familyId = toId(b.family_id) || myFamily;
    if (!familyId) return err("请先选择你所属的家庭");
    // 该家庭必须属于当前项目，避免把记录错记到别的项目的家庭上
    const belong = await env.DB
      .prepare("SELECT id FROM families WHERE id = ? AND project_id = ?")
      .bind(familyId, projectId)
      .first();
    if (!belong) return err("所选家庭不属于当前项目", 400);
    // 携带物品名只在「同一家庭内」唯一：别家带「纸巾 / 矿泉水」不算冲突。
    // 口径与项目名 / 家庭名一致（去空格 + 忽略大小写），用 normalizeName 在 JS 里比；
    // 历史重名数据保留，只在新增时拦下，也不建唯一索引。
    const name = String(b.name).trim();
    const existing = await env.DB
      .prepare("SELECT id, name FROM carry_items WHERE project_id = ? AND family_id = ?")
      .bind(projectId, familyId)
      .all();
    const dup = (existing.results || []).find((x) => normalizeName(x.name) === normalizeName(name));
    if (dup) return err("你家已添加同名物品「" + dup.name + "」，请直接修改它的数量或换个名称", 409);
    const r = await env.DB
      .prepare("INSERT INTO carry_items (project_id, name, quantity, family_id, status, note) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(projectId, name, b.quantity || "", familyId, b.status || "待带", b.note || "")
      .run();
    await addLog(env, projectId, {
      familyId: myFamily,
      action: "新增携带物品",
      targetType: "carry_item",
      targetId: r.meta.last_row_id,
      detail: name,
    });
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (method === "PUT") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM carry_items WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!old) return err("物品不存在", 404);
    const myFamily = actorFamilyId(request);
    if (myFamily && old.family_id && old.family_id !== myFamily) {
      return err("只能管理自己家庭的携带物品", 403);
    }
    const b = (await readJson(request)) || {};
    // 数量是自由文本（「2 箱」「1 提」），只去首尾空格；留空表示清空数量。
    const nextName = b.name !== undefined ? String(b.name).trim() || old.name : old.name;
    const nextQty = b.quantity !== undefined ? String(b.quantity ?? "").trim() : String(old.quantity ?? "");
    const nextStatus = b.status !== undefined ? b.status : old.status;
    const nextNote = b.note !== undefined ? b.note : old.note;
    await env.DB
      .prepare("UPDATE carry_items SET name = ?, quantity = ?, status = ?, note = ? WHERE id = ? AND project_id = ?")
      .bind(nextName, nextQty, nextStatus, nextNote, id, projectId)
      .run();
    // 日志写清改了什么：数量从「无」到「2 箱」、或从「2 箱」清空都能看出来
    const parts = [];
    if (nextQty !== String(old.quantity ?? "")) parts.push(`数量 ${old.quantity || "无"} → ${nextQty || "无"}`);
    if (nextStatus !== old.status) parts.push(`状态 ${old.status} → ${nextStatus}`);
    if (nextName !== old.name) parts.push(`${old.name} → ${nextName}`);
    await addLog(env, projectId, {
      familyId: myFamily,
      action: "修改携带物品",
      targetType: "carry_item",
      targetId: id,
      detail: parts.length ? `${nextName}：${parts.join(" · ")}` : nextName,
    });
    return json({ ok: true });
  }
  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM carry_items WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    const myFamily = actorFamilyId(request);
    if (old && myFamily && old.family_id && old.family_id !== myFamily) {
      return err("只能管理自己家庭的携带物品", 403);
    }
    await env.DB.prepare("DELETE FROM carry_items WHERE id = ? AND project_id = ?").bind(id, projectId).run();
    await addLog(env, projectId, {
      familyId: myFamily,
      action: "删除携带物品",
      targetType: "carry_item",
      targetId: id,
      detail: old ? old.name : "",
    });
    return json({ ok: true });
  }
  return err("不支持的方法", 405);
}

// ---------- 采购清单（公共，所有家庭可管理）----------
async function handleShoppingItems(env, method, id, request, projectId) {
  if (method === "GET") {
    // 带上认领家庭的名字，前端直接显示「谁接了任务」
    // 状态按采购记录现算（purchased=1 表示存在指向该项的采购记录）：表里存的 status
    // 只是同步结果、供概览统计用，对外读取一律以这儿的派生值为准。
    const rows = await env.DB
      .prepare(
        `SELECT s.*, f.name AS claimed_family_name,
                CASE WHEN EXISTS (
                  SELECT 1 FROM purchases p
                   WHERE p.project_id = s.project_id
                     AND (p.item_id = s.id OR (p.item_id IS NULL AND p.item_name = s.name))
                ) THEN 1 ELSE 0 END AS purchased
           FROM shopping_items s
           LEFT JOIN families f ON f.id = s.claimed_family_id
          WHERE s.project_id = ?
          ORDER BY s.status, s.id`
      )
      .bind(projectId)
      .all();
    const data = rows.results.map((r) => {
      const row = Object.assign({}, r, { status: r.purchased ? "已购" : "待购" });
      delete row.purchased;
      return row;
    });
    return json({ ok: true, data });
  }
  if (method === "POST") {
    const b = await readJson(request);
    if (!b || !String(b.name || "").trim()) return err("缺少采购项名称");
    const name = String(b.name).trim();
    // 同名项在清单里只允许存在一条：候选框 / 「已购」派生 / 采购记录的按名关联都以名字为准，
    // 一旦出现两条同名项，接单和状态就会落在错误的那一条上。
    // 比较用 trim 后的精确匹配（不做大小写折叠：中文为主，「Cola / cola」按两种写法处理更符合预期）。
    const dup = await env.DB
      .prepare("SELECT id FROM shopping_items WHERE project_id = ? AND TRIM(name) = ?")
      .bind(projectId, name)
      .first();
    if (dup) return err("清单里已经有「" + name + "」了，不能重复添加", 409);
    const r = await env.DB
      .prepare("INSERT INTO shopping_items (project_id, name, quantity, unit, status, note) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(projectId, name, b.quantity || "", b.unit || "", b.status || "待购", b.note || "")
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "新增采购项",
      targetType: "shopping_item",
      targetId: r.meta.last_row_id,
      detail: name,
    });
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (method === "PUT") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM shopping_items WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!old) return err("采购项不存在", 404);
    const b = (await readJson(request)) || {};

    // 接任务 / 取消接任务：body 里带 claim: true / false
    if (b.claim !== undefined) {
      const myFamily = actorFamilyId(request);
      if (b.claim) {
        if (!myFamily) return err("请先选择你所属的家庭");
        const fam = await env.DB
          .prepare("SELECT name FROM families WHERE id = ? AND project_id = ?")
          .bind(myFamily, projectId)
          .first();
        if (!fam) return err("你所属的家庭不属于当前项目", 400);
        if (old.claimed_family_id) {
          if (old.claimed_family_id === myFamily) return json({ ok: true, claimed_by: fam.name });
          const prev = await env.DB.prepare("SELECT name FROM families WHERE id = ?").bind(old.claimed_family_id).first();
          return err("该采购项已被「" + (prev ? prev.name : "其他家庭") + "」接单，需由该家庭先取消");
        }
        await env.DB
          .prepare("UPDATE shopping_items SET claimed_family_id = ?, claimed_at = datetime('now') WHERE id = ? AND project_id = ?")
          .bind(myFamily, id, projectId)
          .run();
        await addLog(env, projectId, {
          familyId: myFamily,
          action: "接任务",
          targetType: "shopping_item",
          targetId: id,
          detail: old.name,
        });
        return json({ ok: true, claimed_by: fam.name });
      }
      // 取消接任务：已经采购过的项不许取消，要回到「未接单 + 待购」得删掉对应的采购记录
      if (await hasLinkedPurchase(env, projectId, old)) {
        return err("这一项已经采购过了，不能取消接任务；删掉对应的采购记录会自动回到「未接单 + 待购」", 403);
      }
      // 取消：只允许接单的那个家庭自己取消
      if (!old.claimed_family_id) return json({ ok: true });
      if (myFamily && old.claimed_family_id !== myFamily) return err("只能取消自己家庭接的任务", 403);
      await env.DB
        .prepare("UPDATE shopping_items SET claimed_family_id = NULL, claimed_at = '' WHERE id = ? AND project_id = ?")
        .bind(id, projectId)
        .run();
      await addLog(env, projectId, {
        familyId: myFamily,
        action: "取消接任务",
        targetType: "shopping_item",
        targetId: id,
        detail: old.name,
      });
      return json({ ok: true });
    }

    // 采购状态由采购记录自动同步，清单里不提供手工修改：想改就直接拒绝，
    // 要变状态就到「采购记录」里登记或删除（删掉最后那笔记录会自动回到「待购 + 没人接任务」）。
    if (b.status !== undefined && b.status !== old.status) {
      return err("采购状态由「采购记录」自动同步，不能手工修改；请到采购记录里登记或删除", 403);
    }
    // 名称是关联键：候选框、按名派生的「已购」、历史采购记录的兜底匹配都靠它，
    // 改名会让老记录对不上号，所以不允许改；要换名字请删掉这一项重新添加。
    if (b.name !== undefined && String(b.name).trim() !== old.name) {
      return err("采购项名称不能修改；如果要换名字，请删掉这一项后重新添加", 403);
    }

    // 允许改的只有「数量 / 单位」，且不限家庭 —— 清单是公共的，谁发现写错了都能顺手改。
    const nextQty = b.quantity !== undefined ? String(b.quantity).trim() : old.quantity;
    const nextUnit = b.unit !== undefined ? String(b.unit).trim() : old.unit;
    if (nextQty === old.quantity && nextUnit === old.unit) return json({ ok: true });
    await env.DB
      .prepare("UPDATE shopping_items SET quantity = ?, unit = ? WHERE id = ? AND project_id = ?")
      .bind(nextQty, nextUnit, id, projectId)
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "修改采购项数量",
      targetType: "shopping_item",
      targetId: id,
      detail: `${old.name}：${old.quantity || "无数量"}${old.unit || ""} → ${nextQty || "无数量"}${nextUnit || ""}`,
    });
    return json({ ok: true });
  }
  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM shopping_items WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    // 已经登记过采购记录的项不能从清单里删掉：要删它得先把指向它的采购记录删掉
    // （删完记录该项会自动回到「未接单 + 待购」，那时才能删）
    if (old && (await hasLinkedPurchase(env, projectId, old))) {
      return err("这一项已经登记过采购记录，不能从采购清单里删除；请先删掉对应的采购记录，它回到「未接单 + 待购」后即可删除", 403);
    }
    await env.DB.prepare("DELETE FROM shopping_items WHERE id = ? AND project_id = ?").bind(id, projectId).run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "删除采购项",
      targetType: "shopping_item",
      targetId: id,
      detail: old ? old.name : "",
    });
    return json({ ok: true });
  }
  return err("不支持的方法", 405);
}

// ---------- 采购明细（谁买的、花了多少）----------
// 采购记录与采购清单项的关联口径：优先按 item_id 命中，其次按「同名项」命中，
// 用于「登记采购自动标记同名项已购 / 承接接单」与「删除采购记录按口径回退」。
async function findLinkedShopItem(env, projectId, itemId, name) {
  if (itemId) {
    const byId = await env.DB
      .prepare("SELECT * FROM shopping_items WHERE id = ? AND project_id = ?")
      .bind(itemId, projectId)
      .first();
    if (byId) return byId;
  }
  const n = String(name == null ? "" : name).trim();
  if (!n) return null;
  return await env.DB
    .prepare("SELECT * FROM shopping_items WHERE project_id = ? AND name = ? ORDER BY id LIMIT 1")
    .bind(projectId, n)
    .first();
}

// 采购状态一律由采购记录派生：还存在指向该项的采购记录就是「已购」，否则「待购」。
// 命中规则优先按 item_id，兼容历史数据里 item_id 为空的老记录按同名匹配。
async function hasLinkedPurchase(env, projectId, item) {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS c FROM purchases
        WHERE project_id = ? AND (item_id = ? OR (item_id IS NULL AND item_name = ?))`
    )
    .bind(projectId, item.id, item.name)
    .first();
  return Number((row && row.c) || 0) > 0;
}

// 把清单项的状态与采购记录对齐；一旦没有任何指向它的采购记录，就同时清掉接单家庭，
// 让该项彻底回到「没人接任务 + 待购」。
async function syncShopItemStatus(env, projectId, itemId) {
  const item = await env.DB
    .prepare("SELECT * FROM shopping_items WHERE id = ? AND project_id = ?")
    .bind(itemId, projectId)
    .first();
  if (!item) return null;
  if (await hasLinkedPurchase(env, projectId, item)) {
    if (item.status !== "已购") {
      await env.DB
        .prepare("UPDATE shopping_items SET status = '已购' WHERE id = ? AND project_id = ?")
        .bind(item.id, projectId)
        .run();
    }
    return { id: item.id, status: "已购", claimed_family_id: item.claimed_family_id };
  }
  if (item.status !== "待购" || item.claimed_family_id) {
    await env.DB
      .prepare("UPDATE shopping_items SET status = '待购', claimed_family_id = NULL, claimed_at = '' WHERE id = ? AND project_id = ?")
      .bind(item.id, projectId)
      .run();
  }
  return { id: item.id, status: "待购", claimed_family_id: null };
}

async function handlePurchases(env, method, id, request, projectId) {
  if (method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM purchases WHERE project_id = ? ORDER BY id DESC").bind(projectId).all();
    return json({ ok: true, data: rows.results });
  }
  if (method === "POST") {
    const b = await readJson(request);
    const itemName = String((b && b.item_name) || "").trim();
    if (!itemName) return err("缺少采购项名称");
    const myFamily = actorFamilyId(request);
    const familyId = toId(b.family_id) || myFamily;
    if (!familyId) return err("请先选择你所属的家庭");
    // 该家庭必须属于当前项目，否则这笔采购会记到别的项目的家庭上，结算口径随之出错
    const belong = await env.DB
      .prepare("SELECT id FROM families WHERE id = ? AND project_id = ?")
      .bind(familyId, projectId)
      .first();
    if (!belong) return err("所选家庭不属于当前项目", 400);
    const amount = Number(b.amount) || 0;
    const itemId = toId(b.item_id);
    const r = await env.DB
      .prepare(
        "INSERT INTO purchases (project_id, item_id, item_name, family_id, amount, quantity, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(projectId, itemId, itemName, familyId, amount, b.quantity || "", b.note || "")
      .run();
    // 登记采购后，清单里若有同名项（或按 item_id 命中的项），该项自动标记为「已购」；
    // 若该项还没人接单，就把接单家庭记为本次登记的家庭（接单状态显示当前家接单）；
    // 若已被其他家庭接单，则保留原接单家庭不变，只标记「已购」。
    const linked = await findLinkedShopItem(env, projectId, itemId, itemName);
    if (linked) {
      // 该项还没人接单时，把接单家庭记为本次登记的家庭；已有接单家庭则保持不变
      if (!linked.claimed_family_id) {
        await env.DB
          .prepare("UPDATE shopping_items SET claimed_family_id = ?, claimed_at = datetime('now') WHERE id = ? AND project_id = ?")
          .bind(familyId, linked.id, projectId)
          .run();
      }
      // 状态统一由采购记录派生（此刻这笔记录已经存在，因此必定是「已购」）
      await syncShopItemStatus(env, projectId, linked.id);
    }
    await addLog(env, projectId, {
      familyId: myFamily,
      action: "登记采购",
      targetType: "purchase",
      targetId: r.meta.last_row_id,
      detail: `${itemName} ¥${amount}`,
    });
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (method === "PUT") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM purchases WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!old) return err("采购记录不存在", 404);
    const b = (await readJson(request)) || {};
    // 只能改自家登记的记录，且只改金额：物品、登记家庭、时间一概不开放，
    // 否则一笔别人的账可以被改到任意家庭名下，结算口径就乱了。
    const myFamily = actorFamilyId(request);
    if (!myFamily) return err("请先选择你所属的家庭", 400);
    if (Number(old.family_id) !== Number(myFamily)) {
      return err("只能修改自家登记的采购金额，其他家庭的记录只能查看", 403);
    }
    if (b.amount === undefined) return err("目前只支持修改金额");
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0) return err("金额必须是不小于 0 的数字");
    if (amount === Number(old.amount)) return json({ ok: true });
    await env.DB
      .prepare("UPDATE purchases SET amount = ? WHERE id = ? AND project_id = ?")
      .bind(amount, id, projectId)
      .run();
    await addLog(env, projectId, {
      familyId: myFamily,
      action: "修改采购金额",
      targetType: "purchase",
      targetId: id,
      detail: `${old.item_name}：¥${Number(old.amount).toFixed(2)} → ¥${amount.toFixed(2)}`,
    });
    return json({ ok: true });
  }
  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM purchases WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!old) return err("采购记录不存在", 404);
    // 只能删自家登记的：这笔采购挂在哪个家庭名下，就由哪个家庭来删；其他家庭只看得到、删不掉
    const myFamily = actorFamilyId(request);
    if (!myFamily) return err("请先选择你所属的家庭", 400);
    if (Number(old.family_id) !== Number(myFamily)) return err("只能删除自家登记的采购记录，其他家庭只能查看", 403);
    await env.DB.prepare("DELETE FROM purchases WHERE id = ? AND project_id = ?").bind(id, projectId).run();
    // 删掉这笔记录后，按「还有没有采购记录指向该项」重新派生清单状态：
    // 还剩别的记录就仍是「已购」，一笔都不剩就回到「待购 + 没人接任务」。
    // 删除采购记录属普通更正操作，不需要管理权限密码。
    if (old) {
      const linked = await findLinkedShopItem(env, projectId, old.item_id, old.item_name);
      if (linked) await syncShopItemStatus(env, projectId, linked.id);
    }
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "删除采购",
      targetType: "purchase",
      targetId: id,
      detail: old ? `${old.item_name} ¥${old.amount}` : "",
    });
    return json({ ok: true });
  }
  return err("不支持的方法", 405);
}

// ---------- 结算（按家庭数均分 + 任务奖金 + 转账建议）----------
// 把 poolCents（单位：分）按 weights 权重精确分配：先各自取整，剩下的分按小数部分从大到小各补 1 分。
// 这样「各家获得之和」恰好等于奖金池（不会因为四舍五入出现 1 分钱对不上），出资均摊同理。
function allocCents(poolCents, weights) {
  const n = weights.length;
  if (!n || poolCents <= 0) return new Array(n).fill(0);
  const totalW = weights.reduce((s, w) => s + (Number(w) || 0), 0);
  if (totalW <= 0) return new Array(n).fill(0);
  const exact = weights.map((w) => (poolCents * (Number(w) || 0)) / totalW);
  const out = exact.map((v) => Math.floor(v));
  let rest = poolCents - out.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k++, rest--) out[order[k % n].i] += 1;
  return out;
}

async function computeSettlement(env, projectId) {
  const fams = (await env.DB.prepare("SELECT id, name, member_count FROM families WHERE project_id = ? ORDER BY id").bind(projectId).all()).results;
  const purs = (await env.DB.prepare("SELECT family_id, amount FROM purchases WHERE project_id = ?").bind(projectId).all()).results;
  const project = (await env.DB.prepare("SELECT budget, bonus, split_mode FROM projects WHERE id = ?").bind(projectId).first()) || {};

  const round2 = (n) => Math.round(n * 100) / 100;
  // 全程用「分」做整数运算，避免 0.1+0.2 这类浮点误差影响差额与转账建议
  const totalCents = Math.round(purs.reduce((s, p) => s + (Number(p.amount) || 0), 0) * 100);
  const count = fams.length;

  // 分摊口径：family = 每家 1 份；person = 按各家人数加权。
  // 人数为 0 的家庭在按人数口径下应摊 0（权重 0），不会把别人该出的钱摊到自己头上；
  // 若所有家庭都是 0 人，分母为 0，临时退回按家庭数均分并在结算页给出提示。
  // split_mode 仍返回项目里存的 person，切换按钮不会因为兜底而跳回「按家庭数」。
  const requestedMode = String(project.split_mode || "family") === "person" ? "person" : "family";
  const people = fams.map((f) => Math.max(0, Math.floor(Number(f.member_count) || 0)));
  const totalPeople = people.reduce((s, n) => s + n, 0);
  const byPerson = requestedMode === "person" && totalPeople > 0;
  const personFallback = requestedMode === "person" && !byPerson;
  const shareWeights = byPerson ? people : new Array(count).fill(1);

  // 任务奖金口径：池子由各家均摊出资，再按「已完成采购」的任务数分配。
  // 只统计挂在某家名下的已购项——清单里登记采购时会自动把该项归到登记家庭，
  // 所以没人认领的已购项（极少见的历史数据）不参与分配，免得奖金落到「无主」的池子里。
  const doneRows = (await env.DB
    .prepare(
      "SELECT claimed_family_id AS fid, COUNT(*) AS c FROM shopping_items " +
        "WHERE project_id = ? AND status = '已购' AND claimed_family_id IS NOT NULL GROUP BY claimed_family_id"
    )
    .bind(projectId)
    .all()).results;
  const doneMap = {};
  for (const r of doneRows) doneMap[r.fid] = Number(r.c) || 0;

  const bonusCents = Math.round((Number(project.bonus) || 0) * 100);
  const weights = fams.map((f) => doneMap[f.id] || 0);
  const totalDone = weights.reduce((s, w) => s + w, 0);
  // 没有任何家庭完成采购时，分配不成立：出资与获得都按 0 处理，结算口径与没有奖金时完全一致
  const bonusActive = bonusCents > 0 && count > 0 && totalDone > 0;

  const shareBase = allocCents(totalCents, shareWeights); // 总花费：按家庭数或按人数加权
  // 任务奖金池的「出资」始终按家庭数均分（任务制与人数无关），只有总花费跟随分摊口径；
  // 「获得」仍按各家已完成的采购任务数分配。
  const contribution = bonusActive ? allocCents(bonusCents, new Array(count).fill(1)) : new Array(count).fill(0);
  const earning = bonusActive ? allocCents(bonusCents, weights) : new Array(count).fill(0);

  const paidMap = {};
  for (const p of purs) {
    if (p.family_id == null) continue;
    paidMap[p.family_id] = (paidMap[p.family_id] || 0) + Math.round((Number(p.amount) || 0) * 100);
  }

  const detail = fams.map((f, i) => {
    const paidC = paidMap[f.id] || 0;
    const shareC = shareBase[i] + contribution[i]; // 应摊 = 花费均分 + 奖金出资
    const balanceC = paidC + earning[i] - shareC; // 差额 = 已垫付 + 获得奖金 − 应摊
    return {
      family_id: f.id,
      name: f.name,
      member_count: people[i], // 结算页按人数口径时显示这一列
      paid: round2(paidC / 100),
      share: round2(shareC / 100),
      balance: round2(balanceC / 100),
      done: weights[i], // 该家已完成（已购）的任务数，前端奖金图表会用到
      bonus_in: round2(contribution[i] / 100),
      bonus_out: round2(earning[i] / 100),
      bonus_net: round2((earning[i] - contribution[i]) / 100),
    };
  });

  // 转账建议：债权方与债务方贪心配对，尽量少的笔数结清
  const creditors = detail.filter((d) => d.balance > 0.005).map((d) => ({ name: d.name, amt: d.balance }));
  const debtors = detail.filter((d) => d.balance < -0.005).map((d) => ({ name: d.name, amt: -d.balance }));
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transfers = [];
  let i = 0;
  let j = 0;
  let guard = 0;
  while (i < debtors.length && j < creditors.length && guard++ < 1000) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0.005) transfers.push({ from: debtors[i].name, to: creditors[j].name, amount: round2(pay) });
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt <= 0.005) i++;
    if (creditors[j].amt <= 0.005) j++;
  }

  const divisor = byPerson ? totalPeople : count;
  const baseBasis = byPerson
    ? `按人数均分（共 ${totalPeople} 人）`
    : personFallback
      ? "按人数均分（暂无人数，暂按家庭数均分）"
      : "按家庭数均分";
  return {
    total: round2(totalCents / 100),
    family_count: count,
    // 顶部 KPI：按家庭数时是「每家应摊」，按人数时是「人均应摊」；有生效的奖金时把池子也算进来
    share: divisor ? round2((totalCents + (bonusActive ? bonusCents : 0)) / divisor / 100) : 0,
    split_mode: requestedMode,        // 项目设置的分摊方式
    effective_mode: byPerson ? "person" : "family", // 本次实际生效的口径（0 人兜底时不同）
    person_count: totalPeople,
    person_fallback: personFallback,
    basis: baseBasis + (bonusActive ? "（已含任务奖金池）" : ""),
    bonus: round2(bonusCents / 100),
    bonus_active: bonusActive,
    bonus_total_done: totalDone,
    bonus_contribution: bonusActive && count ? round2(bonusCents / count / 100) : 0,
    detail,
    transfers,
  };
}

// ---------- 概览 ----------
async function computeOverview(env, projectId, project) {
  const total = ((await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM purchases WHERE project_id = ?").bind(projectId).first()) || {}).s || 0;
  const famCount = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM families WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const memCount = ((await env.DB.prepare("SELECT COALESCE(SUM(member_count), 0) AS c FROM families WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const carryTotal = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM carry_items WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const carryDone = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM carry_items WHERE project_id = ? AND status = '已带'").bind(projectId).first()) || {}).c || 0;
  const shopTotal = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM shopping_items WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const shopDone = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM shopping_items WHERE project_id = ? AND status = '已购'").bind(projectId).first()) || {}).c || 0;

  return {
project: project ? { id: project.id, name: project.name, status: project.status } : null,
    total_amount: Math.round((Number(total) || 0) * 100) / 100,
    budget: Math.round((Number(project && project.budget) || 0) * 100) / 100,
    bonus: Math.round((Number(project && project.bonus) || 0) * 100) / 100,
    family_count: famCount,
    member_count: memCount,
    carry_total: carryTotal,
    carry_done: carryDone,
    shopping_total: shopTotal,
    shopping_done: shopDone,
  };
}

// ---------- 删除单条日志（高风险操作，需要管理权限密码）----------
// 刻意不再为「删除日志」补写一条日志，否则删掉的内容又会被以另一种形式留下来。
async function handleLogDelete(env, id, request, projectId, me) {
  if (!id) return err("缺少 id");
  const denied = requireProjectAdmin(request, me);
  if (denied) return denied;
  const old = await env.DB.prepare("SELECT id FROM logs WHERE id = ? AND project_id = ?").bind(id, projectId).first();
  if (!old) return err("日志不存在或已被删除", 404);
  await env.DB.prepare("DELETE FROM logs WHERE id = ? AND project_id = ?").bind(id, projectId).run();
  return json({ ok: true });
}

// ---------- 一键清除当前项目的全部日志（高风险操作，需要管理权限密码）----------
// 仅清除请求项目上下文（X-Project-Id）对应的日志，其它项目的日志不受影响。
// 与「删除单条日志」同理，刻意不再补写一条「清除了日志」的记录。
async function handleLogClear(env, request, projectId, me) {
  const denied = requireProjectAdmin(request, me);
  if (denied) return denied;
  const before = await env.DB.prepare("SELECT COUNT(*) AS c FROM logs WHERE project_id = ?").bind(projectId).first();
  await env.DB.prepare("DELETE FROM logs WHERE project_id = ?").bind(projectId).run();
  return json({ ok: true, deleted: (before && before.c) || 0 });
}

// ---------- 操作日志（项目内增量拉取）----------
async function handleLogs(env, request, projectId) {
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);
  const rows = await env.DB
    .prepare("SELECT * FROM logs WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
    .bind(projectId, since, limit)
    .all();
  return json({ ok: true, data: rows.results });
}