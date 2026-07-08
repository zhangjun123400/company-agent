# 智能体技能扩展架构方案

> 日期: 2026-07-08 | 版本: v1.1 | 状态: 待审批
>
> 参考: [Claude Code Skills](https://www.morphllm.com/claude-code-skills-mcp-plugins) · [MCP Hot-Reload](https://github.com/qhkm/zeptoclaw/issues/78) · [Progressive Discovery](https://github.com/SamMorrowDrums/mcpi-ext)

---

## 0. 核心区分：智能体 ≠ 技能

```
技能 (Skill)           →  外部能力包，全局加载一次，提供额外工具
智能体 (Agent)         →  挂载在飞书项目节点上，声明使用哪些工具

一个技能 = 一组外部工具（如 drawio-generator 提供 drawio:generate）
一个智能体 = SKILL.md 配置 + 工具声明
```

| | 技能 (Skill) | 智能体 (Agent) |
|---|---|---|
| **定位** | 外部能力包，全局共用 | 项目节点上的 AI 助手 |
| **数量** | 少（按需安装） | 可多（每个节点可配多个） |
| **加载** | 启动时一次性加载到 toolRegistry | 节点事件触发时才执行 |
| **配置** | `skills/xxx/SKILL.md` | `agents/xxx/SKILL.md` |
| **声明** | 我**提供**哪些工具 | 我**使用**哪些工具 |
| **用户感知** | 管理员安装 | 用户创建和对话 |

**类比**：技能 = VS Code 扩展，智能体 = 工作区配置。扩展装一次全局可用，每个工作区选自己需要的。

---

## 1. 目标

让智能体可以**外接技能**——`git clone` 到 `skills/` 目录 → 自动发现 → 智能体声明工具 ID 即可调用。不改核心代码，即插即用。

---

## 2. 设计原则：内置不动，外挂增量

**飞书能力（wiki:read / docx:create / im:send / project:* / ai:analyze）是项目的稳定基础设施。** 它们作为 `src/tools/` 硬编码注册——不会频繁增删、不需要自描述文档来发现、包装成 Skill 只增加维护成本没有实际价值。

**Skills 系统解决另一个问题**：社区或第三方写了一个新能力（drawio-generator、github-issues），怎么让智能体用上？答案是 `skills/` 目录——放进去即用，不改核心代码。

```
内置工具（稳定，硬编码）              外部技能（即插即用）
─────────────────────────          ────────────────────
src/tools/                         skills/
  _types.ts     ToolHandler接口       drawio-generator/
  _registry.ts  全局注册表              ├─ SKILL.md     ← 自描述
  ai-analyze.ts 本体能力               └─ handler.ts   ← 实现 ToolHandler
  feishu-wiki.ts                      github-issues/
  feishu-docx.ts                        ├─ SKILL.md
  feishu-im.ts                          └─ handler.ts
  feishu-project.ts
  index.ts       registerAllTools()  SkillLoader
                 在 init() 中调用      扫描 skills/ 目录
                                      把 handler 追加注册到
                                      同一个 toolRegistry
```

**两者汇入同一个全局 `toolRegistry`，智能体无感知差异。**

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    工具层（全局，启动时一次性加载）          │
│                                                          │
│  内置: src/tools/index.ts → registerAllTools()            │
│    ai:analyze  wiki:read  docx:create  im:send            │
│    project:query  project:search                          │
│                                                          │
│  外部: SkillLoader.loadAll() → 扫描 skills/               │
│    drawio:generate  github:create-issue  ...              │
│                                                          │
│         ↓ 全部注册到 toolRegistry（单例）                  │
└──────────────────────┬───────────────────────────────────┘
                       │ 工具已就绪，等待智能体调用
                       ▼
┌──────────────────────────────────────────────────────────┐
│                  智能体层（按节点配置，触发时执行）          │
│                                                          │
│  agents/需求评审/                                         │
│    ├─ 需求分析/SKILL.md        tools: [wiki:read,         │
│    │                                   ai:analyze,       │
│    │                                   docx:create,      │
│    │                                   im:send]          │
│    └─ 技术可行性初评/SKILL.md  tools: [wiki:read,         │
│                                        ai:analyze,       │
│                                        docx:create,      │
│                                        im:send]          │
│                                                          │
│  agents/方案设计/                                         │
│    └─ 技术架构评审/SKILL.md    tools: [wiki:read,         │
│                                        ai:analyze,       │
│                                        drawio:generate,  │ ← 外部技能
│                                        docx:create]      │
│                                                          │
│  每个智能体独立配置，声明自己需要哪些工具                     │
└──────────────────────┬───────────────────────────────────┘
                       │ 节点事件触发
                       ▼
┌──────────────────────────────────────────────────────────┐
│                  调度执行层                                │
│                                                          │
│  orchestrator.ts                                         │
│    匹配 node → 加载 Agent SKILL.md → 解析 tools 列表       │
│    → 从 toolRegistry 取工具 → 模式匹配 → 执行              │
└──────────────────────────────────────────────────────────┘
```

---

## 4. 外部 Skill 定义

### 4.1 文件结构

```
skills/drawio-generator/
  ├─ SKILL.md          # 自描述：名称、版本、提供的工具列表
  └─ handler.ts        # ToolHandler 实现
```

### 4.2 SKILL.md 格式

```markdown
---
name: drawio-generator
version: 1.0.0
description: AI draw.io 原生生成器，面向流程图、架构图、状态机等场景
tools:
  - id: drawio:generate
    description: 根据自然语言描述生成 .drawio XML 文件
---

# Draw.io Generator

## 功能
根据自然语言描述生成 draw.io 原生 XML 文件。

## 使用方式
Agent 在 SKILL.md 的 tools 字段中声明 `drawio:generate` 即可调用。
```

| 字段 | 必需 | 说明 |
|------|:---:|------|
| `name` | ✅ | Skill 唯一标识 |
| `version` | ✅ | 语义化版本 |
| `description` | ✅ | 一句话描述 |
| `tools` | ✅ | 此 Skill 提供的工具列表 |
| `tools[].id` | ✅ | 工具唯一 ID，如 `drawio:generate` |
| `tools[].description` | ✅ | 工具描述 |

### 4.3 handler.ts

```typescript
// skills/drawio-generator/handler.ts
import type { ToolHandler, ToolContext } from '../../src/tools/_types';

async function execute(ctx: ToolContext): Promise<string> {
  const description = ctx.previousOutput || ctx.workItemName;
  // ... 调用 draw.io 生成逻辑 ...
  return '<mxfile>...</mxfile>';
}

export const drawioGenerateTool: ToolHandler = {
  id: 'drawio:generate',
  description: '根据自然语言描述生成 .drawio XML 文件',
  execute,
};
```

---

## 5. 技能加载器

只做一件事：扫描 `skills/` 目录，把外部技能的 handler 追加注册到 toolRegistry。

```typescript
// src/skills/loader.ts

class SkillLoader {
  private skillDir = path.resolve(__dirname, '../../skills');

  async loadAll(): Promise<void> {
    if (!fs.existsSync(this.skillDir)) return;
    const dirs = fs.readdirSync(this.skillDir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of dirs) {
      await this.loadSkill(dir.name);
    }
    console.log(`[SkillLoader] 已加载 ${this.loaded.size} 个外部技能`);
  }

  private async loadSkill(skillName: string): Promise<void> {
    const skillPath = path.join(this.skillDir, skillName);
    const manifest = this.parseManifest(skillPath); // 解析 SKILL.md YAML

    // 动态加载 handler.ts
    const handlerModule = await import(path.join(skillPath, 'handler.ts'));
    for (const toolDef of manifest.tools) {
      const handler = handlerModule[toolDef.id.replace(':', '') + 'Tool'];
      if (handler) toolRegistry.register(handler);
    }
    this.loaded.set(skillName, manifest);
  }

  startWatch(): void {
    fs.watch(this.skillDir, { recursive: false }, (_, filename) => {
      if (!filename) return;
      setTimeout(() => this.reloadSkill(filename.toString()), 500);
    });
  }
}
```

### 加载时序

```
init() 中:
  1. registerAllTools()     ← 内置 6 个工具
  2. SkillLoader.loadAll()  ← 外部技能工具（追加注册）
  3. registry.loadAll()     ← 智能体
  4. dispatcher.rebuild()
```

---

## 6. 安装外部技能

```bash
# 安装
cd skills/
git clone https://github.com/xxx/drawio-generator.git

# fs.watch 自动检测 → 热加载，无需重启
```

或通过飞书对话（管理员）：

```
智小协 安装技能 https://github.com/xxx/drawio-generator
```

---

## 7. 智能体使用外部工具

只需在 `tools` 中声明 ID，与内置工具完全一致的用法：

```markdown
---
name: 技术架构评审
id: architecture-reviewer
node: 方案设计
tools:
  - wiki:read          # 内置
  - ai:analyze         # 内置
  - drawio:generate    # 外部技能
  - docx:create        # 内置
  - im:send            # 内置
---
```

智能体不关心工具来源。引擎从 toolRegistry 取，内置和外部无区别。

---

## 8. 执行引擎适配

当前引擎按 tools 组合匹配模式。外部工具引入后，可能出现引擎不认识的新组合。此时自动走**自定义工具链模式**：

```typescript
async function agentExecutor(agent, ctx) {
  const tools = agent.tools || [];

  // 1. 尝试匹配已知模式（标准分析 / 纯分析 / 纯通知）
  const mode = matchKnownPattern(tools);
  if (mode) return mode.execute(ctx);

  // 2. 未匹配 → 自定义工具链：按声明顺序逐个执行
  let lastOutput = '';
  for (const toolId of tools) {
    const handler = toolRegistry.get(toolId);
    if (!handler) { console.error(`未知工具: ${toolId}`); continue; }
    lastOutput = await handler.execute({ ...ctx, previousOutput: lastOutput });
  }
  return lastOutput;
}
```

---

## 9. 文件变更清单

```
新增:
  skills/                         # 外部技能目录（初始为空或含 .gitkeep）
  src/skills/loader.ts            # 技能加载器（扫描 + 动态 import + fs.watch）

修改:
  src/core/orchestrator.ts        # init() 中调用 SkillLoader.loadAll()
                                  # agentExecutor 增加自定义工具链模式

不变:
  src/tools/ 全部                  # 内置 6 个工具不动
  src/core/registry.ts            # Agent 注册中心不动
  agents/*/SKILL.md               # 智能体定义格式不变
```

---

## 10. 实施步骤

| 阶段 | 内容 | 改动量 |
|------|------|--------|
| **P0** | 创建 `skills/` 目录 + `src/skills/loader.ts` | ~60 行 |
| **P1** | `init()` 中加 `SkillLoader.loadAll()` + `startWatch()` | 3 行 |
| **P2** | `agentExecutor` 增加自定义工具链 fallback | ~20 行 |
| **P3** | 安装 `drawio-generator` 示例并端到端验证 | 测试 |
