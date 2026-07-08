---
name: mem0
version: 1.0.0
description: 持久化记忆技能 — 分析前搜索历史决策经验，分析后存储结论供未来复用
tools:
  - id: mem0:search
    description: 语义搜索历史记忆，返回相关决策、方案、风险等
  - id: mem0:remember
    description: 将分析结论存入记忆，供后续类似需求检索
---

# mem0 记忆技能

## 作用
让智能体具备跨会话记忆能力。分析新需求时自动检索历史类似需求的决策经验，分析完成后将结论持久化。

## 使用方式
Agent 在 SKILL.md 的 tools 字段中声明 `mem0:search` 和/或 `mem0:remember` 即可。
建议在 `ai:analyze` 之前加 `mem0:search`，之后加 `mem0:remember`。

## 前置条件
需要 `MEM0_API_KEY` 环境变量已配置（settings.json 中已有）。
