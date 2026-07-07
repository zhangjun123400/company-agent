/**
 * 飞书 IM WebSocket — 完整接管智小协消息
 * - 管理命令 → 增删智能体/管理员
 * - 分析请求 → 搜索需求 → 全流程分析
 * - 普通聊天 → DeepSeek 回复
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { feishuApp, projectConfig } from '../config';
import { hasWikiToken } from '../auth/wiki-token';
import { savePending } from '../utils/pending-analysis';
import { enqueue } from '../utils/user-queue';

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const TRIGGER_KW = ['分析', '需求澄清', '技术可行性', '出报告'];

// 待确认队列: 用户 ID → { workItemName, workItemId }
const pendingConfirms = new Map<string, { name: string; id: string }>();
const seenMessages = new Set<string>(); // 消息去重

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

/** 从消息中提取所有需求名称（支持多需求） */
async function extractNames(text: string): Promise<string[]> {
  // 用 DeepSeek 理解用户意图，提取需求名称
  try {
    const r = await axios.post('https://api.deepseek.com/v1/chat/completions', {
      model: 'deepseek-v4-pro', max_tokens: 100, temperature: 0,
      messages: [{
        role: 'system',
        content: '从用户消息中提取需求名称（仅名称，不要修饰词）。只输出JSON数组，如["萝卜蹲"]。不要包含"技术""可行性""游戏""的""分析"等词。没有明确名称时输出[]。',
      }, { role: 'user', content: text }],
    }, { headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 });
    const json = r.data.choices[0].message.content.replace(/```json|```/g, '').trim();
    const names = JSON.parse(json);
    return Array.isArray(names) ? names : [];
  } catch {
    // Fallback: 简单规则
    return text.replace(/分析|一下|的|需求|技术|可行|报告|清单|澄清/g, '').trim().split(/[、,，和与及]/).filter((n: string) => n.length >= 2);
  }
}

/** 模糊搜索需求，返回候选列表 */
async function searchRequirements(keyword: string): Promise<Array<{ id: string; name: string }>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const pt = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token',
        { plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1 });
      const pToken = pt.data.data.token;
      const sr = await axios.post('https://project.feishu.cn/open_api/compositive_search',
        { query_type: 'workitem', query: keyword, page_size: 5 },
        { headers: { 'X-Plugin-Token': pToken, 'X-User-Key': projectConfig.userKey } });
      return ((sr.data.data || []) as Array<{ ID: string; name: string }>).map(i => ({ id: i.ID, name: i.name }));
    } catch (e) {
      if (attempt === 1) { console.error('[IM] 搜索失败:', e); return []; }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

export async function triggerAnalysis(workItemName: string, chatId: string, docName: string, senderOpenId: string): Promise<string> {
  if (!hasWikiToken()) {
    savePending(senderOpenId, { workItemName, chatId });
    await sendAuthCard(chatId, docName || workItemName, senderOpenId);
    return '已发送授权卡片。授权成功后分析会自动继续，无需再次发送消息。';
  }
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
    const url = `http://localhost:3456/trigger/new-requirement/${found.ID}?requester=${encodeURIComponent(senderOpenId)}`;
    await axios.post(url);
    return `已启动「${found.name}」分析，稍后报告发给你。`;
  } catch (e: unknown) { return `分析出错: ${e instanceof Error ? e.message : String(e)}`; }
}

async function sendAuthCard(chatId: string, docName?: string, senderOpenId?: string): Promise<void> {
  const doc = docName || '该文档';
  const authUrl = senderOpenId
    ? `http://localhost:3456/auth/feishu-login?open_id=${senderOpenId}`
    : 'http://localhost:3456/auth/feishu-login';
  const token = await getImToken();
  await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId, msg_type: 'interactive',
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { content: '🔐 文档读取授权申请', tag: 'plain_text' }, template: 'blue' },
      elements: [
        { tag: 'markdown', content: `尊敬的同事你好，我是机器人助手智小协。现在申请只读您的文档《${doc}》权限，请予批准，以便我作为项目助手推进进程。十分感谢。\n\n**一次授权，且仅保留14天。**` },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '👉 批准授权（飞书内打开）' }, type: 'primary', url: authUrl }] },
        { tag: 'hr' }, { tag: 'note', elements: [{ tag: 'plain_text', content: '仅读取权限，不修改任何文档。14天后需重新授权。' }] },
      ],
    }),
  }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

async function handleManagement(content: string, _senderOpenId: string, chatId: string): Promise<string | null> {
  // 授权
  if (content.includes('授权')) {
    const docMatch = content.match(/授权[：:\s]*(.+)/);
    await sendAuthCard(chatId, docMatch ? docMatch[1].trim() : undefined, _senderOpenId);
    return '已发送授权申请卡片，请点击按钮批准。';
  }
  // 查看智能体列表
  if (content.includes('查看智能体') || content.includes('智能体列表')) {
    const { registry } = await import('../core/registry');
    const all = registry.getAll();
    if (all.length === 0) return '当前无已注册智能体。';
    return `已注册 ${all.length} 个：\n${all.map((a) => `· ${a.name} → ${a.node}`).join('\n')}`;
  }
  // 查 PRD 链接 / 查需求文档
  if (content.includes('PRD') || content.includes('需求文档') || content.includes('文档链接')) {
    console.log('[IM] PRD查询触发, 关键词提取...');
    // 提取需求名称：取「的PRD」「PRD文档」「需求文档」前面的部分
    let keyword = '';
    const nm = content.match(/(.{2,30}?)(?:的PRD|PRD文档|需求文档|的文档|文档链接|的PRD文档)/);
    if (nm) {
      keyword = nm[1].replace(/[的了把发给我]/g, '').trim();
    } else {
      keyword = content.replace(/PRD|需求|文档|链接|发|的|了|给我|一下|请/g, '').trim();
    }
    console.log('[IM] PRD关键词:', JSON.stringify(keyword));
    if (keyword && keyword.length >= 2) {
      const candidates = await searchRequirements(keyword);
      console.log('[IM] PRD搜索结果:', candidates.length, '个:', candidates.map(c=>c.name).join(','));
      if (candidates.length === 1) {
        const detail = await getWorkItemPrdLink(candidates[0].id);
        if (detail.prdUrl) return `📄「${detail.name}」的 PRD 文档：\n${detail.prdUrl}`;
        return `「${detail.name}」暂无 PRD 文档链接。`;
      } else if (candidates.length > 1) {
        return `找到多个匹配：\n${candidates.map((c,i)=>`${i+1}. ${c.name}`).join('\n')}\n请确认是哪个？`;
      }
    }
    return '未找到相关需求的 PRD 链接，请确认需求名称。';
  }
  return null;
}

