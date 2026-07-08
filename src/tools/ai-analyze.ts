/**
 * ai:analyze — 本体能力
 * 加载 SKILL.md 正文作为系统提示词，调用 DeepSeek 完成 AI 分析
 */
import type { ToolHandler, ToolContext } from './_types';
import { aiComplete } from '../utils/ai-client';

async function execute(ctx: ToolContext): Promise<string> {
  const systemPrompt = ctx.skillBody || '你是专业的 AI 分析助手。';

  const userContent = [
    `## 任务`,
    `需求名称：${ctx.workItemName}`,
    ctx.prdContent ? `\n## PRD 文档\n${ctx.prdContent}` : '',
    ctx.previousOutput ? `\n## 上一步输出\n${ctx.previousOutput}` : '',
  ].filter(Boolean).join('\n');

  return aiComplete({
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: 16000,
  });
}

export const aiAnalyzeTool: ToolHandler = {
  id: 'ai:analyze',
  description: '加载 SKILL.md 系统提示词，调用 DeepSeek 完成 AI 分析',
  execute,
};
