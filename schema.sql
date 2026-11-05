-- 团建管理网站 —— D1 / SQLite 数据库结构（多项目版）
-- 一个口令对应整个团队，团队下可以创建多个「团建项目」（如 2026 春季团建、2026 秋季团建），
-- 每个项目各自拥有自己的家庭、成员、携带物品、采购清单、采购记录与操作日志，项目之间数据互不影响。
-- 说明：使用 CREATE TABLE IF NOT EXISTS，重复执行不会破坏已有数据。
-- 从上一版（单项目、内置 6 个家庭）升级：表结构有变化，请先重建数据库（本地删除 .wrangler/state，
-- 线上先 DROP 旧表）再执行本文件。
-- 从「多项目版」升级到「接任务版」（新增采购清单「接任务」认领字段）：不必重建，执行以下两行即可：
--   ALTER TABLE shopping_items ADD COLUMN claimed_family_id INTEGER;
--   ALTER TABLE shopping_items ADD COLUMN claimed_at TEXT NOT NULL DEFAULT '';
-- 从「接任务版」升级到「预算版」（新增项目预算字段）：同样不必重建，执行以下一行即可：
--   ALTER TABLE projects ADD COLUMN budget REAL NOT NULL DEFAULT 0;
-- 从「预算版」升级到「多口令版」（新增口令表与项目归属字段，用于按口令隔离项目数据）：
--   后端首次运行会自动补建下表与字段（见 functions/api/[[path]].js 的 ensureSchema），
--   若想在库里显式留痕，可执行以下三行：
--   CREATE TABLE IF NOT EXISTS passcodes (id INTEGER PRIMARY KEY AUTOINCREMENT, passcode TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', admin_passcode TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
--   ALTER TABLE projects ADD COLUMN passcode_id INTEGER;
--   UPDATE projects SET passcode_id = (SELECT MIN(id) FROM passcodes) WHERE passcode_id IS NULL;
-- 「按口令的管理员密码版」升级（passcodes 增加 admin_passcode）：同样可依赖后端 ensureSchema 自动补建并初始化，或执行：
--   ALTER TABLE passcodes ADD COLUMN admin_passcode TEXT NOT NULL DEFAULT '';
--   然后由后端把空值初始化为当前 ADMIN_PASSCODE（也可以手动 UPDATE 指定各口令自己的密码）。

-- 从「按口令的管理员密码版」升级到「任务奖金版」（projects 新增任务奖金字段）：不必重建，执行以下一行即可
-- （后端首次运行也会自动补建，见 functions/api/[[path]].js 的 ensureSchema）：
--   ALTER TABLE projects ADD COLUMN bonus REAL NOT NULL DEFAULT 0;

-- 口令（租户）：一个口令对应一份独立的项目数据；登录某口令只能看到它名下的项目。
-- 口令的新增 / 修改 / 删除需要管理权限密码（ADMIN_PASSCODE），在登录页即可操作。
CREATE TABLE IF NOT EXISTS passcodes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  passcode       TEXT NOT NULL UNIQUE,             -- 登录口令（明文比对）
  name           TEXT NOT NULL DEFAULT '',         -- 备注名
  admin_passcode TEXT NOT NULL DEFAULT '',         -- 本口令的管理员密码：同一口令下的项目共用它
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 团建项目（顶层容器）
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',             -- 备注：日期 / 地点 / 说明
status     TEXT NOT NULL DEFAULT '进行中',        -- 进行中 / 已结束
  budget     REAL NOT NULL DEFAULT 0,              -- 项目预算（元）；0 表示未设置（页面显示「无」）
  bonus      REAL NOT NULL DEFAULT 0,              -- 任务奖金池（元）；0 表示未设置。由各家均摊出资，
                                                  -- 按「已完成采购」的任务数比例分配，计入结算应摊
  passcode_id INTEGER,                             -- 归属口令（passcodes.id）：不同口令之间项目互相不可见
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
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  name              TEXT NOT NULL,
  quantity          TEXT NOT NULL DEFAULT '',
  unit              TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT '待购',     -- 待购 / 已购
  claimed_family_id INTEGER,                        -- 接任务：认领该采购项的家庭，NULL = 尚未有人接
  claimed_at        TEXT NOT NULL DEFAULT '',       -- 认领时间
  note              TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE INDEX IF NOT EXISTS idx_projects_passcode ON projects(passcode_id);
CREATE INDEX IF NOT EXISTS idx_families_project  ON families(project_id);
CREATE INDEX IF NOT EXISTS idx_members_project   ON members(project_id);
CREATE INDEX IF NOT EXISTS idx_members_family    ON members(family_id);
CREATE INDEX IF NOT EXISTS idx_carry_project     ON carry_items(project_id);
CREATE INDEX IF NOT EXISTS idx_carry_family      ON carry_items(family_id);
CREATE INDEX IF NOT EXISTS idx_shopping_project  ON shopping_items(project_id);
CREATE INDEX IF NOT EXISTS idx_shopping_claimed  ON shopping_items(claimed_family_id);
CREATE INDEX IF NOT EXISTS idx_purchases_project ON purchases(project_id);
CREATE INDEX IF NOT EXISTS idx_purchases_family  ON purchases(family_id);
CREATE INDEX IF NOT EXISTS idx_logs_project      ON logs(project_id, id);