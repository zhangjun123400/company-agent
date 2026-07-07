/**
 * AI 大模型客户端 — DeepSeek / Anthropic 统一接口
 */
import axios from 'axios';

import { aiModel, deepseekApiKey, deepseekBaseUrl } from '../config';
const MODEL_PROVIDER = aiModel;
const DEEPSEEK_KEY = deepseekApiKey;
const DEEPSEEK_BASE = deepseekBaseUrl;

export interface AiMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface AiCompletionOptions {
  system?: string; messages: AiMessage[]; maxTokens?: number; temperature?: number;
}

export async function aiComplete(opts: AiCompletionOptions): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push(...opts.messages.map((m) => ({ role: m.role, content: m.content })));

  const res = await axios.post(`${DEEPSEEK_BASE}/v1/chat/completions`, {
    model: 'deepseek-v4-pro', messages,
    max_tokens: opts.maxTokens || 16000, temperature: opts.temperature ?? 0.3,
  }, {
    headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' },
    timeout: 120000,
  });
  return res.data.choices?.[0]?.message?.content || '';
}
