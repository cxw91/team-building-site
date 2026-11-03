// 团建管理网站 —— Pages Functions 统一 API 入口（多项目版）
// 路由：/api/<route>[/<id>]
// 鉴权：全队单一共享口令。登录后返回 token，后续请求携带 Authorization: Bearer <token>
// 项目上下文：除 /auth/login、/health、/projects 外，其余接口都需要 X-Project-Id 头（或 ?project_id=），
//             所有读写都限定在该项目内，不同项目之间数据互不影响。
// 操作身份：进入项目后选择“我属于哪个家庭”，通过 X-Family-Id 头传入，日志记到家庭粒度。
// 管理权限密码（第二个口令，环境变量 ADMIN_PASSCODE）：用于五类高风险操作 ——
//   1) 删除单条日志        DELETE /api/logs/<id>
//   2) 清除项目全部日志    DELETE /api/logs      （不带 id，仅清当前项目）
//   3) 删除项目（历史项目）DELETE /api/projects/<id>
//   4) 结束项目            PUT /api/projects/<id>  状态 进行中 → 已结束
//   5) 重启已结束的项目    PUT /api/projects/<id>  状态 已结束 → 进行中
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

// ---------- 鉴权与上下文 ----------
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function tokenFor(passcode) {
  return sha256Hex("team-building::" + (passcode || ""));
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

// ---------- 管理权限密码（第二道口令，用于删除日志 / 删除项目 / 重启项目）----------
// 返回 null 表示校验通过；返回 Response 表示应直接把它作为结果返回。
function requireAdmin(request, env) {
  const expected = String(env.ADMIN_PASSCODE || "").trim();
  if (!expected) {
    return err("服务器未配置管理权限密码（环境变量 ADMIN_PASSCODE），请联系管理员在 Cloudflare 后台补充", 500);
  }
  const provided = String(request.headers.get("x-admin-passcode") || "").trim();
  if (!provided) return err("该操作需要管理权限密码", 403);
  if (provided !== expected) return err("管理权限密码不正确", 403);
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

    if (route === "auth" && segs[1] === "login" && method === "POST") {
      const body = await readJson(request);
      const ok = body && String(body.passcode || "") === String(env.PASSCODE || "");
      if (!ok) return err("口令不正确", 401);
      return json({ ok: true, token: await tokenFor(env.PASSCODE) });
    }

    // 以下接口均需登录
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token || token !== (await tokenFor(env.PASSCODE))) {
      return err("未登录或口令已失效", 401);
    }

    // 项目本身的管理（列表 / 新建 / 详情 / 改名 / 结束 / 删除）不需要项目上下文
    if (route === "projects") {
      return handleProjects(env, method, id, request);
    }

    // 其余业务接口都需要项目上下文，且项目必须真实存在
    const projectId = requestProjectId(request);
    if (!projectId) return err("缺少项目信息，请先选择或新建团建项目", 400);
    const proj = await env.DB.prepare("SELECT id, name, status, budget FROM projects WHERE id = ?").bind(projectId).first();
    if (!proj) return err("项目不存在或已被删除", 404);

    // 已结束的项目只读：查看没问题，但项目内任何内容都不能再改
    if (proj.status === "已结束" && method !== "GET") {
      return err("项目已结束，只能查看；如需修改请先用管理权限密码重启项目", 403);
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
          if (id) return handleLogDelete(env, id, request, projectId);
          return handleLogClear(env, request, projectId);
        }
        return err("不支持的方法", 405);
      default:
        return err("接口不存在", 404);
    }
  } catch (e) {
    return err("服务器错误：" + (e && e.message ? e.message : String(e)), 500);
  }
}

