# 智能体技能架构方案 v2

> 日期: 2026-07-07 | 版本: v2.0 | 参考: Claude Code Skills / MCP Syscall Table / LangGraph Deep Agents

## 1. 核心思路：Agent 即 Skill

借鉴 Claude Code Skills 标准——**每个智能体就是一个自包含的 Skill 目录**：

```
agents/硬件方案评审/
  ├─ SKILL.md          # YAML 元信息 + Markdown 正文（系统提示词）
  └─ _config.json      # 可选：覆盖默认管线/超时/输出目标
```

**SKILL.md 格式**（对标 Claude Code skill 标准）：

```markdown
---
name: 硬件方案评审
id: hardware-reviewer
description: 读取硬件方案文档，从EMC、散热、结构三个方面评审，输出飞书文档
node: 硬件方案设计
department: 硬件部
timeout_ms: 300000
output: feishu_doc
output_target:
  - 触发人
  - 节点负责人
tools:
  - wiki:read
  - ai:analyze
  - docx:create
  - im:send
---

# 系统提示词

你是资深硬件工程师，负责评审硬件方案设计。
评审维度：电磁兼容(EMC)、散热设计、结构合理性。

## 输出格式
1. 总体评价
2. 各维度详细评审
3. 风险点及建议
4. 结论（通过 / 有条件通过 / 不通过）
```

### 为什么选这个模型

| 对比 | 之前方案（agent.json + prompt.md 分离） | v2 方案（SKILL.md 合一） |
|------|--------------------------------------|------------------------|
| 元信息 | 分散在 agent.json | YAML frontmatter，一目了然 |
| 提示词 | 单独 prompt.md | SKILL.md 正文就是提示词 |
| 跨平台 | 私有格式 | 同一文件兼容 Claude Code / Codex / Gemini CLI |
| 新增 Agent | 3 个文件 | 1 个文件 |
| 渐进加载 | 无 | 元数据常驻 ~50 token，正文执行时加载 |

---

## 2. 平台能力：Syscall Table 模式

借鉴 MCP 的 Harness 实践——**少量通用工具，靠参数分发**，不膨胀工具面。

### 飞书能力层（一个 MCP Server，5 个工具）

```
feishu-server (飞书能力 MCP Server)
  ├─ feishu_project_query    → 查工作项/节点/字段
  ├─ feishu_project_search   → 模糊搜索需求
  ├─ feishu_wiki_read        → 读 Wiki PRD 内容
  ├─ feishu_docx_create      → 创建/上传飞书文档
  └─ feishu_im_send          → 发送消息/卡片
```

**每个工具只有 3-5 个参数**，靠 `resource_type` 区分行为：

```typescript
// 例：feishu_project_query 一个工具替代了原来的 N 个 API 调用
feishu_project_query({ type: "workitem", id: "7039179458" })        // 查需求
feishu_project_query({ type: "workitem_nodes", id: "7039179458" }) // 查节点
feishu_project_query({ type: "user", user_key: "7649567855..." })  // 查用户
```

**效果**：工具面固定 5 个，无论飞书 API 怎么加，Agent 看到的始终是这 5 个动作。

---

## 3. 本体能力：AI 分析 Skill

Prompt.md 内容就是系统提示词。Skill 注册表只存元数据，正文按需读取。

### 渐进式加载机制

```
启动时     → 扫描 agents/ 下所有 SKILL.md 的 YAML frontmatter
              存入内存: { id, name, node, description, tools }
              每个 Agent ~50 token

匹配时     → Dispatcher 按 node 找到候选 Agent 列表
              此时仍未加载正文

执行时     → 管线引擎读取 SKILL.md 全文
              注入到 ai:analyze 的 system prompt
              执行完毕后正文可被 GC
```

**效果**：100 个 Agent 的元数据 ≈ 5000 token，不影响上下文窗口。

---

## 4. 管线引擎：Agent 声明意图，引擎调度工具

### 不是预定义 Pipeline，而是 Agent 声明需要的工具 + 引擎按模式调度

