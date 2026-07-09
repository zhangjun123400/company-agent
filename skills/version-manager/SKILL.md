---
name: version-manager
version: 1.0.0
description: 版本管理技能 — 人力盘点、排期通知、进度偏离检测
tools:
  - id: version:headcount
    description: 版本人力盘点（递归SRD树、模块分布、复用率、NUDD风险）
  - id: version:schedule
    description: 版本排期通知（定版后发送所有节点时间线+任务清单）
  - id: version:deviation
    description: 进度偏离检测（叶子任务递归计算，偏离>15%通知PM/SE）
---

# 版本管理技能

基于飞书项目版本开发 + 研发任务管理数据，提供 PM 视角的版本管理能力。