/** 获取工作项 PRD 链接 */
async function getWorkItemPrdLink(workItemId: string): Promise<{ name: string; prdUrl: string | null }> {
  const t = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token',
    { plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1 });
  const H = { 'X-Plugin-Token': t.data.data.token, 'X-User-Key': projectConfig.userKey };
  const r = await axios.post('https://project.feishu.cn/open_api/aniwonder/work_item/story/query',
    { work_item_ids: [parseInt(workItemId, 10)], expand: {} }, { headers: H });
  const item = (r.data.data || [])[0] || {};
  const fields = item.fields || [];
  const prdField = fields.find((f: { field_value: unknown }) => {
    const v = f.field_value as string;
    return v && typeof v === 'string' && v.includes('feishu.cn/wiki/');
  });
  return { name: item.name || '', prdUrl: (prdField?.field_value as string) || null };
}

export function startFeishuWS(): void {
  try {
    const wsClient = new Lark.WSClient({ appId: feishuApp.appId, appSecret: feishuApp.appSecret, loggerLevel: Lark.LoggerLevel.info });
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: Record<string, unknown>) => {
        const msg = data.message as Record<string, unknown>;
        const msgId = (msg.message_id as string) || '';
        // 消息去重：同一 message_id 已处理过则跳过
        if (msgId && seenMessages.has(msgId)) return;
        if (msgId) { seenMessages.add(msgId); if (seenMessages.size > 500) seenMessages.clear(); }

        const chatId = (msg.chat_id as string) || '';
        const raw = (msg.content as string) || '';
        const content = (() => { try { return JSON.parse(raw).text || raw; } catch { return raw; } })();
        const senderId = ((data.sender as Record<string, unknown>)?.sender_id as Record<string, string>)?.open_id || '';
        console.log(`[IM] ${chatId}(${senderId.substring(0,10)}): ${content}`);

        // 用户队列：同用户串行，跨用户隔离，不丢消息
        enqueue(senderId, async () => {
          // 0. 确认待处理的分析请求
          if (/^(是|对|确认|yes|ok|好|可以|行)/i.test(content.trim())) {
            const pending = pendingConfirms.get(senderId);
            if (pending) {
              pendingConfirms.delete(senderId);
              const result = await triggerAnalysis(pending.name, chatId, pending.name, senderId);
              await sendIM(chatId, result);
              return;
            }
          }

          // 1. Management commands
          const mgmt = await handleManagement(content, senderId, chatId);
          if (mgmt !== null) { await sendIM(chatId, mgmt); return; }

          // 2. Analysis trigger — 支持多需求（自动去重）
          if (TRIGGER_KW.some((kw) => content.includes(kw))) {
            console.log('[IM] 分析触发, 提取关键词...');
            const names = await extractNames(content);
            console.log('[IM] 提取到', names.length, '个:', names.join(','));

            // 如果 DeepSeek 没提取到需求名但有待确认项，直接用待确认的
            if (names.length === 0) {
              const pending = pendingConfirms.get(senderId);
              if (pending) names.push(pending.name);
            }

            if (names.length > 0) {
              const results: string[] = [];
              const triggered = new Set<string>();
              for (const name of names) {
                const candidates = await searchRequirements(name);
                if (candidates.length === 1) {
                  const exact = candidates[0].name === name;
                  if (exact) {
                    if (!triggered.has(candidates[0].id)) {
                      triggered.add(candidates[0].id);
                      pendingConfirms.delete(senderId);
                      results.push(await triggerAnalysis(candidates[0].name, chatId, candidates[0].name, senderId));
                    }
                  } else {
                    pendingConfirms.set(senderId, { name: candidates[0].name, id: candidates[0].id });
                    results.push(`找到「${candidates[0].name}」，是要分析这个需求吗？回复"是"继续。`);
                  }
                } else if (candidates.length > 1) {
                  results.push(`「${name}」有 ${candidates.length} 个匹配：\n${candidates.map((c,i)=>`${i+1}. ${c.name}`).join('\n')}\n请回复序号确认。`);
                } else {
                  results.push(`未找到与「${name}」匹配的需求。请确认需求名称。`);
                }
              }
              await sendIM(chatId, results.join('\n\n'));
              return;
            }
          }

          // 3. General chat
          await sendIM(chatId, await chatReply(content));
        });
      },
    });
    wsClient.start({ eventDispatcher: dispatcher }).then(() => console.log('[IM] ✅ WebSocket 已连接')).catch((e: Error) => console.error('[IM] 启动失败:', e.message));
  } catch (e) { console.error('[IM] 初始化失败:', e); }
}
