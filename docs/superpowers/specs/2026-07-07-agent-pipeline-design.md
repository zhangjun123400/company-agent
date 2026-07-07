# 智能体管线架构设计方案

> 日期: 2026-07-07 | 版本: v1.0 | 状态: 待审批

## 1. 背景与动机

### 1.1 现状

当前系统注册了两个智能体——需求分析、技术可行性初评。架构上已有注册中心、节点调度、隔离执行等基础设施，但**智能体的执行逻辑是硬编码的**：

```typescript
// orchestrator.ts — 当前 agentExecutor
if (desc.includes('需求澄清')) { ... clarification.ts }
if (desc.includes('技术可行性')) { ... tech-feasibility.ts }
else { ... 通用 aiComplete 兜底 }
```

### 1.2 痛点

| 痛点 | 说明 |
|------|------|
| **新增智能体要改代码** | 加一个"硬件方案评审"需在 `agentExecutor` 加新 if 分支，否则只能走兜底的纯 AI 调用 |
| **Skills 字段是装饰** | `agent.json` 里声明的 skills 数组没有被执行引擎消费 |
| **平台能力散落各处** | Wiki 读取、文档创建、IM 通知的实现分布在 `auto-analyzer.ts`、`ws-client.ts`、`feishu-doc-formatter.ts`，不可复用 |
| **本体能力未抽象** | AI 分析 = prompt.md + DeepSeek 调用，每个 Agent 都重复这段逻辑 |

### 1.3 目标

- **零代码新增智能体**：只写配置文件（agent.json + prompt.md），不改任何 TS 代码
- **能力即 Skill**：Wiki 读取、文档创建、AI 分析等封装为标准技能，Agent 按需组合
- **管线化执行**：每个 Agent 声明一条 Pipeline，按序执行，上一步输出注入下一步
- **热更新**：新增/修改 Agent 后无需重启（已有能力，保持不变）

---

## 2. 架构总览

```
┌────────────────────────────────────────────────────┐
│                    调度层（不变）                      │
│  Webhook / 手动触发 → Dispatcher → Orchestrator      │
└────────────────────────┬───────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────┐
│                agentExecutor（重构）                  │
│  读取 agent.pipeline → 顺序调用 skill.execute()       │
│  链式传递上下文：上一级输出 → 下一级输入                 │
└────────────────────────┬───────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  本体能力     │ │  平台能力     │ │  平台能力     │
│  ai:analyze  │ │  wiki:read   │ │  docx:create │
│  ai:format   │ │  project:*   │ │  im:send     │
└──────────────┘ └──────────────┘ └──────────────┘
```

**核心变化**：`agentExecutor` 从 if/else 开关变成**管线引擎**。Agent 不再是一段硬编码函数，而是一份声明式配置。

---

## 3. 核心模型

### 3.1 Skill 接口

```typescript
// src/skills/_types.ts

/** 技能执行上下文 — 贯穿整条管线 */
interface SkillContext {
  workItemId: string;
  workItemName: string;
  nodeName: string;
  /** 上一步骤的输出，由管线引擎自动注入 */
  previousOutput?: string;
  /** Agent 配置中 skill.config 的值，由管线引擎透传 */
  config?: Record<string, unknown>;
  /** 原始 PRD 内容，由 wiki:read 注入 */
  prdContent?: string;
  /** 飞书字段值 */
  fields: Record<string, unknown>;
  /** 自由扩展字段 */
  [key: string]: unknown;
}

/** 技能接口 — 每个 Skill 实现此接口 */
interface Skill {
  id: string;
  description: string;
  execute(ctx: SkillContext): Promise<string>;
}
```

### 3.2 Skill 注册表

```typescript
// src/skills/_registry.ts

class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }
}

export const skillRegistry = new SkillRegistry();
```

### 3.3 Agent 配置扩展

```typescript
// 扩展 AgentConfig（在现有基础上增加 pipeline 字段）
interface AgentConfig {
  id: string;
  name: string;
  node: string;            // 飞书项目流程节点
  department: string;
  description: string;     // 自然语言描述（保留，用于飞书对话新增）
  prompt?: string;         // 兜底提示词
  // ====== 新增 ======
  pipeline?: PipelineStep[];
  output?: string;         // feishu_doc | im_message | both
  output_target?: string[];
  // ====== 保持 ======
  skills: string[];        // 保留，但改为 skill 注册表的 key 列表
  enabled: boolean;
  timeout_ms: number;
}

interface PipelineStep {
  skill: string;                     // skillRegistry 中的 key，如 "ai:analyze"
  config?: Record<string, unknown>;  // 传给 skill 的配置参数
}
```

---

## 4. 内置 Skill 清单

### 4.1 本体能力

| Skill ID | 职责 | 说明 |
|----------|------|------|
| `ai:analyze` | 加载 prompt.md → 调用 DeepSeek → 返回分析结果 | 核心能力。token 数、温度等可配 |
| `ai:format` | 将 AI 输出套用模板格式化 | 拼接标题、PRD 链接、生成时间等 |

