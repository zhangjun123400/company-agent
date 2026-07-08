# 智能体技能扩展架构方案

> 日期: 2026-07-08 | 版本: v1.0 | 状态: 待审批
>
> 参考: [Claude Code Skills](https://www.morphllm.com/claude-code-skills-mcp-plugins) · [MCP Hot-Reload](https://github.com/qhkm/zeptoclaw/issues/78) · [Progressive Discovery](https://github.com/SamMorrowDrums/mcpi-ext)

---

## 0. 核心区分：智能体 ≠ 技能

这是整个架构最重要的概念边界：

```
技能 (Skill)           →  全局加载一次，提供工具能力
智能体 (Agent)         →  挂载在飞书项目节点上，声明使用哪些工具

一个技能 = 一组工具（如 drawio-generator 提供 drawio:generate 工具）
一个智能体 = SKILL.md 配置 + 工具声明（如 "技术架构评审" 使用 ai:analyze + drawio:generate）
```

| | 技能 (Skill) | 智能体 (Agent) |
|---|---|---|
| **定位** | 能力包，全局共用 | 项目节点上的 AI 助手 |
| **数量** | 少（5~20 个） | 可多（每个节点可配多个） |
| **加载** | 启动时一次性加载到 toolRegistry | 节点事件触发时才执行 |
| **配置** | `skills/xxx/SKILL.md` | `agents/xxx/SKILL.md` |
| **声明** | 我**提供**哪些工具 | 我**使用**哪些工具 |
| **用户感知** | 开发者/管理员安装 | 用户创建和对话 |

**类比**：技能 = VS Code 扩展，智能体 = 工作区配置。扩展装一次全局可用，每个工作区选自己需要的。

---

## 1. 目标

让每个智能体可以**外接技能**——像 Claude Code 装 Skill 一样，给智能体装 `drawio-generator` 就能画图，装 `github-issues` 就能建 Issue。新技能即插即用，不改核心代码。

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    技能层（全局，启动时一次性加载）          │
│                                                          │
│  skills/                                                 │
│    ├─ ai-analyze/SKILL.md      提供: ai:analyze          │
│    ├─ feishu-wiki/SKILL.md     提供: wiki:read           │
│    ├─ feishu-docx/SKILL.md     提供: docx:create         │
│    ├─ feishu-im/SKILL.md       提供: im:send             │
│    ├─ feishu-project/SKILL.md  提供: project:query/search│
│    └─ drawio-generator/        提供: drawio:generate ← 外部技能│
│         ├─ SKILL.md                                      │
│         └─ handler.ts                                    │
│                                                          │
│  SkillLoader.loadAll() → 全部注册到 toolRegistry（单例）   │
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
│                                        drawio:generate,  │ ← 使用了外部技能
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

## 3. SKILL.md 格式

```markdown
---
name: drawio-generator
version: 1.0.0
description: AI draw.io 原生生成器，面向流程图、架构图、状态机等场景，输出标准 .drawio XML
tools:
  - id: drawio:generate
    description: 根据自然语言描述生成 .drawio XML 文件
    parameters:
      description: 图表描述（中文/英文）
      type: 图表类型（flowchart/architecture/state/sequence）
dependencies: []
---

# Draw.io Generator

## 功能
根据自然语言描述生成 draw.io 原生 XML 文件。

## 使用方式
Agent 在 SKILL.md 的 tools 字段中声明 `drawio:generate` 即可调用。

## 输出
标准 .drawio XML 文件，可直接在 draw.io 中打开编辑。
```

### YAML Frontmatter 字段

| 字段 | 必需 | 说明 |
|------|:---:|------|
| `name` | ✅ | Skill 唯一标识 |
| `version` | ✅ | 语义化版本 |
| `description` | ✅ | 一句话描述，用于技能发现和搜索 |
| `tools` | ✅ | 此 Skill 提供的工具列表 |
| `tools[].id` | ✅ | 工具唯一 ID，如 `drawio:generate` |
| `tools[].description` | ✅ | 工具描述，Agent 调度时使用 |
| `tools[].parameters` | - | 工具参数说明（文档用途） |
| `dependencies` | - | 依赖的其他 Skill |

---

## 4. 与现有架构的关系

### 4.1 当前

```
src/tools/          ← 6 个工具，硬编码注册
  ai-analyze.ts
  feishu-wiki.ts
  feishu-docx.ts
  feishu-im.ts
  feishu-project.ts
  index.ts          ← registerAllTools() 逐个注册
```

### 4.2 改造后

```
src/tools/_registry.ts    ← 工具注册表不变
src/tools/_types.ts       ← ToolHandler 接口不变

skills/                   ← 新增：技能目录
  ai-analyze/SKILL.md     ← 从 src/tools/ai-analyze.ts 迁移
  feishu-wiki/SKILL.md    ← YAML 声明 + handler 引用
  feishu-docx/SKILL.md
  feishu-im/SKILL.md
  feishu-project/SKILL.md
  drawio-generator/       ← 外部技能（用户放进来的）
    SKILL.md
    handler.ts

src/skills/               ← 新增：技能加载器
  loader.ts               ← 扫描 skills/ 目录 → 解析 SKILL.md → 注册工具
```

**`ToolHandler` 接口保持不变**。Skill 只是工具的**组织方式**——一个 Skill 可包含多个 ToolHandler。加载器扫描 `skills/` 目录，把每个 Skill 的工具注册到全局 `toolRegistry`。

---

## 5. 技能加载器

```typescript
// src/skills/loader.ts

interface SkillManifest {
  name: string;
  version: string;
  description: string;
  tools: { id: string; description: string; parameters?: Record<string, string> }[];
  dependencies?: string[];
}

class SkillLoader {
  private skillDir: string;
  private loaded = new Map<string, SkillManifest>();

  /** 启动时扫描 skills/ 目录，注册所有工具 */
  async loadAll(): Promise<void> {
    const dirs = fs.readdirSync(this.skillDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      await this.loadSkill(dir.name);
    }
  }

  /** 加载单个 Skill */
  async loadSkill(skillName: string): Promise<void> {
    const skillPath = path.join(this.skillDir, skillName);
    const manifest = this.parseManifest(skillPath);

    // 注册此 Skill 提供的所有工具
    for (const toolDef of manifest.tools) {
      const handler = await this.loadHandler(skillPath, toolDef.id);
      toolRegistry.register(handler);
    }

    this.loaded.set(skillName, manifest);
    console.log(`[SkillLoader] ✅ ${skillName} v${manifest.version} — ${manifest.tools.length} 个工具`);
  }

  /** 热加载：检测变更并重载 */
  startWatch(): void {
    fs.watch(this.skillDir, { recursive: false }, (_, filename) => {
      if (!filename) return;
      const skillName = filename.toString();
      // 延迟等文件写入完成
      setTimeout(async () => {
        await this.reloadSkill(skillName);
        dispatcher.rebuild();  // 通知调度器刷新
      }, 500);
    });
  }

  /** 重载单个 Skill */
  async reloadSkill(skillName: string): Promise<void> {
    const old = this.loaded.get(skillName);
    if (old) {
      for (const tool of old.tools) toolRegistry.unregister(tool.id);
    }
    await this.loadSkill(skillName);
    console.log(`[SkillLoader] 🔄 热重载: ${skillName}`);
  }
}
```

### 加载流程

```
启动时
  → SkillLoader.loadAll()
  → 扫描 skills/ 下所有子目录
  → 逐个解析 SKILL.md → 加载 handler → 注册到 toolRegistry
  → 启动文件监听

运行时
  → 用户在 skills/ 下新建 drawio-generator/
  → fs.watch 检测到目录变化
  → SkillLoader.reloadSkill('drawio-generator')
  → 工具注册 → dispatcher.rebuild()
  → 新请求立即可用
```

---

## 6. 内置 Skill 迁移

| 当前文件 | 迁移为 |
|---------|--------|
| `src/tools/ai-analyze.ts` | `skills/ai-analyze/SKILL.md` + handler 逻辑 |
| `src/tools/feishu-wiki.ts` | `skills/feishu-wiki/SKILL.md` |
| `src/tools/feishu-docx.ts` | `skills/feishu-docx/SKILL.md` |
| `src/tools/feishu-im.ts` | `skills/feishu-im/SKILL.md` |
| `src/tools/feishu-project.ts` | `skills/feishu-project/SKILL.md` |

内置 Skill 的 handler 逻辑保留在 `src/tools/` 中（向后兼容），但注册方式从硬编码改为扫描 `skills/` 目录。

---

## 7. 安装外部 Skill

用户只需把 Skill 目录放到 `skills/` 下：

```bash
# 安装 drawio-generator 技能
cd skills/
git clone https://github.com/xxx/drawio-generator.git

# 无需重启，fs.watch 自动检测并加载
```

或通过飞书对话安装（管理员）：

```
智小协 安装技能 https://github.com/xxx/drawio-generator
```

---

## 8. Agent 使用外部 Skill

Agent 的 SKILL.md 中，`tools` 字段引用任何已注册的工具：

```markdown
---
name: 技术架构评审
id: architecture-reviewer
description: 评审技术方案并生成架构图
node: 方案设计
tools:
  - wiki:read          # feishu-wiki Skill 提供
  - ai:analyze         # ai-analyze Skill 提供
  - drawio:generate    # drawio-generator Skill 提供 ← 外部技能
  - docx:create        # feishu-docx Skill 提供
  - im:send            # feishu-im Skill 提供
---
```

**Agent 不关心工具来自哪个 Skill**——只声明工具 ID。引擎自动解析、调度。

---

## 9. 执行引擎适配

当前引擎按 tools 组合匹配模式：

```typescript
if (hasAll(tools, ['wiki:read', 'ai:analyze', 'docx:create', 'im:send'])) {
  return executeAnalyzePipeline(...);
}
```

### 改造：智能模式匹配

当 Agent 声明了引擎不认识的工具组合时（如 `drawio:generate`），自动走**自定义工具链模式**：

```typescript
async function agentExecutor(agent, ctx) {
  const tools = agent.tools || [];

  // 1. 尝试匹配已知模式
  const mode = matchKnownPattern(tools);
  if (mode) return mode.execute(ctx);

  // 2. 自定义工具链：按声明顺序逐个执行
  let lastOutput = '';
  for (const toolId of tools) {
    const handler = toolRegistry.get(toolId);
    if (!handler) {
      console.error(`[Orchestrator] 未知工具: ${toolId}`);
      continue;
    }
    lastOutput = await handler.execute({ ...ctx, previousOutput: lastOutput });
  }
  return lastOutput;
}
```

**效果**：新增 `drawio:generate` 工具后，任何 Agent 声明 `tools: [drawio:generate]` 即可使用。引擎自动走工具链模式。

---

## 10. 文件变更清单

```
新增:
  skills/                        # 技能目录（从 src/tools/ 迁移）
    ai-analyze/SKILL.md
    feishu-wiki/SKILL.md
    feishu-docx/SKILL.md
    feishu-im/SKILL.md
    feishu-project/SKILL.md
  src/skills/
    loader.ts                    # 技能加载器（扫描 + 注册 + 热监听）

修改:
  src/core/orchestrator.ts       # 增强模式匹配：未知工具 → 自定义工具链
  src/tools/index.ts             # registerAllTools → SkillLoader.loadAll()

不变:
  src/tools/_types.ts            # ToolHandler 接口
  src/tools/_registry.ts         # 工具注册表
  src/tools/ai-analyze.ts 等     # 保留 handler 实现
  agents/*/SKILL.md              # Agent 定义格式不变
```

---

## 11. 实施步骤

| 阶段 | 内容 | 改动量 |
|------|------|--------|
| **P0** | 创建 `skills/` 目录 + 5 个内置 Skill 的 SKILL.md | 5 个 YAML 文件 |
| **P1** | 实现 `SkillLoader`（扫描 + 解析 + 注册 + fs.watch） | ~80 行 |
| **P2** | 改造 `tools/index.ts` → `SkillLoader.loadAll()` | ~10 行 |
| **P3** | 增强 `agentExecutor` 未知工具自动走工具链模式 | ~20 行 |
| **P4** | 安装 `drawio-generator` 示例 Skill 并验证 | 端到端测试 |

---

## 12. 与 Clint Code Skills 的对比

| 维度 | Claude Code Skills | 智慧智能体 Skill |
|------|-------------------|-----------------|
| 定义文件 | SKILL.md | SKILL.md ✅ |
| 渐进加载 | 元数据常驻 + 正文按需 | 同样 ✅ |
| 热加载 | 需重启 | fs.watch 自动重载 ✅ |
| 工具注册 | 隐式（AI 理解文本） | 显式（`tools` YAML 字段声明） |
| 分发方式 | Plugin marketplace | Git clone 到 skills/ 目录 |
| Agent 调用 | AI 自行判断 | Agent 声明 tools，引擎调度 |
