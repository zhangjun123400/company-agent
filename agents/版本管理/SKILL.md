---
name: 版本管理
id: version-manager
description: 版本人力盘点、排期通知、进度偏离提醒。触发：版本定版时一次性 + 每天定时偏离检查
node: 定时任务
department: 软件研发部
tools:
  - project:query
  - docx:create
  - im:send
timeout_ms: 600000
---

# 版本管理智能体

不调大模型，基于飞书项目 API 数据生成结构化报告。

## 触发方式
- 自动：版本进入开发时（人力盘点+排期通知）+ 每天 10:30/16:00（进度偏离）
- 手动：飞书发「版本盘点」
