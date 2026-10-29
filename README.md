# 团建管理小网站

一个面向小团队团建的后勤管理站点：把「谁出人、谁带东西、谁买什么、谁花了多少钱」都记在同一个页面上，并实时看到彼此的操作。**支持同时管理多个团建项目**，每个项目的数据彼此隔离。

**技术栈**：Cloudflare Pages（静态前端） + Pages Functions（接口） + D1（SQLite 数据库）。整套东西都在 Cloudflare 免费额度内，无需自建服务器。

---

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 口令进入 | 全队共用一个口令（邀请码），不注册个人账号；登录后进入**项目中心** |
| 项目中心 | 登录后新建团建项目（名称 + 备注），或从历史项目列表进入已有项目；项目可改名、结束/重启、删除 |
| 家庭与成员 | **不内置任何家庭和成员**：创建项目时手动添加家庭，家庭成员可随时增删改；进入项目后还可新增家庭、重命名家庭 |
| 概览看板 | 总花费、每家应摊、家庭/成员数、携带与采购完成进度、最近操作 |
| 携带物品 | 每个家庭自己维护自家的携带物品，**所有家庭都能看到**（只读他人） |
| 采购清单 | 项目内公共的「要买什么」清单，任意家庭可增删、可标记待购/已购 |
| 采购记录 | 记录每一笔「谁买的、买了什么、花了多少」，并汇总每家已垫付金额 |
| 结算 | **按家庭数均分**总花费，算出每家差额，给出**最少笔数**的转账建议 |
| 操作日志 | 家庭粒度的操作流水（谁家、何时、做了什么），页面每 10 秒自动同步，别人一操作这边就能看到 |

---

## 多项目模型

- 一个口令 = 一个团队。团队下可以有多个**团建项目**（如「2026 春季团建」「2026 秋季团建」）。
- 每个项目**独立**拥有自己的家庭、成员、携带物品、采购清单、采购记录与操作日志，项目之间数据互不影响。
- 每次业务请求都会带上当前项目标识（`X-Project-Id`），接口层按项目做隔离，不会串数据。
- 家庭与成员**不预置**：建项目时在表单里逐行填写「家庭名称 + 成员姓名（用「、」分隔，可留空）」即可；进入项目后也能对成员做增 / 删 / 改。
- **分摊口径**：总花费 ÷ 家庭数。因此新增或删除家庭会直接改变「每家应摊」金额，请在建项目时把家庭数定准。

---

## 目录结构

```
team-building-site/
├── public/               # 前端静态资源（Pages 直接托管）
│   ├── index.html        # 口令登录 / 项目中心 / 选择家庭 / 主界面
│   ├── app.js            # 页面逻辑 + 10 秒轮询同步
│   └── style.css
├── functions/
│   └── api/[[path]].js   # 所有后端接口（Pages Functions）
├── schema.sql            # 建表脚本（D1 / SQLite）
├── seed.sql              # 可选：一键导入「1 个示例项目 + 6 个家庭」演示数据
├── wrangler.toml         # 项目与 D1 绑定配置
├── package.json          # 本地命令
└── .dev.vars             # 本地开发用口令（PASSCODE）
```

---

## 本地开发

前置：Node.js 18+。

```bash
cd team-building-site
npm install                 # 安装 wrangler
npm run db:init             # 本地建表（生成模拟 D1）
npm run db:seed             # 可选：导入演示数据（1 个示例项目 + 6 个家庭）
npm run dev                 # 启动本地站点
```

启动后打开 <http://127.0.0.1:8788>，输入口令（默认见 `.dev.vars` 里的 `PASSCODE`，当前为 `team2026`）。

- 本地数据保存在 `.wrangler/state/` 下，删掉该目录即可清空重置。
- 更换本地口令：直接改 `.dev.vars` 里的 `PASSCODE`，重启 `npm run dev` 生效。

可用命令：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 本地启动（端口 8788） |
| `npm run db:init` | 本地建表 |
| `npm run db:seed` | 本地导入演示数据 |
| `npm run deploy` | 部署到 Cloudflare Pages |

---

## 部署到 Cloudflare Pages

前提：一个 Cloudflare 账号；本机装好 Node.js（命令都用 `npx wrangler`，无需全局安装）。

部署分两种情况：**首次部署**（第一次上线，要把 Pages 项目、线上数据库、进入口令都建起来）和**后续更新**（项目已存在，只推代码）。首次部署的顺序比较讲究，见下。

### 一、首次部署

顺序关键点：**Pages 项目必须先存在**，Dashboard 里才能进去配环境变量和 D1 绑定。所以实际顺序是「先建库 → 先部署一次把项目建出来 → 回控制台配口令与绑定 → 再部署一次」。

**步骤 1：创建 D1 数据库**

```bash
npx wrangler login
npx wrangler d1 create team_building
```

