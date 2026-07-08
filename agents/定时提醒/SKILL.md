---
name: 定时提醒
id: overdue-reminder
description: 按 reminder-rules.json 规则扫描飞书项目节点，超时自动 IM 提醒
node: 定时任务
department: 软件研发部
tools:
  - project:query
  - im:send
timeout_ms: 300000
---

# 定时提醒智能体

本智能体由**时间轮基座**（`src/core/timewheel.ts`）独立驱动，不走标准 Agent 调度管线。

## 执行方式

| 方式 | 说明 |
|------|------|
| 自动 | 时间轮每天 10:30 和 16:00 各执行一次全量检查 |
| 手动 | 飞书给智小协发 `检查超时` / `超时提醒` / `提醒` |

## 规则配置

所有提醒规则集中在 `config/reminder-rules.json`，每条规则包含：
- `trigger.on`: `after_create`（工作项创建后计时）或 `after_node_completed`（前一节点完成后计时）
- `targetNode`: 要监控的飞书项目节点名
- `timeoutMinutes`: 超时阈值（分钟）
- `remind.target`: `需求提出者` / `节点负责人`
- `remind.fallbackUserKey`: 备选人（飞书项目双击头像获取）

## 去重

已提醒的工作项 24 小时内不重复提醒。状态持久化在 `output/reminder-state.json`。目标节点完成自动清除记录。

## 不调大模型

纯规则检查，不消耗 AI token。
