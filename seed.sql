-- 团建管理网站 —— 可选演示数据（多项目版）
-- 用法（本地）：npm run db:seed
-- 用法（线上）：npx wrangler d1 execute team_building --remote --file=./seed.sql
-- 说明：本文件只创建「1 个示例项目 + 6 个家庭」，不内置任何成员，
--       成员请在网页里「创建项目」时手动添加，或进入项目后按需增删改。
-- 重复执行会重复插入，请勿在已有正式数据的库上运行。

INSERT INTO projects (name, note, status) VALUES
  ('2026 秋季团建', '示例项目：10 月 · 近郊露营基地', '进行中');

-- 示例项目下的 6 个家庭（不预置成员）
INSERT INTO families (project_id, name, note) VALUES
  (1, '陈家', ''),
  (1, '林家', ''),
  (1, '王家', ''),
  (1, '李家', ''),
  (1, '赵家', ''),
  (1, '孙家', '');

-- 携带物品 / 采购清单 / 采购记录默认留空，由各家庭在页面里自行登记。