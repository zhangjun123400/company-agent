/**
 * ai:analyze — 本体能力
 * 加载 SKILL.md 正文作为系统提示词，调用 DeepSeek 完成 AI 分析
 */
import fs from 'fs';
import path from 'path';
import type { ToolHandler, ToolContext } from './_types';
import { aiComplete } from '../utils/ai-client';

/** 全局底座提示词 — 所有智能体自动继承 */
let _basePrompt: string | null = null;
function getBasePrompt(): string {
  if (_basePrompt !== null) return _basePrompt;
  const p = path.resolve(__dirname, '../../knowledge/agent-persona.md');
  _basePrompt = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim() : '';
  if (_basePrompt) console.log('[ai:analyze] 底座提示词已加载');
  return _basePrompt;
}

async function execute(ctx: ToolContext): Promise<string> {
  const agentPrompt = ctx.skillBody || '你是专业的 AI 分析助手。';
  const base = getBasePrompt();
  const systemPrompt = base ? `${base}\n\n---\n\n## 当前角色\n\n${agentPrompt}` : agentPrompt;

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
