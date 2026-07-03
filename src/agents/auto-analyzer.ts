/**
 * 自动化分析编排器
 * 触发 → 获取工作项 → 提取 PRD → 并行分析 → 输出飞书文档 + 消息
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { getWikiAccessToken } from '../auth/wiki-token';
import { analyzePrdForClarification, formatClarificationResult } from './clarification';
import { analyzePrdForTechFeasibility, formatTechReportResult } from './tech-feasibility';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';

let tenantToken: string | null = null;
async function getTenantToken(): Promise<string> {
  if (tenantToken) return tenantToken;
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET });
  tenantToken = res.data.tenant_access_token as string;
  return tenantToken as string;
}

// ==================== 主入口 ====================

export async function handleNewRequirement(workItemId: string): Promise<{
  clarificationUrl: string; techReportUrl: string;
}> {
  console.log(`[AutoAnalyzer] 开始处理: ${workItemId}`);
  const workItem = await getWorkItemDetail(workItemId);
  console.log(`[AutoAnalyzer] 需求名称: ${workItem.name}`);

  const prdText = await extractPrdContent(workItem);
  if (!prdText) { console.log('[AutoAnalyzer] ⚠ 未找到 PRD'); return { clarificationUrl: '', techReportUrl: '' }; }
  console.log(`[AutoAnalyzer] PRD 内容长度: ${prdText.length} 字`);

  const [clarification, techReport] = await Promise.all([
    analyzePrdForClarification(prdText, workItem.name),
    analyzePrdForTechFeasibility(prdText, workItem.name),
  ]);

  const [clarDoc, techDoc] = await Promise.all([
    createFeishuDoc(`${workItem.name} · 需求澄清问题清单`, formatClarificationResult(clarification)),
    createFeishuDoc(`${workItem.name} · 技术可行性初评报告`, formatTechReportResult(techReport)),
  ]);

  const proposer = workItem.owner || '';
  const techOwner = findNodeOwner(workItem.current_nodes, '技术可行性确认')
    || findNodeOwner(workItem.workflow_nodes, '技术可行性确认') || '';

  const techOpenIds = techOwner ? await resolveUserKeys([techOwner]) : [];
  const proposerOpenIds = proposer && proposer !== techOwner ? await resolveUserKeys([proposer]) : [];

  const clarRecipients = [...new Set([...proposerOpenIds, ...techOpenIds])];
  for (const openId of clarRecipients) {
    await sendReportCard(openId, '需求澄清问题清单', workItem.name, clarDoc.url);
  }
  for (const openId of techOpenIds) {
    await sendReportCard(openId, '技术可行性初评报告', workItem.name, techDoc.url);
  }

  const allIds = [...new Set([...clarRecipients, ...techOpenIds])];
  await grantDocAccess(clarDoc.id, allIds);
  await grantDocAccess(techDoc.id, techOpenIds);

  console.log(`[AutoAnalyzer] 完成`);
  return { clarificationUrl: clarDoc.url, techReportUrl: techDoc.url };
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
    { headers: { 'X-Plugin-Token': t, 'X-User-Key': process.env.FEISHU_PROJECT_USER_KEY || '' } });
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

// ==================== 辅助 ====================

async function getWorkItemDetail(workItemId: string): Promise<{
  name: string; owner?: string; fields: Record<string, unknown>[];
  current_nodes: { name: string; owners?: string[] }[];
  workflow_nodes: { name: string; owners?: string[] }[];
}> {
  const t = await getMeegleToken();
  const res = await axios.post('https://project.feishu.cn/open_api/aniwonder/work_item/story/query',
    { work_item_ids: [parseInt(workItemId, 10)], expand: { need_workflow: true } },
    { headers: { 'X-Plugin-Token': t, 'X-User-Key': process.env.FEISHU_PROJECT_USER_KEY || '' } });
  const item = (res.data.data || [])[0] || {};
  return {
    name: item.name || '', owner: item.created_by || '',
    fields: item.fields || [],
    current_nodes: (item.current_nodes || []).map((n: { name: string; owners?: string[] }) => n),
    workflow_nodes: (item.workflow_infos?.workflow_nodes || []).map((n: { name: string; owners?: string[] }) => n),
  };
}

async function extractPrdContent(workItem: { fields: Record<string, unknown>[] }): Promise<string | null> {
  for (const f of workItem.fields) {
    const v = f.field_value as string;
    if (v && typeof v === 'string' && v.includes('feishu.cn/wiki/')) return readWikiByUrl(v);
  }
  for (const f of workItem.fields) {
    const val = JSON.stringify(f.field_value);
    const match = val.match(/https?:\/\/[^\s"']+\.feishu\.cn\/wiki\/[^\s"']+/);
    if (match) return readWikiByUrl(match[0]);
  }
  return null;
}

async function readWikiByUrl(url: string): Promise<string | null> {
  const match = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!match) return null;
  const token = await getWikiAccessToken();
  if (!token) return null;
  try {
    const nodeRes = await axios.get(`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${match[1]}`,
      { headers: { Authorization: `Bearer ${token}` } });
    const docId = nodeRes.data.data?.node?.obj_token || nodeRes.data.data?.node_token;
    if (!docId) return null;
    const docRes = await axios.get(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=500`,
      { headers: { Authorization: `Bearer ${token}` } });
    const items = docRes.data.data?.items || [];
    return items.map((item: Record<string, unknown>) => {
      const text = item.text as Record<string, unknown> | undefined;
      return ((text?.elements as Array<Record<string, unknown>>) || [])
        .map((e: Record<string, unknown>) => { const run = e.text_run as Record<string, unknown> | undefined; return (run?.content as string) || ''; }).join('');
    }).join('\n');
  } catch (error) { console.error('[AutoAnalyzer] 读取 Wiki 失败:', error); return null; }
}

async function createFeishuDoc(title: string, content: string): Promise<{ id: string; url: string }> {
  const token = await getTenantToken();
  const H = { Authorization: `Bearer ${token}` };
  const create = await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents', { title }, { headers: H });
  const docId: string = create.data.data.document.document_id;
  const paragraphs = content.split('\n').filter((p) => p.trim());
  const blocks = paragraphs.map((p) => ({
    block_type: 2, text: { elements: [{ text_run: { content: p.substring(0, 400) } }] },
  }));
  for (let i = 0; i < blocks.length; i += 45) {
    await axios.post(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      { children: blocks.slice(i, i + 45) }, { headers: H });
  }
  return { id: docId, url: `https://p1iscu6mj28.feishu.cn/docx/${docId}` };
}

async function sendReportCard(openId: string, reportType: string, workItemName: string, docUrl: string): Promise<void> {
  const token = await getTenantToken();
  await axios.post(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id`, {
    receive_id: openId, msg_type: 'interactive',
    content: JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { content: `📄 ${reportType}`, tag: 'plain_text' }, template: 'blue' },
      elements: [{ tag: 'markdown', content: `**${workItemName}** 的${reportType}已生成。\n\n👉 [点击查看](${docUrl})` },
        { tag: 'hr' }, { tag: 'note', elements: [{ tag: 'plain_text', content: '🤖 智小协自动生成' }] }],
    }),
  }, { headers: { Authorization: `Bearer ${token}` } });
}

async function grantDocAccess(docId: string, openIds: string[]): Promise<void> {
  const token = await getTenantToken();
  for (const id of openIds) {
    await axios.post(`https://open.feishu.cn/open-apis/drive/v1/permissions/${docId}/members?type=docx`,
      { member_type: 'openid', member_id: id, perm: 'full_access' },
      { headers: { Authorization: `Bearer ${token}` } }).catch(() => { /* ignore */ });
  }
}