### 4.2 平台能力

| Skill ID | 职责 | 说明 |
|----------|------|------|
| `wiki:read` | 从飞书项目工作项提取 Wiki PRD 内容 | 替代 `auto-analyzer.ts` 中的 `extractPrdContent` |
| `docx:create` | MD 上传飞书云空间 / 创建 docx | 替代 `feishu-doc-formatter.ts` |
| `im:send` | 发送飞书消息（文本/卡片）给指定人 | targets 支持三种值：`"触发人"`（用 chatId）、`"需求提出人"`（从工作项 owner 解析 open_id）、`"节点负责人"`（从节点 owners 解析）。替代 `sendReportCard` |
| `project:search` | 搜索飞书项目需求 | 替代 `ws-client.ts` 中的 `searchRequirements` |
| `project:query` | 查询工作项详情（节点、负责人） | 替代 `auto-analyzer.ts` 中的 `getWorkItemDetail` |

### 4.3 现有实现映射

| Skill | 迁移自 | 文件 |
|-------|--------|------|
| `ai:analyze` | `clarification.ts` + `tech-feasibility.ts` | 新建 `skills/ai-analyze.ts` |
| `ai:format` | `formatClarificationResult` / `formatTechReportResult` | 新建 `skills/ai-format.ts` |
| `wiki:read` | `auto-analyzer.ts:extractPrdContent` + `readWikiByUrl` | 新建 `skills/wiki-read.ts` |
| `docx:create` | `feishu-doc-formatter.ts:createFormattedDoc` | 新建 `skills/docx-create.ts` |
| `im:send` | `auto-analyzer.ts:sendReportCard` + `ws-client.ts:sendIM` | 新建 `skills/im-send.ts` |
| `project:search` | `ws-client.ts:searchRequirements` | 新建 `skills/project-search.ts` |
| `project:query` | `auto-analyzer.ts:getWorkItemDetail` | 新建 `skills/project-query.ts` |

---

## 5. 管线引擎

### 5.1 agentExecutor 重构

```typescript
// orchestrator.ts — 重构后

async function agentExecutor(agent: AgentConfig, ctx: ExecutionContext): Promise<string> {
  const pipeline = agent.pipeline || defaultPipeline(agent);
  const skillCtx: SkillContext = {
    workItemId: ctx.workItemId,
    workItemName: ctx.workItemName,
    nodeName: ctx.nodeName,
    fields: ctx.fields,
    prdContent: ctx.prdContent,
  };

  let lastOutput = '';

  for (const step of pipeline) {
    const skill = skillRegistry.get(step.skill);
    if (!skill) {
      console.error(`[Pipeline] 未知技能: ${step.skill}，Agent: ${agent.name}`);
      continue;
    }

    skillCtx.config = step.config;
    skillCtx.previousOutput = lastOutput;

    console.log(`[Pipeline] ${agent.name} → ${step.skill}`);
    lastOutput = await skill.execute(skillCtx);

    // 上下文注入：管线引擎不硬编码特定技能，
    // 而是公开 ctx 让技能自由修改（如 wiki:read 写入 prdContent）
    skillCtx._stepOutput = lastOutput;
  }

  return lastOutput;
}
```

### 5.2 默认管线（向后兼容）

```typescript
/** 未声明 pipeline 时，根据 description 自动生成默认管线 */
function defaultPipeline(agent: AgentConfig): PipelineStep[] {
  return [
    { skill: 'wiki:read',  config: {} },
    { skill: 'ai:analyze', config: { promptSource: 'agent-dir', maxTokens: 16000 } },
    { skill: 'docx:create', config: { title: `{workItemName} · ${agent.name}报告` } },
    { skill: 'im:send',    config: { target: '节点负责人' } },
  ];
}
```

---

## 6. Agent 配置示例

### 6.1 迁移前（当前）

```json
// agents/技术可行性初评/agent.json
{
  "id": "tech-feasibility-reviewer",
  "name": "技术可行性初评",
  "node": "需求评审",
  "department": "软件研发部",
  "description": "读取PRD需求文档，输出技术可行性初评报告",
  "skills": ["技术可行性分析", "方案选型", "风险评估", "工时预估", "架构设计"],
  "tools": ["wiki:read", "docx:create", "im:send"],
  "output": "feishu_doc",
  "output_target": ["节点负责人"],
  "enabled": true,
  "timeout_ms": 300000
}
```

### 6.2 迁移后

```json
// agents/技术可行性初评/agent.json
{
  "id": "tech-feasibility-reviewer",
  "name": "技术可行性初评",
  "node": "需求评审",
  "department": "软件研发部",
  "description": "读取PRD需求文档，输出技术可行性初评报告",
  "pipeline": [
    { "skill": "wiki:read" },
    { "skill": "ai:analyze", "config": { "maxTokens": 16000 } },
    { "skill": "ai:format", "config": { "title": "{workItemName} · 技术可行性初评报告", "appends": ["prdUrl", "generatedAt"] } },
    { "skill": "docx:create", "config": { "folder": "技术报告" } },
    { "skill": "im:send", "config": { "targets": ["触发人", "节点负责人"] } }
  ],
  "skills": ["ai:analyze", "ai:format", "wiki:read", "docx:create", "im:send"],
  "enabled": true,
  "timeout_ms": 300000
}
```

