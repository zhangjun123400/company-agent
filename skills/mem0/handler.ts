/**
 * mem0 技能处理器
 * 提供 mem0:search 和 mem0:remember 两个工具
 */
import axios from 'axios';
import type { ToolHandler, ToolContext } from '../../src/tools/_types';

const MEM0_KEY = process.env.MEM0_API_KEY || '';
const BASE = 'https://api.mem0.ai/v1';
const H = { Authorization: `Token ${MEM0_KEY}`, 'Content-Type': 'application/json' };

/** 语义搜索历史记忆 */
async function search(ctx: ToolContext): Promise<string> {
  if (!MEM0_KEY) return '';
  try {
    const query = ctx.previousOutput || ctx.workItemName;
    const res = await axios.post(`${BASE}/memories/search/`, {
      query,
      filters: { AND: [{ app_id: '增效小伙伴' }] },
      top_k: 5,
      threshold: 0.3,
    }, { headers: H, timeout: 10000 });

    const results = res.data?.results || res.data || [];
    if (!Array.isArray(results) || results.length === 0) return '';

    const snippets = results.map((r: { memory?: string; score?: number }, i: number) =>
      `[记忆${i + 1}] ${(r.memory || '').substring(0, 600)}`
    ).join('\n\n');

    return `## 历史相关记忆\n\n${snippets}`;
  } catch (e: unknown) {
    console.error('[mem0:search]', (e as Error).message);
    return '';
  }
}

/** 存储新记忆 */
async function remember(ctx: ToolContext): Promise<string> {
  if (!MEM0_KEY) return '';
  try {
    const content = ctx.previousOutput || '';
    if (!content.trim()) return '';

    // 提取核心结论（取前 1500 字符）
    const text = `${ctx.workItemName} — 分析结论\n\n${content.substring(0, 1500)}`;

    await axios.post(`${BASE}/memories/`, {
      text,
      user_id: 'default',
      app_id: '增效小伙伴',
      infer: false, // 直接存储，不做二次提取
      metadata: { workItemId: ctx.workItemId, workItemName: ctx.workItemName },
    }, { headers: H, timeout: 10000 });

    console.log(`[mem0:remember] ✅ ${ctx.workItemName}`);
    return content; // 透传原始内容，不阻塞后续工具
  } catch (e: unknown) {
    console.error('[mem0:remember]', (e as Error).message);
    return ctx.previousOutput || ''; // 即使存储失败也透传
  }
}

export const mem0SearchTool: ToolHandler = {
  id: 'mem0:search',
  description: '语义搜索历史记忆，返回相关决策和结论',
  execute: search,
};

export const mem0RememberTool: ToolHandler = {
  id: 'mem0:remember',
  description: '将分析结论存入记忆',
  execute: remember,
};