function findNodeOwner(nodes: { name: string; owners?: string[] }[] | undefined, nodeName: string): string | null {
  if (!nodes) return null;
  for (const n of nodes) { if (n.name.includes(nodeName)) return n.owners?.[0] || null; }
  return null;
}

async function resolveUserKeys(userKeys: string[]): Promise<string[]> {
  try {
    const token = await getTenantToken();
    const res = await axios.post('https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id',
      { user_ids: userKeys, id_type: 'user_key' },
      { headers: { Authorization: `Bearer ${token}` } });
    if (res.data.code === 0 && res.data.data?.user_list) {
      return res.data.data.user_list.map((u: { user_id: string }) => u.user_id).filter(Boolean);
    }
  } catch (e) { /* ignore */ }
  const KNOWN: Record<string, string> = { '7649567855117192178': 'ou_8de837db0c63b31eaebbb465c18c9ea8' };
  return userKeys.map((k) => KNOWN[k] || '').filter(Boolean);
}

let meegleToken: string | null = null;
async function getMeegleToken(): Promise<string> {
  if (meegleToken) return meegleToken;
  const res = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: process.env.FEISHU_PROJECT_PLUGIN_ID || '',
    plugin_secret: process.env.FEISHU_PROJECT_PLUGIN_SECRET || '', type: 1,
  });
  meegleToken = res.data.data.token as string;
  return meegleToken as string;
}
