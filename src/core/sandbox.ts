/**
 * 隔离执行器
 * 每个 Agent 独立执行：try-catch 隔离 + 超时兜底 + 上下文副本
 */
import type { AgentConfig } from './registry';

export interface ExecutionContext {
  workItemId: string;
  workItemName: string;
  nodeName: string;
  fields: Record<string, unknown>;
  prdContent?: string;
  [key: string]: unknown;
}

export interface ExecutionResult {
  agentId: string;
  agentName: string;
  status: 'success' | 'error' | 'timeout';
  output?: string;
  error?: string;
  durationMs: number;
}

/**
 * 执行单个 Agent（隔离 + 超时）
 */
export async function executeAgent(
  agent: AgentConfig,
  context: ExecutionContext,
  executor: (agent: AgentConfig, ctx: ExecutionContext) => Promise<string>
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const ctxCopy = JSON.parse(JSON.stringify(context)); // 上下文深拷贝

  try {
    const output = await Promise.race([
      executor(agent, ctxCopy),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent timeout')), agent.timeout_ms)
      ),
    ]);

    return {
      agentId: agent.id,
      agentName: agent.name,
      status: 'success',
      output,
      durationMs: Date.now() - startTime,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = msg.includes('timeout');
    return {
      agentId: agent.id,
      agentName: agent.name,
      status: isTimeout ? 'timeout' : 'error',
      error: msg,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * 批量执行节点上的所有 Agent（隔离）
 */
export async function executeNodeAgents(
  agents: AgentConfig[],
  context: ExecutionContext,
  executor: (agent: AgentConfig, ctx: ExecutionContext) => Promise<string>
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  for (const agent of agents) {
    const result = await executeAgent(agent, context, executor);
    results.push(result);
    if (result.status !== 'success') {
      console.error(`[Sandbox] ${agent.name} ${result.status}: ${result.error}`);
    }
  }
  return results;
}
