/**
 * AI 大模型客户端 — DeepSeek / Anthropic 统一接口
 */
import axios from 'axios';

const MODEL_PROVIDER = process.env.AI_MODEL || 'deepseek';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface AiCompletionOptions {
  system?: string; messages: AiMessage[]; maxTokens?: number; temperature?: number;
}

export async function aiComplete(opts: AiCompletionOptions): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push(...opts.messages.map((m) => ({ role: m.role, content: m.content })));

  const res = await axios.post(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    model: 'deepseek-chat', messages,
    max_tokens: opts.maxTokens || 6000, temperature: opts.temperature ?? 0.3,
  }, {
    headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' },
    timeout: 120000,
  });
  return res.data.choices?.[0]?.message?.content || '';
}