```typescript
// orchestrator.ts — agentExecutor 重构

async function agentExecutor(agent: AgentConfig, ctx: ExecutionContext): Promise<string> {
  // 1. 加载 SKILL.md 正文
  const skillBody = loadSkillBody(agent.id);

  // 2. 根据 tools 字段匹配执行模式
  const tools = agent.tools || [];

  // 模式 A：标准分析模式 (wiki:read + ai:analyze + docx:create + im:send)
  if (hasAll(tools, ['wiki:read', 'ai:analyze', 'docx:create', 'im:send'])) {
    return executeStandardPipeline(agent, ctx, skillBody);
  }

  // 模式 B：纯分析模式 (wiki:read + ai:analyze)
  if (hasAll(tools, ['wiki:read', 'ai:analyze'])) {
    return executeAnalyzeOnly(agent, ctx, skillBody);
  }

  // 模式 C：通知模式 (仅 im:send)
  if (hasAll(tools, ['im:send'])) {
    return executeNotifyOnly(agent, ctx, skillBody);
  }

  // 模式 D：自定义 — 按 tools 顺序逐个调用 tool handler
  return executeToolChain(tools, agent, ctx, skillBody);
}
```

**关键区别 vs v1**：Agent 不定义 Pipeline（那是实现细节），Agent 只声明 **需要哪些 tools**。引擎根据 tools 组合自动选择最优执行模式。

### 三种内置执行模式

| 模式 | Tools 组合 | 流程 | 适用场景 |
|------|-----------|------|---------|
| 标准分析 | wiki:read + ai:analyze + docx:create + im:send | 读PRD→AI分析→出文档→通知 | 需求分析、技术评审、方案评审 |
| 纯分析 | wiki:read + ai:analyze | 读PRD→AI分析→返回结果 | 嵌入其他流程的中间步骤 |
| 纯通知 | im:send | 发消息 | PRD 超时提醒、状态变更通知 |

### 工具链执行器（模式 D：自定义）

```typescript
const toolHandlers: Record<string, ToolHandler> = {
  'wiki:read':      readWikiPrd,
  'ai:analyze':     runAIAnalysis,
  'docx:create':    createFeishuDoc,
  'im:send':        sendFeishuMessage,
  'project:query':  queryProjectItem,
  'project:search': searchProject,
};

async function executeToolChain(
  tools: string[], agent: AgentConfig, ctx: ExecutionContext, skillBody: string
): Promise<string> {
  let lastOutput = '';
  for (const toolId of tools) {
    const handler = toolHandlers[toolId];
    if (!handler) { console.error(`未知工具: ${toolId}`); continue; }
    lastOutput = await handler({ ...ctx, previousOutput: lastOutput, skillBody });
  }
  return lastOutput;
}
```

---

## 5. 热更新：文件监听 + 元数据刷新

```
agents/ 目录文件变化
  → fs.watch 检测
  → 重新扫描该 Agent 的 YAML frontmatter
  → 更新内存中的 AgentConfig
  → Dispatcher.rebuild()
  → 新请求立即使用新配置
```

Agent 正文（SKILL.md 的 Markdown 部分）每次执行时读取，天然热更新，无需额外机制。

---

## 6. Agent 配置示例

### 新增 "硬件方案评审" Agent

只需创建 **一个文件**：

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
---

你是资深硬件工程师，负责评审硬件方案设计。
请从以下维度逐一评审：

## 评审维度
1. **电磁兼容（EMC）** — 布局、接地、屏蔽、滤波
2. **散热设计** — 热源分析、散热路径、裕量评估
3. **结构合理性** — 尺寸约束、安装方式、可制造性

## 输出格式
1. 总体评价（一句话）
2. 各维度详细评审（含风险等级：高/中/低）
3. 改进建议
4. 结论（通过 / 有条件通过 / 不通过）
```

**注册**：只需在 `agents/_registry.json` 加一行 `"硬件方案评审/SKILL.md"`。**不改任何 TS 代码。**

### 飞书对话新增 Agent

```
用户: 新增智能体：名称=硬件方案评审，节点=硬件方案设计，功能=评审硬件方案，部门=硬件部

