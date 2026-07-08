/**
 * 主智能体调度器
 * v2 — 模式匹配引擎：Agent 声明 tools，引擎自动匹配执行模式
 * 兼容旧 agent.json 格式和新 SKILL.md 格式
 */
import fs from 'fs';
import path from 'path';
import { registry, type AgentConfig } from './registry';
import { dispatcher } from './dispatcher';
import { executeNodeAgents, type ExecutionContext, type ExecutionResult } from './sandbox';
import { isAdmin } from './permission';
import { toolRegistry } from '../tools';
import type { ToolContext } from '../tools/_types';

// ==================== SKILL.md 加载 ====================

/** 加载 Agent 的 SKILL.md 正文（YAML frontmatter 之后的部分） */
function loadSkillBody(agent: AgentConfig): string {
  // 优先读 SKILL.md
  const skillPath = path.resolve(__dirname, '../../agents', agent.name, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const parts = raw.split(/^---$/m);
    if (parts.length >= 3) return parts.slice(2).join('---').trim();
    return raw.trim();
  }
  // Fallback: 旧 prompt.md
  const promptPath = path.resolve(__dirname, '../../agents', agent.name, 'prompt.md');
  if (fs.existsSync(promptPath)) return fs.readFileSync(promptPath, 'utf-8');
  // 最后兜底
  return agent.prompt || agent.description || '';
}

// ==================== 执行模式 ====================

/** 根据 tools 组合匹配执行模式并执行 */
async function agentExecutor(agent: AgentConfig, ctx: ExecutionContext): Promise<string> {
  const tools = agent.tools || [];
  const skillBody = loadSkillBody(agent);

  const toolCtx: ToolContext = {
    workItemId: ctx.workItemId,
    workItemName: ctx.workItemName,
    nodeName: ctx.nodeName,
    fields: ctx.fields,
    prdContent: ctx.prdContent,
    skillBody,
  };

  // 模式 A：标准分析模式
  if (hasAll(tools, ['wiki:read', 'ai:analyze', 'docx:create', 'im:send'])) {
    console.log(`[Orchestrator] ${agent.name} → 标准分析模式`);
    return executeAnalyzePipeline(toolCtx);
  }

  // 模式 B：纯分析模式
  if (hasAll(tools, ['wiki:read', 'ai:analyze'])) {
    console.log(`[Orchestrator] ${agent.name} → 纯分析模式`);
    const prd = await callTool('wiki:read', toolCtx);
    const result = await callTool('ai:analyze', { ...toolCtx, prdContent: prd });
    return result;
  }

  // 模式 C：纯通知模式
  if (hasAll(tools, ['im:send'])) {
    console.log(`[Orchestrator] ${agent.name} → 纯通知模式`);
    return callTool('im:send', toolCtx);
  }

  // ====== 兜底：兼容旧格式 Agent ======

  // 旧 需求分析 兼容
  const desc = agent.description.toLowerCase();
  if (desc.includes('需求澄清') || desc.includes('需求分析') || agent.skills.includes('澄清问题生成')) {
    console.log(`[Orchestrator] ${agent.name} → 旧格式兼容(需求分析)`);
    const { analyzePrdForClarification, formatClarificationResult } = await import('../agents/clarification');
    const result = await analyzePrdForClarification(ctx.prdContent || '', ctx.workItemName);
    return formatClarificationResult(result, `${ctx.workItemName} · 需求澄清问题清单`, '') || result;
  }

  // 旧 技术可行性初评 兼容
  if (desc.includes('技术可行性') || desc.includes('可行性分析') || agent.skills.includes('技术可行性分析')) {
    console.log(`[Orchestrator] ${agent.name} → 旧格式兼容(技术分析)`);
    const { analyzePrdForTechFeasibility, formatTechReportResult } = await import('../agents/tech-feasibility');
    const result = await analyzePrdForTechFeasibility(ctx.prdContent || '', ctx.workItemName);
    return formatTechReportResult(result, `${ctx.workItemName} · 技术可行性初评报告`, '');
  }

  // ====== 自定义工具链：按 tools 声明顺序逐个执行 ======
  if (tools.length > 0) {
    console.log(`[Orchestrator] ${agent.name} → 自定义工具链: [${tools.join(', ')}]`);
    let lastOutput = '';
    for (const toolId of tools) {
      lastOutput = await callTool(toolId, { ...toolCtx, previousOutput: lastOutput });
    }
    return lastOutput;
  }

  // 最后兜底：纯 AI 调用
  const { aiComplete } = await import('../utils/ai-client');
  return aiComplete({
    system: skillBody,
    messages: [{ role: 'user', content: `【任务】${agent.description}\n【上下文】${JSON.stringify(ctx)}` }],
    maxTokens: 3000,
  });
}