### 6.3 新增 Agent（零代码）

```json
// agents/硬件方案评审/agent.json
{
  "id": "hardware-reviewer",
  "name": "硬件方案评审",
  "node": "硬件方案设计",
  "department": "硬件部",
  "description": "读取硬件方案文档，从EMC、散热、结构三方面评审",
  "pipeline": [
    { "skill": "wiki:read" },
    { "skill": "ai:analyze", "config": { "maxTokens": 16000 } },
    { "skill": "ai:format", "config": { "title": "{workItemName} · 硬件方案评审报告" } },
    { "skill": "docx:create" },
    { "skill": "im:send", "config": { "targets": ["触发人", "节点负责人"] } }
  ],
  "skills": ["ai:analyze", "wiki:read", "docx:create", "im:send"],
  "enabled": true,
  "timeout_ms": 300000
}
```

部署方式：在 `agents/` 目录下创建文件夹，放入 `agent.json` 和 `prompt.md`，在 `_registry.json` 中注册。**不改任何 TS 代码。**

---

## 7. 飞书对话新增 Agent（改造）

当前 `createAgentFromMessage` 硬编码了 output/output_target。改造后：

```
用户: 新增智能体：名称=硬件方案评审，节点=硬件方案设计，功能=评审硬件方案，部门=硬件部

DeepSeek 解析 → 自动生成：
  pipeline: [
    { skill: "wiki:read" },
    { skill: "ai:analyze" },
    { skill: "docx:create" },
    { skill: "im:send" }
  ]
  skills: ["ai:analyze", "wiki:read", "docx:create", "im:send"]
```

系统自动填入**标准四步管线** + 生成空的 `prompt.md` 模板。用户后续可手动编辑 pipeline 和 prompt。

---

## 8. 文件变更清单

```
新增:
  src/skills/_types.ts           # Skill 接口 + SkillContext
  src/skills/_registry.ts        # 全局技能注册表
  src/skills/ai-analyze.ts       # 本体能力
  src/skills/ai-format.ts        # 本体能力
  src/skills/wiki-read.ts        # 平台能力
  src/skills/docx-create.ts      # 平台能力
  src/skills/im-send.ts          # 平台能力
  src/skills/project-search.ts   # 平台能力
  src/skills/project-query.ts    # 平台能力
  src/skills/index.ts            # 导出 + 启动时批量注册

修改:
  src/core/orchestrator.ts       # agentExecutor 重构为管线引擎
  src/agents/auto-analyzer.ts    # extractPrdContent → wiki:read skill
                                 # sendReportCard → im:send skill
                                 # createFormattedDoc → docx:create skill

废弃（可保留兼容）:
  src/agents/clarification.ts    # → ai:analyze skill
  src/agents/tech-feasibility.ts # → ai:analyze skill
  src/skills/feishu-doc-formatter.ts # → docx:create skill

更新配置:
  agents/需求分析/agent.json      # 添加 pipeline 字段
  agents/技术可行性初评/agent.json # 添加 pipeline 字段
```

---

## 9. 兼容策略

| 兼容项 | 策略 |
|--------|------|
| 旧 Agent 无 pipeline | `defaultPipeline()` 自动生成标准四步管线 |
| 旧 `skills` 字段（字符串列表） | 保留，但不再用于执行逻辑，仅用于展示 |
| `auto-analyzer.ts` 直接调用 | 保留现有 `handleNewRequirement` 入口，内部逐步切到 skill |
| `createAgentFromMessage` | 改造为自动生成 pipeline 配置 |

---

## 10. 实施顺序

| 阶段 | 内容 | 风险 |
|------|------|------|
| **P0** | 定义 Skill 接口 + 注册表（不改任何现有逻辑） | 无 |
| **P1** | 实现 7 个 Skill，逐个迁移现有代码 | 低（每个 Skill 独立） |
| **P2** | 重构 agentExecutor 为管线引擎 | 中（需保留兼容） |
| **P3** | 迁移两个现有 Agent 到 pipeline 配置 | 低 |
| **P4** | 改造飞书对话新增 Agent 逻辑 | 低 |

---

## 11. 扩展性示例

未来可轻松扩展：

```json
// 新增能力，不改代码
{ "skill": "slack:send" },         // 跨平台通知
{ "skill": "github:create-issue" }, // 自动创建 Issue
{ "skill": "db:query" },           // 查询数据库
{ "skill": "email:send" },         // 邮件通知
{ "skill": "web:scrape" }          // 网页抓取
```

每个新 Skill 只需实现 `Skill` 接口并注册到 `skillRegistry`。
