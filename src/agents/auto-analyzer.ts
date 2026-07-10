/**
 * 自动化分析编排器
 * 触发 → 获取工作项 → 提取 PRD → 并行分析 → 输出飞书文档 + 消息
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getWikiAccessToken } from '../auth/wiki-token';
import { getCachedReport, setCachedReport } from '../utils/report-cache';
import { toolRegistry } from '../tools';
import type { ToolContext } from '../tools/_types';

import { feishuApp, projectConfig } from '../config';
const FEISHU_APP_ID = feishuApp.appId;
const FEISHU_APP_SECRET = feishuApp.appSecret;

let tenantToken: string | null = null;
async function getTenantToken(): Promise<string> {
  if (tenantToken) return tenantToken;
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  tenantToken = res.data.tenant_access_token as string;
  return tenantToken as string;
}

// sendReportCard 发送级去重 Map
const _reportSent = new Map<string, number>();

// handleNewRequirement 运行中锁：同一 workItemId 同时只允许一个分析
const _running = new Set<string>();

// ==================== 主入口 ====================

export async function handleNewRequirement(workItemId: string, requester?: string, requesterChatId?: string): Promise<{
  clarificationUrl: string; techReportUrl: string;
}> {
  // 防止同一需求被并发分析两次
  if (_running.has(workItemId)) {
    console.log(`[AutoAnalyzer] ⚠ 跳过重复请求: ${workItemId}`);
    return { clarificationUrl: '', techReportUrl: '' };
  }
  _running.add(workItemId);
  try {
  console.log(`[AutoAnalyzer] 开始处理: ${workItemId}`, requester ? `申请者: ${requester}` : '', requesterChatId ? `chat: ${requesterChatId}` : '');
  const workItem = await getWorkItemDetail(workItemId);
  console.log(`[AutoAnalyzer] 需求名称: ${workItem.name}`);

  const prd = await extractPrdContent(workItem, workItem.name);
  if (prd.needAuth) {
    console.log(`[AutoAnalyzer] ⚠ "${workItem.name}" 的 PRD 需要授权`);
    // 优先发给触发分析的人，其次发给需求提出人
    const ownerOids = workItem.owner ? await resolveUserKeys([workItem.owner]) : [];
    const targets = requester ? [requester, ...ownerOids.filter(o => o !== requester)] : ownerOids;
    for (const oid of targets) {
      await sendAuthCardForDoc(oid, workItem.name);
    }
    return { clarificationUrl: '', techReportUrl: '' };
  }
  if (!prd.text) { console.log('[AutoAnalyzer] ⚠ 未找到 PRD'); return { clarificationUrl: '', techReportUrl: '' }; }
  console.log(`[AutoAnalyzer] PRD 内容长度: ${prd.text.length} 字`);
  const prdText = prd.text;

  // 缓存检查：2周内分析过且PRD未变化 → 直接返回
  const cached = getCachedReport(workItemId, prdText);
  if (cached) {
    console.log(`[AutoAnalyzer] 使用缓存: ${cached.clarificationUrl} / ${cached.techReportUrl}`);
    // 重新发送两份报告
    const proposer = workItem.owner || '';
    const techOwner = findNodeOwner(workItem.current_nodes, '技术可行性确认')
      || findNodeOwner(workItem.workflow_nodes, '技术可行性确认') || '';
    const proposerOids = proposer ? await resolveUserKeys([proposer]) : [];
    const techOids = techOwner ? await resolveUserKeys([techOwner]) : [];
    const techRecipients = techOids.length > 0 ? techOids : proposerOids;

    const servedClar = new Set<string>(); // 已收到需求澄清
    const servedTech = new Set<string>(); // 已收到技术报告
    if (requester) { servedClar.add(requester); servedTech.add(requester); }

    // 1. 触发人 — 优先用 chatId
    if (requester && requesterChatId) {
      await sendReportCard(requesterChatId, '需求澄清问题清单', workItem.name, cached.clarificationUrl, 'chat_id');
      await sendReportCard(requesterChatId, '技术可行性初评报告', workItem.name, cached.techReportUrl, 'chat_id');
    } else if (requester) {
      await sendReportCard(requester, '需求澄清问题清单', workItem.name, cached.clarificationUrl);
      await sendReportCard(requester, '技术可行性初评报告', workItem.name, cached.techReportUrl);
    }
    // 2. 需求提出人（需求澄清）+ 技术负责人（技术报告）
    for (const oid of proposerOids) {
      if (!servedClar.has(oid)) { servedClar.add(oid); await sendReportCard(oid, '需求澄清问题清单', workItem.name, cached.clarificationUrl); }
    }
    for (const oid of techRecipients) {
      if (!servedTech.has(oid)) { servedTech.add(oid); await sendReportCard(oid, '技术可行性初评报告', workItem.name, cached.techReportUrl); }
    }
    // 3. 技术负责人也发需求澄清
    for (const oid of techOids) {
      if (!servedClar.has(oid)) { servedClar.add(oid); await sendReportCard(oid, '需求澄清问题清单', workItem.name, cached.clarificationUrl); }
    }
    // 缓存命中时也给所有相关人员加权限
    const token = await getTenantToken();
    const allRecipients = [...new Set([...proposerOids, ...techRecipients, requester].filter(Boolean))];
    for (const url of [cached.clarificationUrl, cached.techReportUrl]) {
      const match = url.match(/\/file\/([A-Za-z0-9]+)/);
      if (match) {
        for (const oid of allRecipients) {
          await axios.post(
            `https://open.feishu.cn/open-apis/drive/v1/permissions/${match[1]}/members?type=file`,
            { member_type: 'openid', member_id: oid, perm: 'full_access' },
            { headers: { Authorization: `Bearer ${token}` } }
          ).catch(() => {});
        }
      }
    }
    return { clarificationUrl: cached.clarificationUrl, techReportUrl: cached.techReportUrl };
  }

  const toolCtx: ToolContext = { workItemId, workItemName: workItem.name, nodeName: '', fields: {}, prdContent: prdText };

  // 并行：需求澄清 + 技术可行性
  const clarSkillBody = loadAgentSkill('需求分析');
  const techSkillBody = loadAgentSkill('技术可行性初评');
  const [clarContentRaw, techContentRaw] = await Promise.all([
    toolRegistry.get('ai:analyze')!.execute({ ...toolCtx, skillBody: clarSkillBody }),
    toolRegistry.get('ai:analyze')!.execute({ ...toolCtx, skillBody: techSkillBody }),
  ]);

  // 串行：NUDD 基于技术可行性报告做风险识别
  const nuddSkillBody = loadAgentSkill('NUDD风险分析');
  const nuddContext = `## 技术可行性分析结论\n\n${techContentRaw}`;
  const nuddContentRaw = await toolRegistry.get('ai:analyze')!.execute({ ...toolCtx, skillBody: nuddSkillBody, previousOutput: nuddContext });

  // 格式化标题 & 创建文档
  const clarFull = `# ${workItem.name} · 需求澄清问题清单\n\n> 📎 PRD：${prd.prdUrl}\n> 🕐 ${new Date().toLocaleString('zh-CN')}\n\n---\n\n${clarContentRaw}`;
  const techFull = `# ${workItem.name} · 技术可行性初评报告\n\n> 📎 PRD：${prd.prdUrl}\n> 🕐 ${new Date().toLocaleString('zh-CN')}\n\n---\n\n${techContentRaw}`;

  const [clarDoc, techDoc] = await Promise.all([
    toolRegistry.get('docx:create')!.execute({ ...toolCtx, previousOutput: clarFull, workItemName: `${workItem.name} · 需求澄清问题清单` }),
    toolRegistry.get('docx:create')!.execute({ ...toolCtx, previousOutput: techFull, workItemName: `${workItem.name} · 技术可行性初评报告` }),
  ]);

  // 解析 NUDD JSON → HTML 表格
  let nuddDocParsed = { url: '' };
  try {
    const nuddJson = nuddContentRaw.replace(/```json|```/g, '').trim();
    const nuddItems: Array<Record<string,string|number>> = JSON.parse(nuddJson);
    if (Array.isArray(nuddItems) && nuddItems.length > 0) {
      const headers = ['编号','模块','风险项描述','N','U','D(难)','D(异)','总分','等级','影响面','应对方案','解决时间','责任人','状态'];
      const levelColors: Record<string,string> = {'极高风险':'#991B1B','高风险':'#DC2626','中风险':'#D97706','低风险':'#059669'};
      const tableRows = nuddItems.map(r => `<tr>${headers.map(h => {
        const v = String(r[h]||'');
        if (h==='等级') return `<td><span style="display:inline-block;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600;background:${levelColors[v]||'#E2E8F0'}20;color:${levelColors[v]||'#475569'}">${v}</span></td>`;
        return `<td>${v}</td>`;
      }).join('')}</tr>`).join('');

      const total = nuddItems.length;
      const highCount = nuddItems.filter((r:Record<string,unknown>) => String(r.等级||'').includes('高')).length;
      const nuddHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
body{font-family:Inter,-apple-system,sans-serif;background:#F1F5F9;color:#1E293B;padding:32px;line-height:1.6}
.container{max-width:1100px;margin:0 auto}
.header{background:linear-gradient(135deg,#1E3A5F 0%,#1D4ED8 100%);border-radius:16px;padding:40px;color:#FFF;margin-bottom:24px}
.header h1{font-size:28px;margin-bottom:4px}.header .sub{font-size:14px;color:rgba(255,255,255,.65)}
.metrics{display:flex;gap:16px;margin-top:24px}.metric{background:rgba(255,255,255,.1);border-radius:12px;padding:16px 24px;text-align:center}
.metric .v{font-size:32px;font-weight:700}.metric .l{font-size:12px;color:rgba(255,255,255,.5);margin-top:4px}
.card{background:#FFF;border-radius:14px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
h2{font-size:18px;color:#1E293B;margin-bottom:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#F8FAFC;padding:8px 6px;text-align:left;border-bottom:2px solid #E2E8F0;font-size:11px;color:#64748B}
td{padding:8px 6px;border-bottom:1px solid #F1F5F9;vertical-align:top}
tr:hover td{background:#FAFBFC}
.footer{margin-top:24px;text-align:center;color:#94A3B8;font-size:12px}
</style></head><body><div class="container">
<div class="header"><h1>⚠️ NUDD 风险登记表</h1><div class="sub">${workItem.name} · ${new Date().toLocaleString('zh-CN')} · AI 自动生成</div>
<div class="metrics"><div class="metric"><div class="v">${total}</div><div class="l">风险项</div></div><div class="metric"><div class="v" style="color:#FCA5A5">${highCount}</div><div class="l">高风险以上</div></div></div></div>
<div class="card"><h2>风险登记表（13 列）</h2><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></div>
<div class="card"><h2>等级分布</h2><div style="display:flex;gap:12px;font-size:13px">
${['极高风险','高风险','中风险','低风险'].map(lv=>`<span style="padding:4px 12px;border-radius:8px;background:${levelColors[lv]}20;color:${levelColors[lv]};font-weight:600">${lv}: ${nuddItems.filter((r:Record<string,unknown>)=>String(r.等级||'')===lv).length} 项</span>`).join('')}</div></div>
<div class="footer">🤖 智小协 · NUDD 风险分析智能体</div></div></body></html>`;

      const nuddDoc = await toolRegistry.get('docx:create')!.execute({ ...toolCtx, previousOutput: nuddHtml, workItemName: `${workItem.name} · NUDD风险登记表` });
      nuddDocParsed = { url: nuddDoc };
    }
  } catch (e) { console.error('[NUDD] 解析失败:', e); }

  const clarDocParsed = { url: clarDoc };
  const techDocParsed = { url: techDoc };

  // 写入缓存（14天有效）
  setCachedReport(workItemId, workItem.name, prdText, clarDocParsed.url, techDocParsed.url);

  const proposer = workItem.owner || '';
  const techOwner = findNodeOwner(workItem.current_nodes, '技术可行性确认')
    || findNodeOwner(workItem.workflow_nodes, '技术可行性确认') || '';

  const proposerOpenIds = proposer ? await resolveUserKeys([proposer]) : [];
  const techOpenIds = techOwner ? await resolveUserKeys([techOwner]) : [];
  // Fallback: 技术负责人为空时，发给需求提出人
  const techRecipients = techOpenIds.length > 0 ? techOpenIds : proposerOpenIds;

  // 给所有相关人员加文件权限
  const token = await getTenantToken();
  const allRecipients = [...new Set([...proposerOpenIds, ...techRecipients, requester].filter(Boolean))];
  for (const url of [clarDocParsed.url, techDocParsed.url, nuddDocParsed.url].filter(Boolean)) {
    const fileMatch = url.match(/\/file\/([A-Za-z0-9]+)/);
    const docxMatch = url.match(/\/docx\/([A-Za-z0-9]+)/);
    const tokenId = fileMatch?.[1] || docxMatch?.[1];
    const permType = fileMatch ? 'file' : 'docx';
    if (tokenId) {
      for (const oid of allRecipients) {
        await axios.post(
          `https://open.feishu.cn/open-apis/drive/v1/permissions/${tokenId}/members?type=${permType}`,
          { member_type: 'openid', member_id: oid, perm: 'full_access' },
          { headers: { Authorization: `Bearer ${token}` } }
        ).catch(() => {});
      }
    }
  }

  // === 发送报告卡片 ===
  const servedClar = new Set<string>(); // 已收到需求澄清
  const servedTech = new Set<string>(); // 已收到技术报告
  if (requester) { servedClar.add(requester); servedTech.add(requester); }

  // 1. 触发人 — 优先用 chatId 往聊天窗口直接发
  if (requester && requesterChatId) {
    await sendReportCard(requesterChatId, '需求澄清问题清单', workItem.name, clarDocParsed.url, 'chat_id');
    await sendReportCard(requesterChatId, '技术可行性初评报告', workItem.name, techDocParsed.url, 'chat_id');
  } else if (requester) {
    await sendReportCard(requester, '需求澄清问题清单', workItem.name, clarDocParsed.url);
    await sendReportCard(requester, '技术可行性初评报告', workItem.name, techDocParsed.url);
  }
  // 2. 需求提出人（需求澄清）+ 技术负责人（技术报告）
  for (const oid of proposerOpenIds) {
    if (!servedClar.has(oid)) { servedClar.add(oid); await sendReportCard(oid, '需求澄清问题清单', workItem.name, clarDocParsed.url); }
  }
  for (const oid of techRecipients) {
    if (!servedTech.has(oid)) { servedTech.add(oid); await sendReportCard(oid, '技术可行性初评报告', workItem.name, techDocParsed.url); }
    if (nuddDocParsed.url && oid !== requester) await sendReportCard(oid, 'NUDD风险登记表', workItem.name, nuddDocParsed.url);
  }
  // 触发人也发 NUDD
  if (nuddDocParsed.url && requester && requesterChatId) {
    await sendReportCard(requesterChatId, 'NUDD风险登记表', workItem.name, nuddDocParsed.url, 'chat_id');
  }
  // 3. 技术负责人也发一份需求澄清
  for (const oid of techOpenIds) {
    if (!servedClar.has(oid)) { servedClar.add(oid); await sendReportCard(oid, '需求澄清问题清单', workItem.name, clarDocParsed.url); }
  }

  console.log(`[AutoAnalyzer] 完成`);
  return { clarificationUrl: clarDocParsed.url, techReportUrl: techDocParsed.url };
  } finally {
    _running.delete(workItemId);
  }
}

// ==================== 每日轮询 ====================

const STATE_FILE = path.resolve(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.claude/channels/feishu/prd_check_state.json'
);

export async function checkDailyNewPrds(): Promise<{ totalFound: number; processed: string[] }> {
  const lastChecked = getLastCheckedTime();
  const t = await getMeegleToken();
  const res = await axios.post('https://project.feishu.cn/open_api/aniwonder/work_item/filter',
    { work_item_type_keys: ['story'], page_size: 50 },
    { headers: { 'X-Plugin-Token': t, 'X-User-Key': projectConfig.userKey } });
  const items: Array<{ id: string; name: string; created_at?: number }> = res.data.data?.data || [];
  const newItems = items.filter((item) => (item.created_at || 0) > lastChecked);
  console.log(`[DailyCheck] ${items.length} 个需求，${newItems.length} 个新增`);
  const processed: string[] = [];
  for (const item of newItems) {
    try { await handleNewRequirement(String(item.id)); processed.push(item.name); }
    catch (e) { console.error(`[DailyCheck] ${item.name} 失败:`, e); }
  }
  saveCheckTime();
  return { totalFound: newItems.length, processed };
}

function getLastCheckedTime(): number {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')).lastCheckedAt || 0; }
  catch { /* ignore */ }
  return Date.now() - 24 * 60 * 60 * 1000;
}
function saveCheckTime(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastCheckedAt: Date.now() }), 'utf-8');
}

