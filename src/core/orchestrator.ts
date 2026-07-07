/**
 * 主智能体调度器
 * 收事件 → 查映射 → 隔离执行 → 汇总结果
 */
import { registry, type AgentConfig } from './registry';
import { dispatcher } from './dispatcher';
import { executeNodeAgents, type ExecutionContext, type ExecutionResult } from './sandbox';
import { isAdmin } from './permission';

/** Agent 执行器：根据 Agent 配置调用对应能力 */
async function agentExecutor(agent: AgentConfig, ctx: ExecutionContext): Promise<string> {
  // 根据 Agent 的 skills 决定执行什么
  const desc = agent.description.toLowerCase();

  if (desc.includes('需求澄清') || desc.includes('需求分析') || agent.skills.includes('澄清问题生成')) {
    // 执行需求澄清分析
    const { analyzePrdForClarification, formatClarificationResult } = await import('../agents/clarification');
    const result = await analyzePrdForClarification(ctx.prdContent || '', ctx.workItemName);
    return formatClarificationResult(result, `${ctx.workItemName} · 需求澄清问题清单`, '') || result;
  }

  if (desc.includes('技术可行性') || desc.includes('可行性分析') || agent.skills.includes('技术可行性分析')) {
    // 执行技术可行性分析
    const { analyzePrdForTechFeasibility, formatTechReportResult } = await import('../agents/tech-feasibility');
    const result = await analyzePrdForTechFeasibility(ctx.prdContent || '', ctx.workItemName);
    return formatTechReportResult(result, `${ctx.workItemName} · 技术可行性初评报告`, '');
  }

  // 默认：通用分析（从 prompt.md 加载，fallback agent.description）
  const { aiComplete } = await import('../utils/ai-client');
  const fs = await import('fs'); const path = await import('path');
  const promptFile = path.resolve(__dirname, '../../agents', agent.name, 'prompt.md');
  const systemPrompt = (fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '') || agent.prompt || agent.description || '';
  return aiComplete({
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `【任务】${agent.description}\n【技能】${(agent.skills || []).join('、')}\n【上下文】${JSON.stringify(ctx)}`,
    }],
    maxTokens: 3000,
  });
}

/**
 * 调度：节点事件 → 执行匹配的 Agent
 */
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

/**
 * 飞书对话新增 Agent
 */
export async function createAgentFromMessage(
  description: string,
  senderOpenId: string
): Promise<string> {
  if (!isAdmin(senderOpenId)) {
    return '❌ 仅管理员可新增智能体';
  }

  // 用 DeepSeek 解析自然语言为 Agent 配置
  const { aiComplete } = await import('../utils/ai-client');
  const parsed = await aiComplete({
    messages: [{
      role: 'user',
      content: `从以下描述中提取 Agent 配置信息，输出严格JSON（不要Markdown标记）：
描述："${description}"
输出格式：
{"id":"英文id","name":"中文名","department":"部门","node":"飞书项目节点名","description":"功能描述","prompt":"系统提示词-定义智能体的身份和行为规则","skills":["技能1","技能2"],"tools":["wiki:read","docx:create"]}`,
    }],
    maxTokens: 500,
  });

  let config: AgentConfig;
  try {
    const json = parsed.replace(/```json|```/g, '').trim();
    config = JSON.parse(json) as AgentConfig;
    config.enabled = true;
    config.timeout_ms = 300000;
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

/**
 * 初始化：加载所有 Agent + 重建映射
 */
export function init(): void {
  registry.loadAll();
  dispatcher.rebuild();
  registry.startWatch();
}