系统自动生成:
  → 创建 agents/硬件方案评审/SKILL.md（含 YAML frontmatter + 空提示词模板）
  → 默认 tools: [wiki:read, ai:analyze, docx:create, im:send]
  → 更新 _registry.json
  → 回复: "已创建，请在 SKILL.md 中完善系统提示词"
```

---

## 7. 与现有系统的关系

```
SKILL.md (Agent 定义层) ──────────────────────────
  │  声明：我是谁、触发节点、需要哪些 tools、输出给谁
  │
  ▼
orchestrator.ts (调度执行层) ─────────────────────
  │  匹配 node → 加载 SKILL.md → 选执行模式 → 调 tool handlers
  │
  ▼
tool handlers (平台能力层) ────────────────────────
  │  feishu_project_query / feishu_wiki_read /
  │  feishu_docx_create / feishu_im_send / ai:analyze
  │
  ▼
飞书 API / DeepSeek API (外部系统层) ──────────────
```

| 层 | 现有关键文件 | 变化 |
|----|------------|------|
| Agent 定义 | `agents/xxx/SKILL.md`（新） | agent.json + prompt.md → 合一 |
| 调度执行 | `orchestrator.ts` | agentExecutor 重构为模式匹配 |
| 平台能力 | 新建 `src/tools/` | 从 auto-analyzer/ws-client 抽离 |
| 外部系统 | 不变 | 不变 |

---

## 8. 文件变更清单

```
新增:
  src/tools/_types.ts            # ToolHandler 接口
  src/tools/_registry.ts         # 工具注册表 (toolHandlers map)
  src/tools/feishu-project.ts    # feishu_project_query + search
  src/tools/feishu-wiki.ts       # feishu_wiki_read
  src/tools/feishu-docx.ts       # feishu_docx_create
  src/tools/feishu-im.ts         # feishu_im_send
  src/tools/ai-analyze.ts        # ai:analyze (替代 clarification/tech-feasibility)
  src/tools/index.ts             # 批量注册

修改:
  src/core/orchestrator.ts       # agentExecutor 重构
  src/core/registry.ts           # SKILL.md 解析 (YAML frontmatter)

废弃:
  src/agents/clarification.ts    # → ai:analyze tool
  src/agents/tech-feasibility.ts # → ai:analyze tool
  src/skills/feishu-doc-formatter.ts # → feishu_docx_create tool
  agents/xxx/agent.json          # → SKILL.md
  agents/xxx/prompt.md           # → SKILL.md 正文

迁移:
  需求分析     → agents/需求分析/SKILL.md
  技术可行性初评 → agents/技术可行性初评/SKILL.md
```

---

## 9. 对比 v1 的改进

| 维度 | v1 (Pipeline 方案) | v2 (Skill + Tools 方案) |
|------|-------------------|------------------------|
| 新增 Agent | 3 个文件 (agent.json + prompt.md + 注册) | 1 个文件 (SKILL.md + 注册) |
| 格式标准 | 私有格式 | 对标 Agent Skills 标准，跨平台兼容 |
| 工具面 | 每加功能可能加 tool | 固定 5 个飞书工具，靠参数分发 |
| 执行模式 | Agent 定义 pipeline | Agent 声明 tools，引擎匹配模式 |
| 上下文效率 | 全量加载 | 渐进式：元数据常驻 ~50 token/Agent |
| 扩展性 | 加自定义 pipeline step | 加 tool handler + 注册到 map |

---

## 10. 实施阶段

| 阶段 | 内容 | 改动量 | 风险 |
|------|------|--------|------|
| P0 | 定义 ToolHandler 接口 + 注册表 | ~50 行 | 无 |
| P1 | 实现 5 个飞书 tool + 1 个 AI tool（迁移现有代码） | ~300 行 | 低 |
| P2 | 重构 agentExecutor（模式匹配 + 工具链） | ~80 行 | 中 |
| P3 | 迁移两个现有 Agent 到 SKILL.md 格式 | 配置变更 | 低 |
| P4 | 改造飞书对话新增 Agent + 注册表支持 SKILL.md | ~40 行 | 低 |