async function sendAuthCardForDoc(openId: string, docName: string): Promise<void> {
  const token = await getTenantToken();
  await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId, msg_type: 'interactive',
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { content: '🔐 文档读取授权申请', tag: 'plain_text' }, template: 'blue' },
      elements: [
        { tag: 'markdown', content: `尊敬的同事你好，我是机器人助手智小协。现在申请只读您的文档《${docName}》权限，请予批准，以便我作为项目助手推进进程。十分感谢。\n\n**一次授权，且仅保留14天。**` },
        { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '👉 批准授权（飞书内打开）' }, type: 'primary', url: `http://localhost:3456/auth/feishu-login?open_id=${openId}` }] },
        { tag: 'hr' }, { tag: 'note', elements: [{ tag: 'plain_text', content: '仅读取权限，不修改任何文档。14天后需重新授权。' }] },
      ],
    }),
  }, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

// ==================== 辅助 ====================

async function getWorkItemDetail(workItemId: string): Promise<{
  name: string; owner?: string; fields: Record<string, unknown>[];
  current_nodes: { name: string; owners?: string[] }[];
  workflow_nodes: { name: string; owners?: string[] }[];
}> {
  const t = await getMeegleToken();
  const res = await axios.post('https://project.feishu.cn/open_api/aniwonder/work_item/story/query',
    { work_item_ids: [parseInt(workItemId, 10)], expand: { need_workflow: true } },
    { headers: { 'X-Plugin-Token': t, 'X-User-Key': projectConfig.userKey } });
  const item = (res.data.data || [])[0] || {};
  return {
    name: item.name || '', owner: item.created_by || '',
    fields: item.fields || [],
    current_nodes: (item.current_nodes || []).map((n: { name: string; owners?: string[] }) => n),
    workflow_nodes: (item.workflow_infos?.workflow_nodes || []).map((n: { name: string; owners?: string[] }) => n),
  };
}

