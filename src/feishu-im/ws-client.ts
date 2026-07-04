/**
 * 飞书 IM WebSocket — 完整接管智小协消息
 * - 管理命令 → 增删智能体/管理员
 * - 分析请求 → 搜索需求 → 全流程分析
 * - 普通聊天 → DeepSeek 回复
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { feishuApp, projectConfig } from '../config';

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const TRIGGER_KW = ['分析', '需求澄清', '技术可行性', '出报告'];

let imToken = '';
async function getImToken(): Promise<string> {
  if (imToken) return imToken;
  const r = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: feishuApp.appId, app_secret: feishuApp.appSecret });
  imToken = r.data.tenant_access_token as string;
  return imToken as string;
}
async function sendIM(chatId: string, text: string): Promise<void> {
  const token = await getImToken();
  await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
    { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    { headers: { Authorization: `Bearer ${token}` } }).catch((e) => console.error('[IM] send:', e.message));
}

async function chatReply(msg: string): Promise<string> {
  try {
    const r = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-chat', max_tokens: 1000, temperature: 0.7,
      messages: [{ role: 'system', content: '你是智小协，友好专业的智能助理。回复简洁自然，用中文。' }, { role: 'user', content: msg }],
    }, { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    return r.data.choices[0]?.message?.content || '抱歉，我没理解。';
  } catch { return '抱歉，服务暂时不可用。'; }
}

function extractName(text: string): string | null {
  for (const p of [/(?:分析|出)[「《]?(.+?)[」》]?(?:需求|游戏|项目|的)/, /萝卜蹲\S*/]) {
    const m = text.match(p); if (m) return m[1]?.trim() || m[0].trim();
  }
  return null;
}

async function triggerAnalysis(workItemName: string): Promise<string> {
  try {
    const pt = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token',
      { plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1 });
    const pToken = pt.data.data.token;
    const sr = await axios.post('https://project.feishu.cn/open_api/compositive_search',
      { query_type: 'workitem', query: workItemName, page_size: 5 },
      { headers: { 'X-Plugin-Token': pToken, 'X-User-Key': projectConfig.userKey } });
    const items: Array<{ ID: string; name: string }> = sr.data.data || [];
    const found = items.find((i) => i.name && i.name.includes(workItemName));
    if (!found) return `未找到「${workItemName}」相关需求。`;
    await axios.post(`http://localhost:3456/trigger/new-requirement/${found.ID}`);
    return `已启动「${found.name}」分析，稍后报告发给你。`;
  } catch (e: unknown) { return `分析出错: ${e instanceof Error ? e.message : String(e)}`; }
}

async function sendAuthCard(chatId: string, docName?: string): Promise<void> {
  const doc = docName || '该文档';
  const token = await getImToken();
  await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId, msg_type: 'interactive',
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { content: '🔐 文档读取授权申请', tag: 'plain_text' }, template: 'blue' },
      elements: [
        { tag: 'markdown', content: `尊敬的同事你好，我是机器人助手智小协。现在申请只读您的文档《${doc}》权限，请予批准，以便我作为项目助手推进进程。十分感谢。\n\n**一次授权，且仅保留14天。**` },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '👉 批准授权（飞书内打开）' }, type: 'primary', url: 'http://localhost:3456/auth/feishu-login' }] },
        { tag: 'hr' }, { tag: 'note', elements: [{ tag: 'plain_text', content: '仅读取权限，不修改任何文档。14天后需重新授权。' }] },
      ],
    }),
  }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

async function handleManagement(content: string, senderOpenId: string, chatId: string): Promise<string | null> {
  // 授权 — 支持指定文档名："授权 萝卜蹲PRD"
  if (content.includes('授权')) {
    const docMatch = content.match(/授权[：:\s]*(.+)/);
    const docName = docMatch ? docMatch[1].trim() : undefined;
    await sendAuthCard(chatId, docName);
    return '已发送授权申请卡片，请点击按钮批准。';
  }
  // 新增智能体
  if (content.startsWith('新增智能体') || content.startsWith('添加智能体')) {
    const { createAgentFromMessage } = await import('../core/orchestrator');
    return createAgentFromMessage(content, senderOpenId);
  }
  // 删除智能体
  if (content.startsWith('删除智能体')) {
    const m = content.match(/删除智能体[：:]\s*(.+)/);
    if (!m) return '格式：删除智能体：名称';
    const { registry } = await import('../core/registry');
    const { dispatcher } = await import('../core/dispatcher');
    const { isAdmin } = await import('../core/permission');
    if (!isAdmin(senderOpenId)) return '❌ 仅管理员可删除';
    const agent = registry.getAll().find((a) => a.name === m[1].trim());
    if (!agent) return `未找到「${m[1].trim()}」`;
    registry.unregister(agent.id);
    dispatcher.rebuild();
    return `✅ 智能体「${agent.name}」已删除`;
  }
  // 查看智能体列表
  if (content.includes('查看所有智能体') || content.includes('智能体列表')) {
    const { registry } = await import('../core/registry');
    const all = registry.getAll();
    if (all.length === 0) return '当前无已注册智能体。';
    return `已注册 ${all.length} 个：\n${all.map((a) => `· ${a.name} → ${a.node}`).join('\n')}`;
  }
  return null;
}

export function startFeishuWS(): void {
  try {
    const wsClient = new Lark.WSClient({ appId: feishuApp.appId, appSecret: feishuApp.appSecret, loggerLevel: Lark.LoggerLevel.info });
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        const msg = data.message as Record<string, unknown>;
        const chatId = (msg.chat_id as string) || '';
        const raw = (msg.content as string) || '';
        const content = (() => { try { return JSON.parse(raw).text || raw; } catch { return raw; } })();
        const senderId = ((data.sender as Record<string, unknown>)?.sender_id as Record<string, string>)?.open_id || '';
        console.log(`[IM] ${chatId}: ${content}`);

        // 1. Management commands
        const mgmt = await handleManagement(content, senderId, chatId);
        if (mgmt !== null) { await sendIM(chatId, mgmt); return; }

        // 2. Analysis trigger
        if (TRIGGER_KW.some((kw) => content.includes(kw))) {
          const name = extractName(content);
          if (name) { await sendIM(chatId, await triggerAnalysis(name)); return; }
        }

        // 3. General chat
        await sendIM(chatId, await chatReply(content));
      },
    });
    wsClient.start({ eventDispatcher: dispatcher }).then(() => console.log('[IM] ✅ WebSocket 已连接')).catch((e: Error) => console.error('[IM] 启动失败:', e.message));
  } catch (e) { console.error('[IM] 初始化失败:', e); }
}