// ---------- 项目 ----------
async function handleProjects(env, method, id, request) {
  if (method === "GET" && !id) {
    // 项目列表（含统计），最新创建的排前面 —— 也就是「历史项目」列表
    const rows = await env.DB
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*)                 FROM families f  WHERE f.project_id  = p.id) AS family_count,
           (SELECT COUNT(*)                 FROM members m   WHERE m.project_id  = p.id) AS member_count,
           (SELECT COALESCE(SUM(amount), 0) FROM purchases u WHERE u.project_id  = p.id) AS total_amount
         FROM projects p
         ORDER BY p.id DESC`
      )
      .all();
    return json({ ok: true, data: rows.results });
  }

  if (method === "GET" && id) {
    const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
    if (!project) return err("项目不存在", 404);
    const families = (await env.DB.prepare("SELECT * FROM families WHERE project_id = ? ORDER BY id").bind(id).all())
      .results;
    const members = (
      await env.DB.prepare("SELECT * FROM members WHERE project_id = ? ORDER BY family_id, id").bind(id).all()
    ).results;
    return json({ ok: true, data: { project, families, members } });
  }

if (method === "POST") {
    // 新建项目属于需要管理权限密码的操作（与结束 / 删除项目同一套 ADMIN_PASSCODE）
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    const b = await readJson(request);
    const name = String((b && b.name) || "").trim();
    if (!name) return err("缺少项目名称");
    const note = String((b && b.note) || "").trim();
    const families = Array.isArray(b && b.families) ? b.families : [];

    const r = await env.DB
      .prepare("INSERT INTO projects (name, note, status) VALUES (?, ?, ?)")
      .bind(name, note, "进行中")
      .run();
    const pid = r.meta.last_row_id;

    // 创建项目时手动写入的家庭与成员（均可留空，之后再补）
    let familyCount = 0;
    let memberCount = 0;
    for (const f of families) {
      const famName = String((f && f.name) || "").trim();
      if (!famName) continue;
      const fr = await env.DB
        .prepare("INSERT INTO families (project_id, name, note) VALUES (?, ?, ?)")
        .bind(pid, famName, String((f && f.note) || "").trim())
        .run();
      familyCount++;
      const rawMembers = Array.isArray(f && f.members) ? f.members : [];
      for (const m of rawMembers) {
        const memName = String((typeof m === "string" ? m : (m && m.name) || "") || "").trim();
        if (!memName) continue;
        const role = (typeof m === "object" && m && String(m.role || "").trim()) || "成员";
        const memNote = (typeof m === "object" && m && String(m.note || "").trim()) || "";
        await env.DB
          .prepare("INSERT INTO members (project_id, family_id, name, role, note) VALUES (?, ?, ?, ?, ?)")
          .bind(pid, fr.meta.last_row_id, memName, role, memNote)
          .run();
        memberCount++;
      }
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
    const old = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
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
    // 设置 / 修改 / 取消预算都属于高风险操作，需要管理权限密码（与删除日志等同一套 ADMIN_PASSCODE）
    if (hasBudget) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
    }
    // 项目改名同样需要管理权限密码；只改备注等其它字段不需要
    if (nextName !== old.name) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
    }

    // 已结束的项目只能查看：改名 / 改备注 / 改预算 / 再次结束都不允许
    const isRestart = old.status === "已结束" && nextStatus === "进行中";
    if (old.status === "已结束" && !isRestart) {
      return err("项目已结束，只能查看；如需修改请先用管理权限密码重启项目", 403);
    }
    // 结束项目 / 重启已结束的项目都属于高风险操作，需要管理权限密码
    const isEnd = old.status !== "已结束" && nextStatus === "已结束";
    if (isRestart || isEnd) {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
    }

    await env.DB
      .prepare("UPDATE projects SET name = ?, note = ?, status = ?, budget = ? WHERE id = ?")
      .bind(nextName, String(b.note ?? old.note), nextStatus, nextBudget, id)
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
    if (nextStatus !== old.status) {
      await addLog(env, id, {
        familyId: null,
        action: `项目状态改为「${nextStatus}」`,
        targetType: "project",
        targetId: id,
        detail: nextName,
      });
    }
    if (!budgetChanged && nextStatus === old.status) {
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
    const old = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
    if (!old) return err("项目不存在", 404);
    // 删除项目（含历史项目）属于高风险操作，需要管理权限密码
    const denied = requireAdmin(request, env);
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
    const r = await env.DB
      .prepare("INSERT INTO families (project_id, name, note) VALUES (?, ?, ?)")
      .bind(projectId, String(b.name).trim(), String(b.note || ""))
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "新增家庭",
      targetType: "family",
      targetId: r.meta.last_row_id,
      detail: String(b.name).trim(),
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
    await env.DB
      .prepare("UPDATE families SET name = ?, note = ? WHERE id = ? AND project_id = ?")
      .bind(String(b.name ?? old.name).trim() || old.name, b.note ?? old.note, id, projectId)
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "修改家庭",
      targetType: "family",
      targetId: id,
      detail: old.name + " → " + String(b.name ?? old.name).trim(),
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

// ---------- 成员（项目内，手动添加 / 修改 / 删除）----------
async function handleMembers(env, method, id, request, projectId) {
  if (method === "GET") {
    const rows = await env.DB
      .prepare("SELECT * FROM members WHERE project_id = ? ORDER BY family_id, id")
      .bind(projectId)
      .all();
    return json({ ok: true, data: rows.results });
  }
  if (method === "POST") {
    const b = await readJson(request);
    const name = String((b && b.name) || "").trim();
    const familyId = toId(b && b.family_id);
    if (!name || !familyId) return err("请填写成员姓名并选择所属家庭");
    const fam = await env.DB
      .prepare("SELECT id FROM families WHERE id = ? AND project_id = ?")
      .bind(familyId, projectId)
      .first();
    if (!fam) return err("所选家庭不属于当前项目", 400);
    const ownGuard = requireOwnFamily(request, familyId);
    if (ownGuard) return ownGuard;
    const r = await env.DB
      .prepare("INSERT INTO members (project_id, family_id, name, role, note) VALUES (?, ?, ?, ?, ?)")
      .bind(projectId, familyId, name, String((b && b.role) || "成员"), String((b && b.note) || ""))
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "新增成员",
      targetType: "member",
      targetId: r.meta.last_row_id,
      detail: name,
    });
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if (method === "PUT") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!old) return err("成员不存在", 404);
    const b = (await readJson(request)) || {};
    const ownGuard = requireOwnFamily(request, old.family_id);
    if (ownGuard) return ownGuard;
    const nextFamily = b.family_id !== undefined ? toId(b.family_id) : old.family_id;
    if (nextFamily && Number(nextFamily) !== Number(old.family_id)) {
      return err("不能把成员移到其他家庭，其他家庭只能查看", 403);
    }
    const nextName = String(b.name ?? old.name).trim() || old.name;
    await env.DB
      .prepare("UPDATE members SET name = ?, role = ?, note = ?, family_id = ? WHERE id = ? AND project_id = ?")
      .bind(nextName, b.role ?? old.role, b.note ?? old.note, nextFamily || old.family_id, id, projectId)
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "修改成员",
      targetType: "member",
      targetId: id,
      detail: old.name === nextName ? nextName : old.name + " → " + nextName,
    });
    return json({ ok: true });
  }
  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND project_id = ?").bind(id, projectId).first();
    if (!old) return err("成员不存在", 404);
    const ownGuard = requireOwnFamily(request, old.family_id);
    if (ownGuard) return ownGuard;
    await env.DB.prepare("DELETE FROM members WHERE id = ? AND project_id = ?").bind(id, projectId).run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "删除成员",
      targetType: "member",
      targetId: id,
      detail: old.name,
    });
    return json({ ok: true });
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
    const r = await env.DB
      .prepare("INSERT INTO carry_items (project_id, name, quantity, family_id, status, note) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(projectId, String(b.name).trim(), b.quantity || "", familyId, b.status || "待带", b.note || "")
      .run();
    await addLog(env, projectId, {
      familyId: myFamily,
      action: "新增携带物品",
      targetType: "carry_item",
      targetId: r.meta.last_row_id,
      detail: String(b.name).trim(),
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
    await env.DB
      .prepare("UPDATE carry_items SET name = ?, quantity = ?, status = ?, note = ? WHERE id = ? AND project_id = ?")
      .bind(b.name ?? old.name, b.quantity ?? old.quantity, b.status ?? old.status, b.note ?? old.note, id, projectId)
      .run();
    await addLog(env, projectId, {
      familyId: myFamily,
      action: "修改携带物品",
      targetType: "carry_item",
      targetId: id,
      detail: `${b.name ?? old.name}（${b.status ?? old.status}）`,
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
    const r = await env.DB
      .prepare("INSERT INTO shopping_items (project_id, name, quantity, unit, status, note) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(projectId, String(b.name).trim(), b.quantity || "", b.unit || "", b.status || "待购", b.note || "")
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "新增采购项",
      targetType: "shopping_item",
      targetId: r.meta.last_row_id,
      detail: String(b.name).trim(),
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

    await env.DB
      .prepare("UPDATE shopping_items SET name = ?, quantity = ?, unit = ?, status = ?, note = ? WHERE id = ? AND project_id = ?")
      .bind(
        b.name ?? old.name,
        b.quantity ?? old.quantity,
        b.unit ?? old.unit,
        b.status ?? old.status,
        b.note ?? old.note,
        id,
        projectId
      )
      .run();
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "修改采购项",
      targetType: "shopping_item",
      targetId: id,
      detail: `${b.name ?? old.name}（${b.status ?? old.status}）`,
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
    // 若要把这笔采购改记到别的家庭，该家庭同样必须属于当前项目
    const nextFamily = b.family_id !== undefined ? toId(b.family_id) : null;
    if (nextFamily) {
      const belong = await env.DB
        .prepare("SELECT id FROM families WHERE id = ? AND project_id = ?")
        .bind(nextFamily, projectId)
        .first();
      if (!belong) return err("所选家庭不属于当前项目", 400);
    }
    const nextItemName = String(b.item_name ?? old.item_name).trim() || old.item_name;
    await env.DB
      .prepare("UPDATE purchases SET item_name = ?, family_id = ?, amount = ?, quantity = ?, note = ? WHERE id = ? AND project_id = ?")
      .bind(
        nextItemName,
        nextFamily || old.family_id,
        b.amount !== undefined ? Number(b.amount) || 0 : old.amount,
        b.quantity ?? old.quantity,
        b.note ?? old.note,
        id,
        projectId
      )
      .run();
    // 名称改掉以后，原先关联的清单项可能已经没有采购记录了：两边都按记录重新派生一次
    const beforeItem = await findLinkedShopItem(env, projectId, old.item_id, old.item_name);
    if (beforeItem) await syncShopItemStatus(env, projectId, beforeItem.id);
    const afterItem = await findLinkedShopItem(env, projectId, old.item_id, nextItemName);
    if (afterItem && (!beforeItem || afterItem.id !== beforeItem.id)) await syncShopItemStatus(env, projectId, afterItem.id);
    await addLog(env, projectId, {
      familyId: actorFamilyId(request),
      action: "修改采购",
      targetType: "purchase",
      targetId: id,
      detail: `${b.item_name ?? old.item_name} ¥${b.amount !== undefined ? b.amount : old.amount}`,
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

// ---------- 结算（按家庭数均分 + 转账建议）----------
async function computeSettlement(env, projectId) {
  const fams = (await env.DB.prepare("SELECT id, name FROM families WHERE project_id = ? ORDER BY id").bind(projectId).all()).results;
  const purs = (await env.DB.prepare("SELECT family_id, amount FROM purchases WHERE project_id = ?").bind(projectId).all()).results;

  const total = purs.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const count = fams.length;             // 分摊口径：按家庭数均分
  const share = count > 0 ? total / count : 0;

  const paidMap = {};
  for (const p of purs) {
    if (p.family_id == null) continue;
    paidMap[p.family_id] = (paidMap[p.family_id] || 0) + (Number(p.amount) || 0);
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const detail = fams.map((f) => {
    const paid = paidMap[f.id] || 0;
    return {
      family_id: f.id,
      name: f.name,
      paid: round2(paid),
      share: round2(share),
      balance: round2(paid - share),
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

  return { total: round2(total), family_count: count, share: round2(share), basis: "按家庭数均分", detail, transfers };
}

// ---------- 概览 ----------
async function computeOverview(env, projectId, project) {
  const total = ((await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM purchases WHERE project_id = ?").bind(projectId).first()) || {}).s || 0;
  const famCount = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM families WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const memCount = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM members WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const carryTotal = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM carry_items WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const carryDone = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM carry_items WHERE project_id = ? AND status = '已带'").bind(projectId).first()) || {}).c || 0;
  const shopTotal = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM shopping_items WHERE project_id = ?").bind(projectId).first()) || {}).c || 0;
  const shopDone = ((await env.DB.prepare("SELECT COUNT(*) AS c FROM shopping_items WHERE project_id = ? AND status = '已购'").bind(projectId).first()) || {}).c || 0;

  return {
project: project ? { id: project.id, name: project.name, status: project.status } : null,
    total_amount: Math.round((Number(total) || 0) * 100) / 100,
    budget: Math.round((Number(project && project.budget) || 0) * 100) / 100,
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
async function handleLogDelete(env, id, request, projectId) {
  if (!id) return err("缺少 id");
  const denied = requireAdmin(request, env);
  if (denied) return denied;
  const old = await env.DB.prepare("SELECT id FROM logs WHERE id = ? AND project_id = ?").bind(id, projectId).first();
  if (!old) return err("日志不存在或已被删除", 404);
  await env.DB.prepare("DELETE FROM logs WHERE id = ? AND project_id = ?").bind(id, projectId).run();
  return json({ ok: true });
}

// ---------- 一键清除当前项目的全部日志（高风险操作，需要管理权限密码）----------
// 仅清除请求项目上下文（X-Project-Id）对应的日志，其它项目的日志不受影响。
// 与「删除单条日志」同理，刻意不再补写一条「清除了日志」的记录。
async function handleLogClear(env, request, projectId) {
  const denied = requireAdmin(request, env);
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