async function extractPrdContent(workItem: { fields: Record<string, unknown>[] }, docName: string): Promise<{ text: string | null; needAuth: boolean; prdUrl: string }> {
  for (const f of workItem.fields) {
    const v = f.field_value as string;
    if (v && typeof v === 'string' && v.includes('feishu.cn/wiki/')) {
      const text = await readWikiByUrl(v, docName);
      return { text, needAuth: text === null, prdUrl: v };
    }
  }
  return { text: null, needAuth: false, prdUrl: '' };
}

async function readWikiByUrl(url: string, docName?: string): Promise<string | null> {
  const match = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!match) return null;
  const token = await getWikiAccessToken();
  if (!token) {
    // 无 token → 需要授权 → 仅记日志，由上层处理
    console.log('[AutoAnalyzer] Wiki Token 未授权，需要先完成 OAuth 授权');
    return null;
  }
  try {
    const nodeRes = await axios.get(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${match[1]}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const docId = nodeRes.data.data?.node?.obj_token || nodeRes.data.data?.node_token;
    if (!docId) return null;

    // 优先用 raw_content（直接返回纯文本，处理所有文档类型）
    const rawRes = await axios.get(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/raw_content`,
      { headers: { Authorization: `Bearer ${token}` } });
    const rawContent = rawRes.data.data?.content || '';

    // Fallback: blocks API（处理 raw_content 不支持的旧文档）
    if (!rawContent.trim()) {
      const blockRes = await axios.get(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=500`,
        { headers: { Authorization: `Bearer ${token}` } });
      const items = blockRes.data.data?.items || [];
      return items.map((item: Record<string, unknown>) => {
        const text = item.text as Record<string, unknown> | undefined;
        return ((text?.elements as Array<Record<string, unknown>>) || [])
          .map((e: Record<string, unknown>) => { const run = e.text_run as Record<string, unknown> | undefined; return (run?.content as string) || ''; }).join('');
      }).join('\n');
    }
    return rawContent;
  } catch (error) { console.error('[AutoAnalyzer] 读取 Wiki 失败:', error); return null; }
}

