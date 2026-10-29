// 团建管理网站 —— Pages Functions 统一 API 入口（多项目版）
// 路由：/api/<route>[/<id>]
// 鉴权：全队单一共享口令。登录后返回 token，后续请求携带 Authorization: Bearer <token>
// 项目上下文：除 /auth/login、/health、/projects 外，其余接口都需要 X-Project-Id 头（或 ?project_id=），
//             所有读写都限定在该项目内，不同项目之间数据互不影响。
// 操作身份：进入项目后选择“我属于哪个家庭”，通过 X-Family-Id 头传入，日志记到家庭粒度。

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
    const proj = await env.DB.prepare("SELECT id, name, status FROM projects WHERE id = ?").bind(projectId).first();
    if (!proj) return err("项目不存在或已被删除", 404);

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
        if (method !== "GET") return err("不支持的方法", 405);
        return handleLogs(env, request, projectId);
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
    await env.DB
      .prepare("UPDATE projects SET name = ?, note = ?, status = ? WHERE id = ?")
      .bind(nextName, String(b.note ?? old.note), nextStatus, id)
      .run();
    await addLog(env, id, {
      familyId: null,
      action: nextStatus !== old.status ? `项目状态改为「${nextStatus}」` : "修改项目",
      targetType: "project",
      targetId: id,
      detail: nextName,
    });
    return json({ ok: true });
  }

  if (method === "DELETE") {
    if (!id) return err("缺少 id");
    const old = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
    if (!old) return err("项目不存在", 404);
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
    const nextFamily = b.family_id !== undefined ? toId(b.family_id) : old.family_id;
    if (nextFamily && nextFamily !== old.family_id) {
      const fam = await env.DB
        .prepare("SELECT id FROM families WHERE id = ? AND project_id = ?")
        .bind(nextFamily, projectId)
        .first();
      if (!fam) return err("所选家庭不属于当前项目", 400);
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
    const rows = await env.DB
      .prepare("SELECT * FROM shopping_items WHERE project_id = ? ORDER BY status, id")
      .bind(projectId)
      .all();
    return json({ ok: true, data: rows.results });
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
    const amount = Number(b.amount) || 0;
    const itemId = toId(b.item_id);
    const r = await env.DB
      .prepare(
        "INSERT INTO purchases (project_id, item_id, item_name, family_id, amount, quantity, note) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(projectId, itemId, itemName, familyId, amount, b.quantity || "", b.note || "")
      .run();
    // 若关联了采购清单项，自动把该清单项标记为已购
    if (itemId) {
      await env.DB.prepare("UPDATE shopping_items SET status = '已购' WHERE id = ? AND project_id = ?").bind(itemId, projectId).run();
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
    await env.DB
      .prepare("UPDATE purchases SET item_name = ?, family_id = ?, amount = ?, quantity = ?, note = ? WHERE id = ? AND project_id = ?")
      .bind(
        String(b.item_name ?? old.item_name).trim() || old.item_name,
        toId(b.family_id) || old.family_id,
        b.amount !== undefined ? Number(b.amount) || 0 : old.amount,
        b.quantity ?? old.quantity,
        b.note ?? old.note,
        id,
        projectId
      )
      .run();
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
    await env.DB.prepare("DELETE FROM purchases WHERE id = ? AND project_id = ?").bind(id, projectId).run();
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
    family_count: famCount,
    member_count: memCount,
    carry_total: carryTotal,
    carry_done: carryDone,
    shopping_total: shopTotal,
    shopping_done: shopDone,
  };
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