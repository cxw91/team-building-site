-- 团建管理网站 —— D1 / SQLite 数据库结构（多项目版）
-- 一个口令对应整个团队，团队下可以创建多个「团建项目」（如 2026 春季团建、2026 秋季团建），
-- 每个项目各自拥有自己的家庭、成员、携带物品、采购清单、采购记录与操作日志，项目之间数据互不影响。
-- 说明：使用 CREATE TABLE IF NOT EXISTS，重复执行不会破坏已有数据。
-- 从上一版（单项目、内置 6 个家庭）升级：表结构有变化，请先重建数据库（本地删除 .wrangler/state，
-- 线上先 DROP 旧表）再执行本文件。

-- 团建项目（顶层容器）
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',             -- 备注：日期 / 地点 / 说明
  status     TEXT NOT NULL DEFAULT '进行中',        -- 进行中 / 已结束
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 家庭 / 小组（分摊与结算的基本单位，创建项目时手动添加）
CREATE TABLE IF NOT EXISTS families (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,                     -- 所属项目
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 成员（挂在家庭下，创建项目时手动添加，可随时修改 / 删除）
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,                     -- 所属项目
  family_id  INTEGER NOT NULL,                     -- 所属家庭
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT '成员',
  note       TEXT NOT NULL DEFAULT '',             -- 忌口 / 过敏 / 特殊需求
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 携带物品（各家庭自管自己的，全员可见）
CREATE TABLE IF NOT EXISTS carry_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  quantity   TEXT NOT NULL DEFAULT '',
  family_id  INTEGER,                              -- 归属家庭
  status     TEXT NOT NULL DEFAULT '待带',           -- 待带 / 已带
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 采购清单（要买什么；不含预估价与实际价对比）
CREATE TABLE IF NOT EXISTS shopping_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  quantity   TEXT NOT NULL DEFAULT '',
  unit       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '待购',          -- 待购 / 已购
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 采购明细（谁买的、买了什么、花了多少）
CREATE TABLE IF NOT EXISTS purchases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL,
  item_id      INTEGER,                            -- 可选：关联采购清单项
  item_name    TEXT NOT NULL,
  family_id    INTEGER,                            -- 购买家庭
  amount       REAL NOT NULL DEFAULT 0,            -- 金额（元）
  quantity     TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 操作流水日志（记到家庭粒度）
CREATE TABLE IF NOT EXISTS logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL,
  actor_family_id INTEGER,                         -- 操作家庭
  actor_name      TEXT NOT NULL DEFAULT '',        -- 家庭名称快照
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL DEFAULT '',
  target_id       INTEGER,
  detail          TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_families_project  ON families(project_id);
CREATE INDEX IF NOT EXISTS idx_members_project   ON members(project_id);
CREATE INDEX IF NOT EXISTS idx_members_family    ON members(family_id);
CREATE INDEX IF NOT EXISTS idx_carry_project     ON carry_items(project_id);
CREATE INDEX IF NOT EXISTS idx_carry_family      ON carry_items(family_id);
CREATE INDEX IF NOT EXISTS idx_shopping_project  ON shopping_items(project_id);
CREATE INDEX IF NOT EXISTS idx_purchases_project ON purchases(project_id);
CREATE INDEX IF NOT EXISTS idx_purchases_family  ON purchases(family_id);
CREATE INDEX IF NOT EXISTS idx_logs_project      ON logs(project_id, id);