// 飞书文档模板 token（对应 agents/ 下的 Agent），仅作格式参考
const TEMPLATE_WIKI_TOKENS: Record<string, string> = {
  '需求分析': 'YThPwbt5ziWdKokj1GNcNMGWndg',
  '技术可行性初评': 'Jelnw8e69idtBrkgTvlcDhfXnih',
};

/** 读取飞书模板的纯文本内容（用作 AI 格式参考） */
async function readTemplateText(wikiToken: string): Promise<string> {
  try {
    const t = await getWikiAccessToken();
    if (!t) return '';
    const nr = await axios.get(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${wikiToken}`,
      { headers: { Authorization: `Bearer ${t}` } });
    const docId = nr.data.data?.node?.obj_token;
    if (!docId) return '';
    const rr = await axios.get(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/raw_content`,
      { headers: { Authorization: `Bearer ${t}` } });
    return rr.data.data?.content || '';
  } catch { return ''; }
}

async function sendReportCard(
  targetId: string,
  reportType: string,
  workItemName: string,
  docUrl: string,
  receiveIdType: 'open_id' | 'chat_id' = 'open_id',
): Promise<void> {
  // 发送级去重：同一目标 + 同一报告类型 + 同一文档URL，5秒内不重复发
  const dedupKey = `${receiveIdType}:${targetId}:${reportType}:${docUrl}`;
  const lastSent = _reportSent.get(dedupKey) || 0;
  if (Date.now() - lastSent < 5000) { console.log('[sendReportCard] dedup skip:', reportType, targetId.substring(0, 15)); return; }
  _reportSent.set(dedupKey, Date.now());
  if (_reportSent.size > 200) { const now = Date.now(); for (const [k, ts] of _reportSent) { if (now - ts > 10000) _reportSent.delete(k); } }

  try {
    const token = await getTenantToken();
    const res = await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        receive_id: targetId,
        msg_type: 'interactive',
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          header: { title: { content: `📄 ${reportType}`, tag: 'plain_text' }, template: 'blue' },
          elements: [
            { tag: 'markdown', content: `**${workItemName}** 的${reportType}已生成。\n\n👉 [点击查看](${docUrl})` },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '🤖 智小协自动生成' }] },
          ],
        }),
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
    );
    if (res.data?.code !== 0) {
      console.error(`[sendReportCard] API返回错误 [${receiveIdType}=${targetId}]: code=${res.data?.code} msg=${res.data?.msg}`);
    } else {
      console.log(`[sendReportCard] ✅ ${reportType} → ${receiveIdType}=${targetId}`);
    }
  } catch (e: unknown) {
    console.error(`[sendReportCard] 发送失败 [${receiveIdType}=${targetId}]: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function grantDocAccess(docId: string, openIds: string[]): Promise<void> {
  const token = await getTenantToken();
  for (const id of openIds) {
    await axios.post(`https://open.feishu.cn/open-apis/drive/v1/permissions/${docId}/members?type=docx`,
      { member_type: 'openid', member_id: id, perm: 'full_access' },
      { headers: { Authorization: `Bearer ${token}` } }).catch(() => { /* ignore */ });
  }
}

