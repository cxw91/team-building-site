-- 团建管理网站 —— 可选演示数据（多项目版）
-- 用法（本地）：npm run db:seed
-- 用法（线上）：npx wrangler d1 execute team_building --remote --file=./seed.sql
-- 说明：本文件只创建「1 个示例项目 + 6 个家庭」，人数与忌口备注直接登记在家庭上，
--       不再按姓名逐条插入 members 表；也可以在网页里「创建项目」时手动填写。
-- 重复执行会重复插入，请勿在已有正式数据的库上运行。

INSERT INTO projects (name, note, status) VALUES
  ('2026 秋季团建', '示例项目：10 月 · 近郊露营基地', '进行中');

-- 示例项目下的 6 个家庭：人数各不相同，方便直接体验「按人数均分」结算
INSERT INTO families (project_id, name, note, member_count) VALUES
  (1, '陈家', '', 2),
  (1, '林家', '有人海鲜过敏', 4),
  (1, '王家', '', 3),
  (1, '李家', '', 2),
  (1, '赵家', '忌辣', 5),
  (1, '孙家', '', 1);

-- 携带物品 / 采购清单 / 采购记录默认留空，由各家庭在页面里自行登记。