// ==================== 工具调用辅助 ====================

async function callTool(toolId: string, ctx: ToolContext): Promise<string> {
  const handler = toolRegistry.get(toolId);
  if (!handler) {
    console.error(`[Orchestrator] 未知工具: ${toolId}`);
    return '';
  }
  console.log(`[Orchestrator]   → ${toolId}`);
  return handler.execute(ctx);
}

// ==================== 内置执行管线 ====================

async function executeAnalyzePipeline(ctx: ToolContext): Promise<string> {
  // Step 1: 读 PRD
  const prdContent = await callTool('wiki:read', ctx);
  const enrichCtx = { ...ctx, prdContent };

  // Step 2: AI 分析
  const analysis = await callTool('ai:analyze', { ...enrichCtx, previousOutput: prdContent });

  // Step 3: 出文档
  const docUrl = await callTool('docx:create', { ...enrichCtx, previousOutput: analysis });

  // Step 4: 通知
  await callTool('im:send', { ...enrichCtx, previousOutput: docUrl });

  return docUrl;
}

// ==================== 辅助 ====================

function hasAll(tools: string[], required: string[]): boolean {
  return required.every(r => tools.includes(r));
}

// ==================== 调度入口 ====================

export async function dispatchNode(
  nodeName: string,
  context: ExecutionContext
): Promise<ExecutionResult[]> {
  const agents = dispatcher.getAgentsForNode(nodeName);
  if (agents.length === 0) {
    console.log(`[Orchestrator] 节点 "${nodeName}" 无匹配 Agent`);
    return [];
  }

  console.log(`[Orchestrator] 节点 "${nodeName}" → ${agents.length} 个 Agent: [${agents.map((a) => a.name).join(', ')}]`);
  return executeNodeAgents(agents, context, agentExecutor);
}

// ==================== 飞书对话新增 Agent ====================

export async function createAgentFromMessage(
  description: string,
  senderOpenId: string
): Promise<string> {
  if (!isAdmin(senderOpenId)) {
    return '❌ 仅管理员可新增智能体';
  }

  const { aiComplete } = await import('../utils/ai-client');
  const parsed = await aiComplete({
    messages: [{
      role: 'user',
      content: `从以下描述中提取 Agent 配置信息，输出严格JSON（不要Markdown标记）：
描述："${description}"
输出格式：
{"id":"英文id","name":"中文名","department":"部门","node":"飞书项目节点名","description":"功能描述","tools":["wiki:read","ai:analyze","docx:create","im:send"]}`,
    }],
    maxTokens: 500,
  });

  let config: AgentConfig;
  try {
    const json = parsed.replace(/```json|```/g, '').trim();
    config = JSON.parse(json) as AgentConfig;
    config.enabled = true;
    config.timeout_ms = 300000;
    config.tools = config.tools || ['wiki:read', 'ai:analyze', 'docx:create', 'im:send'];
    config.skills = config.skills || [];
    config.output = 'feishu_doc';
    config.output_target = ['节点负责人'];
    config.created_by = senderOpenId;
    config.created_at = new Date().toISOString();
  } catch {
    return '❌ 解析失败，请按格式重试：名称=xxx，节点=xxx，功能=xxx，部门=xxx';
  }

  try {
    registry.register(config);
    dispatcher.rebuild();
    return `✅ 智能体「${config.name}」已创建，挂载节点：${config.node}，即时生效`;
  } catch (e: unknown) {
    return `❌ 注册失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 初始化：注册工具 + 加载 Agent + 重建映射 */
export function init(): void {
  const { registerAllTools } = require('../tools');
  registerAllTools();
  registry.loadAll();
  dispatcher.rebuild();
  registry.startWatch();
}