/** 加载 Agent 的 SKILL.md 正文（YAML frontmatter 之后的部分） */
function loadAgentSkill(agentName: string): string {
  const skillPath = path.resolve(__dirname, '../../agents', agentName, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    const raw = fs.readFileSync(skillPath, 'utf-8');
    const parts = raw.split(/^---$/m);
    return parts.length >= 3 ? parts.slice(2).join('---').trim() : raw.trim();
  }
  return '';
}

function findNodeOwner(nodes: { name: string; owners?: string[] }[] | undefined, nodeName: string): string | null {
  if (!nodes) return null;
  for (const n of nodes) { if (n.name.includes(nodeName)) return n.owners?.[0] || null; }
  return null;
}

const userKeyCache: Record<string, string> = { '7649567855117192178': 'ou_8de837db0c63b31eaebbb465c18c9ea8' };

async function resolveUserKeys(userKeys: string[]): Promise<string[]> {
  const results: string[] = [];
  const unknowns: string[] = [];

  for (const uk of userKeys) {
    if (userKeyCache[uk]) { results.push(userKeyCache[uk]); } else { unknowns.push(uk); }
  }

  if (unknowns.length === 0) return results;

  // Method 1: Contact API batch_get_id
  try {
    const token = await getTenantToken();
    const res = await axios.post('https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id',
      { user_ids: unknowns, id_type: 'user_key' },
      { headers: { Authorization: `Bearer ${token}` } });
    if (res.data.code === 0 && res.data.data?.user_list) {
      for (const u of res.data.data.user_list as Array<{ user_id: string }>) {
        if (u.user_id) userKeyCache[unknowns[0]] = u.user_id; // approximate mapping
      }
      return [...results, ...res.data.data.user_list.map((u: { user_id: string }) => u.user_id).filter(Boolean)];
    }
  } catch (e) { /* continue */ }

  // Method 2: Meegle user query → get name → contact search
  for (const uk of unknowns) {
    try {
      const mt = await getMeegleToken();
      const ur = await axios.post('https://project.feishu.cn/open_api/user/query',
        { user_keys: [uk] },
        { headers: { 'X-Plugin-Token': mt, 'X-User-Key': projectConfig.userKey } });
      const uArr = ur.data.data || [];
      const name = uArr[0]?.name?.zh_cn || uArr[0]?.name_cn || uArr[0]?.name?.default || '';
      if (name) {
        const token = await getTenantToken();
        const sr = await axios.get(`https://open.feishu.cn/open-apis/contact/v3/users?page_size=3&name=${encodeURIComponent(name)}`,
          { headers: { Authorization: `Bearer ${token}` } });
        const items = sr.data.data?.items || [];
        const found = items.find((u: { open_id: string }) => u.open_id);
        if (found?.open_id) {
          userKeyCache[uk] = found.open_id;
          results.push(found.open_id);
        }
      }
    } catch (e) { /* skip */ }
  }

  return results;
}

let meegleToken: string | null = null;
async function getMeegleToken(): Promise<string> {
  if (meegleToken) return meegleToken;
  const res = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: projectConfig.pluginId,
    plugin_secret: projectConfig.pluginSecret, type: 1,
  });
  meegleToken = res.data.data.token as string;
  return meegleToken as string;
}
