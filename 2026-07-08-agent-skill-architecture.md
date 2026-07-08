# 智慧智能体 · 智能体技能架构方案

> 日期: 2026-07-08 | 版本: v2.1 | 状态: 待审批
>
> 参考来源：[Claude Code Skills](https://www.morphllm.com/claude-code-skills-mcp-plugins) · [MCP Syscall Table](https://www.harness.io/blog/agent-loop-new-os) · [LangGraph Deep Agents](https://bitontree.com/langgraph-vs-langchain) · [Agent Skills 标准](https://learnku.com/courses/agent-skills-%E5%85%A5%E9%97%A8%E5%88%B0%E7%B2%BE%E9%80%9A/skills/17168)

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [核心设计：Agent 即 Skill](#2-核心设计agent-即-skill)
3. [平台能力层：Syscall Table](#3-平台能力层syscall-table)
4. [执行引擎：模式匹配 + 工具链](#4-执行引擎模式匹配--工具链)
5. [渐进式加载](#5-渐进式加载)
6. [热更新机制](#6-热更新机制)
7. [Agent 配置示例](#7-agent-配置示例)
8. [飞书对话新增 Agent](#8-飞书对话新增-agent)
9. [与现有系统关系](#9-与现有系统关系)
10. [文件变更清单](#10-文件变更清单)
11. [兼容策略](#11-兼容策略)
12. [实施阶段](#12-实施阶段)
13. [扩展性](#13-扩展性)

---

## 1. 背景与目标

### 1.1 现状

当前系统注册了两个智能体（需求分析、技术可行性初评），已有注册中心、节点调度、隔离执行等基础设施。但智能体执行逻辑在 `orchestrator.ts` 中硬编码：

```typescript
// 当前 agentExecutor — 硬编码分支
if (desc.includes('需求澄清'))  { ... clarification.ts }
if (desc.includes('技术可行性')) { ... tech-feasibility.ts }
else { ... 兜底 aiComplete }
```

新增智能体需要改 TS 代码；`skills` 字段是纯装饰不被消费；Wiki 读取、文档创建等平台能力散落各处不可复用。

### 1.2 目标

| 目标 | 说明 |
|------|------|
| **零代码新增智能体** | 只写 1 个 SKILL.md 文件，不改任何 TS 代码 |
| **能力即 Tool** | Wiki 读取、文档创建、AI 分析等封装为标准工具，Agent 声明即可用 |
| **智能调度** | Agent 声明需要哪些 tools，引擎自动匹配最优执行模式 |
| **渐进加载** | 元数据常驻 ~50 token/Agent，正文（提示词）执行时才读 |
| **热更新** | 增删改 Agent 后无需重启 |

---

## 2. 核心设计：Agent 即 Skill

借鉴 Claude Code Skills 标准——每个 Agent 是一个自包含的 `SKILL.md` 文件，YAML frontmatter 存元信息，Markdown 正文存系统提示词。

### 2.1 文件结构

```
agents/
  ├─ _registry.json              # 注册表，列出已注册 Agent 的路径
  ├─ 需求分析/
  │   └─ SKILL.md                # 一个文件 = 一个 Agent
  ├─ 技术可行性初评/
  │   └─ SKILL.md
  └─ 硬件方案评审/               # 新增 Agent 只需新建目录 + SKILL.md
      └─ SKILL.md
```

### 2.2 SKILL.md 格式

```markdown
---
name: 硬件方案评审
id: hardware-reviewer
description: 读取硬件方案文档，从EMC、散热、结构三方面评审，输出飞书文档
node: 硬件方案设计
department: 硬件部
tools:
  - wiki:read
  - ai:analyze
  - docx:create
  - im:send
output_target:
  - 触发人
  - 节点负责人
timeout_ms: 300000
---

你是资深硬件工程师，负责评审硬件方案设计。
请从以下维度逐一评审：

## 评审维度
1. 电磁兼容（EMC）— 布局、接地、屏蔽、滤波
2. 散热设计 — 热源分析、散热路径、裕量评估
3. 结构合理性 — 尺寸约束、安装方式、可制造性

## 输出格式
1. 总体评价
2. 各维度详细评审（含风险等级）
3. 改进建议
4. 结论（通过/有条件通过/不通过）
```

### 2.3 YAML Frontmatter 字段说明

| 字段 | 必需 | 说明 |
|------|:---:|------|
| `name` | ✅ | 智能体名称 |
| `id` | ✅ | 唯一标识（英文） |
| `description` | ✅ | 功能描述，用于模糊搜索和飞书对话新增时 AI 理解 |
| `node` | ✅ | 挂载的飞书项目流程节点 |
| `department` | - | 归属部门 |
| `tools` | ✅ | 声明需要的工具列表（见第 3 节） |
| `output_target` | - | 输出对象：`触发人`、`需求提出人`、`节点负责人` |
| `timeout_ms` | - | 超时（默认 300000 = 5min） |
| `enabled` | - | 启用状态（默认 true） |

### 2.4 为什么选这个模型

| 对比 | 旧方案 (agent.json + prompt.md) | 新方案 (SKILL.md) |
|------|-------------------------------|-------------------|
| 文件数 | 2 个 | 1 个 |
| 格式标准 | 私有 JSON | 对标 Agent Skills 标准，跨 Claude Code / Codex / Gemini CLI 通用 |
| 人类可读 | JSON 不适合写长文本 | Markdown + YAML，直观 |
| 新增耗时 | 手写 JSON + 单独写 md | 复制模板，填 YAML + 写提示词 |

---

## 3. 平台能力层：Syscall Table

借鉴 MCP 的 Harness 实践——**少量通用工具，靠参数分发**，不膨胀工具面。

### 3.1 工具定义

```typescript
// src/tools/_types.ts

interface ToolContext {
  workItemId: string;
  workItemName: string;
  nodeName: string;
  previousOutput?: string;   // 上一工具的输出
  skillBody?: string;         // SKILL.md 正文（ai:analyze 需要）
  fields: Record<string, unknown>;
  [key: string]: unknown;
}

interface ToolHandler {
  id: string;                          // 如 "wiki:read"
  description: string;                 // 一句话描述
  execute(ctx: ToolContext): Promise<string>;
}
```

### 3.2 6 个内置工具

```
工具表 (toolHandlers map)
  │
  ├─ 本体能力 ─────────────────────
  │   └─ ai:analyze        加载 SKILL.md 提示词 → 调 DeepSeek → 返回分析结果
  │
  └─ 平台能力（飞书）──────────────
      ├─ wiki:read          从飞书项目工作项提取 Wiki PRD 内容
      ├─ docx:create        将 Markdown 上传飞书云空间 / 创建 docx
      ├─ im:send            发送飞书消息（文本/卡片）给指定人
      ├─ project:query      查询工作项详情/节点/用户
      └─ project:search     模糊搜索飞书项目需求
```

### 3.3 Syscall Table 设计

每个工具保持极小参数面。以 `project:query` 为例，靠 `type` 分发行为：

```typescript
// 一个工具替代原来的 N 个 Meegle API 调用
project:query({ type: "workitem",    id: "7039179458" })       // 查需求详情
project:query({ type: "nodes",       id: "7039179458" })       // 查流程节点
project:query({ type: "user",        user_key: "764956..." })  // 查用户信息
project:query({ type: "attachments", id: "7039179458" })       // 查附件列表
```

**效果**：Agent 看到的工具面固定 6 个，不管飞书 API 怎么加，不变。

### 3.4 工具实现迁移对照

| 工具 | 迁自 |
|------|------|
| `ai:analyze` | `clarification.ts` + `tech-feasibility.ts`（加载 own prompt.md → DeepSeek） |
| `wiki:read` | `auto-analyzer.ts` 中的 `extractPrdContent()` + `readWikiByUrl()` |
| `docx:create` | `feishu-doc-formatter.ts` 中的 `createFormattedDoc()` |
| `im:send` | `auto-analyzer.ts` 中的 `sendReportCard()` + `ws-client.ts` 中的 `sendIM()` |
| `project:query` | `auto-analyzer.ts` 中的 `getWorkItemDetail()` + `resolveUserKeys()` |
| `project:search` | `ws-client.ts` 中的 `searchRequirements()` |

---

## 4. 执行引擎：模式匹配 + 工具链

Agent 不定义 Pipeline 顺序（那是实现细节），Agent 只声明**需要哪些 tools**。引擎根据 tools 组合自动选择最优执行模式。

### 4.1 三种内置模式

| 模式 | Tools 组合 | 流程 | 适用场景 |
|------|-----------|------|---------|
| **标准分析** | `wiki:read + ai:analyze + docx:create + im:send` | 读PRD→AI分析→出文档→通知 | 需求分析、技术评审、方案评审 |
| **纯分析** | `wiki:read + ai:analyze` | 读PRD→AI分析→返回结果 | 中间分析步骤 |
| **纯通知** | `im:send` | 发消息 | PRD 超时提醒、状态通知 |

### 4.2 引擎代码

```typescript
// orchestrator.ts — agentExecutor 重构

const toolHandlers: Record<string, ToolHandler> = { /* 第 3 节注册的 6 个工具 */ };

/** 根据 tools 组合匹配执行模式 */
async function agentExecutor(agent: AgentConfig, ctx: ExecutionContext): Promise<string> {
  const skillBody = loadSkillBody(agent.id);
  const tools = agent.tools || [];

  // 模式匹配
  if (hasAll(tools, ['wiki:read', 'ai:analyze', 'docx:create', 'im:send'])) {
    return executeAnalyzePipeline({ ...ctx, skillBody });
  }
  if (hasAll(tools, ['wiki:read', 'ai:analyze'])) {
    return executeAnalyzeOnly({ ...ctx, skillBody });
  }
  if (hasAll(tools, ['im:send'])) {
    return executeNotifyOnly(ctx);
  }

  // 自定义工具链：按声明顺序逐个执行
  let lastOutput = '';
  for (const toolId of tools) {
    const handler = toolHandlers[toolId];
    if (!handler) continue;
    lastOutput = await handler.execute({ ...ctx, previousOutput: lastOutput, skillBody });
  }
  return lastOutput;
}

/** 标准分析管线 */
async function executeAnalyzePipeline(ctx: ToolContext): Promise<string> {
  // 1. 读 PRD
  const prdContent = await toolHandlers['wiki:read'].execute(ctx);
  // 2. AI 分析
  const analysis = await toolHandlers['ai:analyze'].execute({ ...ctx, prdContent });
  // 3. 出文档
  const docUrl = await toolHandlers['docx:create'].execute({ ...ctx, previousOutput: analysis });
  // 4. 通知
  await toolHandlers['im:send'].execute({ ...ctx, previousOutput: docUrl });
  return docUrl;
}
```

### 4.3 为什么用模式匹配而不是 Agent 自定 Pipeline

- **降低 Agent 作者心智负担**：只需要说"我要 wiki:read + ai:analyze"，不用管顺序
- **引擎可优化**：内置模式（如标准分析）可以做并行、缓存、错误恢复等优化
- **一致的行为**：所有"标准分析"Agent 的 wiki:read 行为完全一致（PRD 字段提取、Wiki 读取、fallback 等），不会因为 Agent 配置不同而出现行为差异

---

## 5. 渐进式加载

```
启动时
  → 扫描 agents/ 下所有 SKILL.md 的 YAML frontmatter
  → 存入内存: { id, name, node, description, tools }
  → 每个 Agent ~50 token
  （100 个 Agent ≈ 5000 token，完全可接受）

调度时
  → Dispatcher 按 node 找到候选 Agent 列表
  → 仍未加载正文

执行时
  → 引擎 loadSkillBody(agent.id) 读取 SKILL.md 全文
  → 注入到 ai:analyze 的 system prompt
  → 执行完毕后可被 GC
```

对比当前全量加载：agent.json 全部字段 + prompt.md 全文 = 每个 Agent 2000+ token。

---

## 6. 热更新机制

```
agents/ 目录 .md 文件变化 (fs.watch)
  → 检测文件名匹配已注册 Agent
  → 重新解析 YAML frontmatter
  → 更新内存 AgentConfig
  → 触发 Dispatcher.rebuild()
  → 新请求立即使用新配置

SKILL.md 正文（Markdown 部分）
  → 每次执行时读取，天然热更新
```

增删 Agent 流程：修改 `_registry.json` → 自动触发 reload → 即时生效。

---

## 7. Agent 配置示例

### 示例 1：需求分析（标准分析模式）

```markdown
---
name: 需求分析
id: requirement-analyzer
description: 读取PRD需求文档，输出需求澄清问题清单
node: 需求评审
department: 软件研发部
tools:
  - wiki:read
  - ai:analyze
  - docx:create
  - im:send
output_target:
  - 触发人
  - 需求提出人
  - 节点负责人
---

你是资深产品需求分析师。请仔细阅读以下 PRD 文档，输出**需求澄清问题清单**。

## 分析维度
1. 功能完整性 — 是否覆盖所有用户场景
2. 边界条件 — 异常、极限、并发场景
3. 交互逻辑 — 用户操作路径是否清晰
4. 数据模型 — 实体、关系、状态流转是否明确
5. 非功能需求 — 性能、安全、兼容性
6. 依赖与约束 — 外部系统、第三方服务依赖

## 输出格式
按优先级分组：🔴高优 / 🟡中优 / 🟢低优
每个问题包含：问题描述 → 影响范围 → 建议方向
```

### 示例 2：技术可行性初评（标准分析模式）

```markdown
---
name: 技术可行性初评
id: tech-feasibility-reviewer
description: 读取PRD需求文档，结合技术方案和行业实践，输出技术可行性初评报告
node: 需求评审
department: 软件研发部
tools:
  - wiki:read
  - ai:analyze
  - docx:create
  - im:send
output_target:
  - 触发人
  - 节点负责人
---

你是资深技术架构师。请阅读以下 PRD 文档，输出**技术可行性初评报告**。

## 分析维度
1. 方案选型 — 推荐技术栈及理由
2. 架构概要 — 系统分层、核心模块、数据流
3. 风险识别 — 技术风险及缓解措施
4. 工时预估 — 各模块人天估算
5. 替代方案 — 备选方案及对比

## 输出格式
1. 结论（可行/需评估/有风险/不可行）
2. 推荐方案详述
3. 风险矩阵（概率 × 影响）
4. 工时汇总表
```

### 示例 3：新增 "硬件方案评审"（零代码）

只需创建 `agents/硬件方案评审/SKILL.md` 并在 `_registry.json` 注册。**不改任何 TS 代码。**

---

## 8. 飞书对话新增 Agent

当前 `createAgentFromMessage` 硬编码了 `output` / `output_target`。改造后由 DeepSeek 自动解析为 SKILL.md 模板：

```
用户发: "新增智能体：名称=硬件方案评审，节点=硬件方案设计，功能=评审硬件方案，部门=硬件部"

系统:
  1. DeepSeek 解析 → 提取 name/id/description/node/department
  2. 自动填入 tools: [wiki:read, ai:analyze, docx:create, im:send]
  3. 生成空提示词模板的 SKILL.md
  4. 写入 agents/硬件方案评审/SKILL.md
  5. 更新 _registry.json
  6. 回复: "✅ 已创建。请编辑 SKILL.md 完善系统提示词。"
```

---

## 9. 与现有系统关系

```
┌─────────────────────────────────────────┐
│         SKILL.md (Agent 定义层)            │
│  声明：我是谁、触发节点、需要哪些工具        │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│     orchestrator.ts (调度执行层)           │
│  加载 SKILL.md → 模式匹配 → 调工具         │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│       tool handlers (平台能力层)           │
│  ai:analyze / wiki:read / docx:create     │
│  im:send / project:query / project:search │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│      外部系统（飞书 API / DeepSeek）        │
└─────────────────────────────────────────┘
```

| 层 | 现有关键文件 | 变化 |
|----|------------|------|
| Agent 定义 | `agents/xxx/SKILL.md`（新格式） | agent.json + prompt.md 合并为一个文件 |
| 调度执行 | `orchestrator.ts` | agentExecutor 从 if/else 重构为模式匹配 |
| 平台能力 | 新建 `src/tools/` 目录 | 从 auto-analyzer/ws-client 中抽离 |
| 外部系统 | 不变 | 不变 |

---

## 10. 文件变更清单

```
新增:
  src/tools/_types.ts            ToolHandler 接口 + ToolContext
  src/tools/_registry.ts         工具注册表 (toolHandlers map) + 自动注册
  src/tools/ai-analyze.ts        ai:analyze — 加载 SKILL.md → DeepSeek
  src/tools/feishu-wiki.ts       wiki:read — 提取 PRD
  src/tools/feishu-docx.ts       docx:create — 上传/创建文档
  src/tools/feishu-im.ts         im:send — 发送消息/卡片
  src/tools/feishu-project.ts    project:query + project:search
  src/tools/index.ts             批量注册所有工具

修改:
  src/core/orchestrator.ts       agentExecutor 重构为模式匹配
  src/core/registry.ts           loadAll() 支持 SKILL.md 解析

废弃 (保留兼容，逐步移除):
  src/agents/clarification.ts          → ai:analyze tool
  src/agents/tech-feasibility.ts       → ai:analyze tool
  src/skills/feishu-doc-formatter.ts   → docx:create tool

迁移 (Agent 配置格式变更):
  agents/需求分析/agent.json + prompt.md      → SKILL.md
  agents/技术可行性初评/agent.json + prompt.md → SKILL.md
  agents/_registry.json                        → 路径更新
```

---

## 11. 兼容策略

| 兼容项 | 策略 |
|--------|------|
| 旧 `agent.json + prompt.md` 格式 | 保留支持 2 个版本，`registry.loadAll()` 优先读 SKILL.md，fallback 读 agent.json |
| `auto-analyzer.ts` 的 `handleNewRequirement` | 保留为顶层入口，内部逐步切到 tool handlers |
| 旧 `skills` 字段（字符串数组） | 保留在 YAML 中但不用于执行，仅用于展示/搜索 |
| `createAgentFromMessage` | 改为生成 SKILL.md 而非 agent.json |

---

## 12. 实施阶段

| 阶段 | 内容 | 新增行数 | 风险 |
|------|------|---------|------|
| **P0** | 定义 ToolHandler 接口 + 注册表（不改现有逻辑） | ~40 | 无 |
| **P1** | 实现 6 个 tool handler，迁移现有代码到工具内 | ~300 | 低（每个独立） |
| **P2** | 重构 agentExecutor 为模式匹配 + 工具链 | ~80 | 中（需兼容旧格式） |
| **P3** | 迁移现有两个 Agent 到 SKILL.md + 更新 _registry.json | 配置变更 | 低 |
| **P4** | 改造 createAgentFromMessage + 注册表支持 SKILL.md | ~40 | 低 |
| **P5** | 清理废弃文件（可选） | - | 低 |

---

## 13. 扩展性

未来新增能力只需两步：

1. **新工具**：实现 `ToolHandler` 接口 → 注册到 `toolHandlers` map
2. **新 Agent**：引用新工具即可

```yaml
# 示例：新增 GitHub Issue 自动创建能力
# 第一步：实现 github-create-issue tool
# 第二步：Agent SKILL.md 中声明
tools:
  - wiki:read
  - ai:analyze
  - github:create-issue   # ← 新工具
  - im:send
```

Agent 无感知变化，引擎自动处理工具链。
