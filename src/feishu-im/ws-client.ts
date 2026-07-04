/**
 * 飞书 IM WebSocket — 完整接管智小协消息
 *
 * 项目独立运行，不依赖 Claude Code：
 * - 普通聊天 → DeepSeek 回复
 * - 分析请求 → 搜索需求 → 全流程分析 → 回复结果
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { feishuApp, projectConfig } from '../config';

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const TRIGGER_KW = ['分析', '需求澄清', '技术可行性', '出报告'];

// ========== IM 消息发送 ==========

async function sendIM(chatId: string, text: string, openId?: string): Promise<void> {
  const token = await getImToken();
  await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    { headers: { Authorization: `Bearer ${token}` } }
  ).catch((e) => console.error('[IM] send error:', e.message));
}

let imToken = '';
async function getImToken(): Promise<string> {
  if (imToken) return imToken;
  const r = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: feishuApp.appId, app_secret: feishuApp.appSecret });
  imToken = r.data.tenant_access_token as string;
  return imToken as string;
}

// ========== DeepSeek 聊天 ==========

async function chatReply(userMsg: string): Promise<string> {
  try {
    const r = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat', max_tokens: 1000, temperature: 0.7,
      messages: [
        { role: 'system', content: '你是智小协，一位友好专业的智能助理。回复简洁自然，用中文。' },
        { role: 'user', content: userMsg },
      ],
    }, { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    return r.data.choices[0]?.message?.content || '抱歉，我没理解你的意思。';
  } catch {
    return '抱歉，服务暂时不可用，请稍后再试。';
  }
}

// ========== 分析触发 ==========

function extractName(text: string): string | null {
  for (const p of [/(?:分析|出)[「《]?(.+?)[」》]?(?:需求|游戏|项目|的)/, /萝卜蹲\S*/]) {
    const m = text.match(p); if (m) return m[1]?.trim() || m[0].trim();
  }
  return null;
}

async function triggerAnalysis(workItemName: string): Promise<string> {
  try {
    // Search work item
    const pt = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token',
      { plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1 });
    const pToken = pt.data.data.token;
    const sr = await axios.post('https://project.feishu.cn/open_api/compositive_search',
      { query_type: 'workitem', query: workItemName, page_size: 5 },
      { headers: { 'X-Plugin-Token': pToken, 'X-User-Key': projectConfig.userKey } });
    const items: Array<{ ID: string; name: string }> = sr.data.data || [];
    const found = items.find((i) => i.name && i.name.includes(workItemName));
    if (!found) return `未找到「${workItemName}」相关需求。`;

    // Trigger via HTTP
    const r = await axios.post(`http://localhost:3456/trigger/new-requirement/${found.ID}`);
    if (r.data.code === 0) return `已启动「${found.name}」分析，稍后报告会发给你。`;
    return `分析启动失败，请稍后再试。`;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `分析出错: ${msg}`;
  }
}

// ========== WebSocket 入口 ==========

export function startFeishuWS(): void {
  try {
    const wsClient = new Lark.WSClient({
      appId: feishuApp.appId,
      appSecret: feishuApp.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        const msg = data.message as Record<string, unknown>;
        const chatId = (msg.chat_id as string) || '';
        const raw = (msg.content as string) || '';
        const content = (() => { try { return JSON.parse(raw).text || raw; } catch { return raw; } })();

        console.log(`[IM] ${chatId}: ${content}`);

        // Analysis trigger?
        if (TRIGGER_KW.some((kw) => content.includes(kw))) {
          const name = extractName(content);
          if (name) {
            const result = await triggerAnalysis(name);
            await sendIM(chatId, result);
            return;
          }
        }

        // General chat → DeepSeek
        const reply = await chatReply(content);
        await sendIM(chatId, reply);
      },
    });

    wsClient.start({ eventDispatcher: dispatcher }).then(() => {
      console.log('[IM] ✅ 智小协 WebSocket 已连接，独立运行');
    }).catch((e: Error) => {
      console.error('[IM] 启动失败:', e.message);
    });
  } catch (e) {
    console.error('[IM] 初始化失败:', e);
  }
}