命令会输出一段 `[[d1_databases]]` 配置，把其中的 `database_id` 复制到 `wrangler.toml`，替换掉占位的 `local-dev-placeholder`。

**步骤 2：把表结构写入线上 D1**

```bash
npx wrangler d1 execute team_building --remote --file=./schema.sql
# 可选：导入演示数据（1 个示例项目 + 6 个家庭）
npx wrangler d1 execute team_building --remote --file=./seed.sql
```

**步骤 3：先部署一次，把 Pages 项目建出来**

```bash
npx wrangler pages deploy public --project-name=team-building-site
```

首次执行会提示创建 Pages 项目（省略 `--project-name` 也可以，按提示选择或新建）。完成后拿到一个 `*.pages.dev` 网址。

> 此时网页能打开，但**还登不进去**：`PASSCODE` 环境变量和 D1 绑定都没配，接口读不到口令、连不上数据库。这是正常的，下一步补齐即可。

**步骤 4：回控制台配好口令与数据库绑定**

进入 Cloudflare Dashboard → **Workers 和 Pages** → 选中刚创建的项目：

- **Settings → Variables and Secrets**（旧界面叫 Environment variables）添加：
  - 名称：`PASSCODE`
  - 值：你想要的全队口令
  - 环境：Production（建议 Preview 也加一份）
- **Settings → Functions → D1 database bindings** 添加绑定：
  - Variable name：`DB`（必须叫这个名字，代码就是按它取数据库的）
  - D1 database：`team_building`

（本地开发由 `wrangler.toml` 提供绑定；线上需要在这里再绑一次。）

**步骤 5：再部署一次，让配置生效**

```bash
npx wrangler pages deploy public --project-name=team-building-site
```

（在 Dashboard 点一次「重新部署」效果相同。）完成后打开 `*.pages.dev`，用第 4 步设的口令登录。

**步骤 6：验证**

- 能进登录页，输入口令后进入项目中心；
- 新建一个项目并添加两三个家庭，刷新页面数据还在——说明 D1 绑定正确、写入正常。

### 二、后续更新

项目已存在时，改完代码直接推，不需要重复上面的配置：

```bash
npx wrangler pages deploy public --project-name=team-building-site
```

- 环境变量与 D1 绑定只需首次配置一次，后续部署不会丢失。
- 只有**改了数据库表结构**（新增表或字段）才要额外执行一次 `npx wrangler d1 execute team_building --remote --file=./schema.sql` 应用变更。
- 若是从上一版（单项目、内置 6 个家庭）升级上来，线上表结构不兼容，需**先 `DROP` 旧表再执行新的 `schema.sql`**。

### 三、改用 Git 集成自动部署（可选）

也可以让 Cloudflare 在每次 push 时自动构建部署：

1. Dashboard → Workers 和 Pages → 创建 → 选 **Pages** → **导入现有 Git 存储库**，授权后选好仓库；
2. 构建配置：**Build command 留空**，**Build output directory 填 `public`**（纯静态项目，没有构建步骤）；
3. 点保存并部署，拿到 `*.pages.dev`；
4. 首次同样要回到 **Settings** 配好 `PASSCODE` 环境变量和 `DB` 的 D1 绑定，然后再触发一次部署。

之后每次 push 会自动重新部署。

---

## 接口清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 口令登录，返回 token |
| GET | `/api/health` | 健康检查 |
| GET | `/api/projects` | 项目列表（含家庭数 / 成员数 / 已花费统计） |
| POST | `/api/projects` | 新建项目（可同时写入家庭与成员） |
| GET/PUT/DELETE | `/api/projects/:id` | 项目详情 / 改名改状态 / 删除（级联清理） |
| GET/POST/PUT/DELETE | `/api/families[/:id]` | 家庭（需项目上下文） |
| GET/POST/PUT/DELETE | `/api/members[/:id]` | 成员（需项目上下文） |
| GET/POST/PUT/DELETE | `/api/carry-items[/:id]` | 携带物品（需项目上下文） |
| GET/POST/PUT/DELETE | `/api/shopping-items[/:id]` | 采购清单（需项目上下文） |
| GET/POST/PUT/DELETE | `/api/purchases[/:id]` | 采购明细（需项目上下文） |
| GET | `/api/overview` | 概览统计（需项目上下文） |
| GET | `/api/settlement` | 结算与转账建议（需项目上下文） |
| GET | `/api/logs?since=&limit=` | 增量拉取操作日志（需项目上下文） |

除 `login` 与 `health` 外，其余接口都需要 `Authorization: Bearer <token>`；`/api/projects` 之外的业务接口还需带 `X-Project-Id` 指定当前项目；写操作建议同时带 `X-Family-Id`。

---

## 数据备份

D1 数据可用 wrangler 导出：

```bash
npx wrangler d1 export team_building --remote --output=backup.sql
```