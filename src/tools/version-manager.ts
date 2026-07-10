/**
 * 版本管理技能 handler
 *
 * 能力:
 *   runHeadcount()         — 人力盘点（递归 SRD 树）
 *   runScheduleNotice()    — 排期通知
 *   checkProgressDeviation() — 进度偏离检测
 */
import axios from 'axios';
import { execSync } from 'child_process';
import { projectConfig } from '../../src/config';
import path from 'path';
import fs from 'fs';

const TARGET_OPEN_ID = 'ou_8de837db0c63b31eaebbb465c18c9ea8';
const VERSION_TK = '6a41e22f1dcaa1da30c0ca94';
const SRD_TK = '6a43902cd74ffc7dc45d66e1';
const RISK_TK = '62a9886338f01f6454763702';
const ISSUE_TK = '66eb8c54c29bb03feda64083';

// ==================== 类型 ====================

interface VersionItem {
  id: string; name: string; creator: string;
  workflow_nodes: WfNode[];
  fields: Record<string, unknown>;
}
interface SRDItem {
  id: string; name: string; creator: string;
  taskLevel: string; parentId: string; moduleLabels: string[];
  isDone: boolean;
  workflow_nodes: WfNode[];
}
interface WfNode { name: string; status: number; actual_begin_time?: string; actual_finish_time?: string; }
interface LeafTask { id: string; name: string; creator: string; moduleLabels: string[]; completed: boolean; parentChain: string; }

// ==================== Token ====================

let meegleToken: string | null = null;
async function getToken(): Promise<string> {
  if (meegleToken) return meegleToken;
  const r = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1,
  });
  meegleToken = r.data.data.token as string;
  return meegleToken as string;
}
async function apiQuery(typeKey: string, ids: number[]): Promise<Record<string, unknown>[]> {
  const H = { 'X-Plugin-Token': await getToken(), 'X-User-Key': projectConfig.userKey };
  const r = await axios.post(`https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/${typeKey}/query`,
    { work_item_ids: ids, expand: { need_workflow: true } }, { headers: H });
  return (r.data.data || []) as Record<string, unknown>[];
}
async function apiFilter(typeKey: string, pageSize = 20): Promise<{ id: string; name: string }[]> {
  const H = { 'X-Plugin-Token': await getToken(), 'X-User-Key': projectConfig.userKey };
  let all: { id: string; name: string }[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await axios.post(`https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/filter`,
      { work_item_type_keys: [typeKey], page_size: pageSize, page_num: page }, { headers: H });
    const data = r.data.data || [];
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

// ==================== 用户名称解析 ====================

const userNameCache: Record<string, string> = {};

async function resolveUserName(userKey: string): Promise<string> {
  if (!userKey || userKey === 'undefined') return '未分配';
  if (userNameCache[userKey]) return userNameCache[userKey];
  // 尝试 Meegle 用户查询
  try {
    const H = { 'X-Plugin-Token': await getToken(), 'X-User-Key': projectConfig.userKey };
    const r = await axios.post('https://project.feishu.cn/open_api/user/query',
      { user_keys: [userKey] }, { headers: H });
    const u = (r.data.data || [])[0];
    const name = u?.name?.zh_cn || u?.name_cn || u?.name?.default || u?.name || '';
    if (name) { userNameCache[userKey] = name; return name; }
  } catch { /* ignore */ }
  return userKey.slice(-8); // fallback: 末 8 位
}

// ==================== 图表生成 ====================

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const OUTPUT_DIR = path.resolve(__dirname, '../../output');

/** MD文本 → 飞书 Docx 块数组 */
function mdToDocxBlocks(md: string, imageBlocks: { marker: string; imageKey: string; width: number; height: number }[]): unknown[] {
  const blocks: unknown[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { blocks.push({ block_type: 2, text: { elements: [{ text_run: { content: '' } }] } }); continue; }

    // 图片占位符: <!-- chart:name -->
    const chartMatch = t.match(/^<!--\s*chart:(\S+)\s*-->/);
    if (chartMatch) {
      const img = imageBlocks.find(ib => ib.marker === chartMatch[1]);
      if (img) { blocks.push({ block_type: 27, image: { image_key: img.imageKey, width: img.width, height: img.height } }); }
      continue;
    }

    // 表格行
    if (t.startsWith('|') && t.endsWith('|')) {
      continue; // 跳过表格（Docx 表格太复杂，保留为 MD 表格块塞进 text）
    }

    // 标题
    if (t.startsWith('### ')) { blocks.push({ block_type: 5, heading3: { elements: [{ text_run: { content: t.slice(4) } }], style: {} } }); continue; }
    if (t.startsWith('## ')) { blocks.push({ block_type: 4, heading2: { elements: [{ text_run: { content: t.slice(3) } }], style: {} } }); continue; }
    if (t.startsWith('# ')) { blocks.push({ block_type: 3, heading1: { elements: [{ text_run: { content: t.slice(2) } }], style: {} } }); continue; }

    // 分隔线
    if (t === '---') { continue; }

    // 列表项
    if (t.startsWith('- ')) {
      blocks.push({ block_type: 2, text: { elements: [{ text_run: { content: '  ' + t } }] } });
      continue;
    }

    // 普通文本
    blocks.push({ block_type: 2, text: { elements: [{ text_run: { content: t } }] } });
  }
  return blocks;
}

async function genChartImage(type: string, data: Record<string, unknown>, name: string): Promise<string | null> {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const dataFile = path.join(OUTPUT_DIR, `${name}.json`);
    const svgFile = path.join(OUTPUT_DIR, `${name}.svg`);
    const pngFile = path.join(OUTPUT_DIR, `${name}.png`);
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf-8');
    execSync(`python "${SCRIPTS_DIR}/gen_charts.py" ${type} "${dataFile}" "${svgFile}"`, { timeout: 15000, stdio: 'pipe' });
    if (!fs.existsSync(svgFile)) return null;

    // SVG → PNG via sharp
    const sharp = require('sharp');
    await sharp(svgFile).png().toFile(pngFile);
    console.log(`[chart] ✅ ${name}.png`);
    return pngFile; // 返回 PNG 文件路径，由上传层处理
  } catch (e) { console.error(`[chart] ${name} 失败:`, (e as Error).message); }
  return null;
}

// ==================== Docx 发布 ====================

export async function publishAsHtml(title: string, htmlContent: string): Promise<string> {
  const tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: (await import('../../src/config')).feishuApp.appId,
    app_secret: (await import('../../src/config')).feishuApp.appSecret,
  });
  const H = { Authorization: `Bearer ${tokenRes.data.tenant_access_token}` };
  const targetOpenId = 'ou_8de837db0c63b31eaebbb465c18c9ea8';

  const fn = `${title.replace(/[\\/:*?"<>|]/g, '_')}.html`;
  const fp = path.join(OUTPUT_DIR, fn);
  fs.writeFileSync(fp, htmlContent, 'utf-8');

  const fd = new (require('form-data'))();
  fd.append('file_name', fn); fd.append('parent_type', 'explorer'); fd.append('parent_node', '');
  fd.append('size', String(fs.statSync(fp).size)); fd.append('file', fs.createReadStream(fp));
  const u = await axios.post('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', fd, {
    headers: { ...H, ...fd.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  const ft = u.data.data?.file_token;
  if (ft) {
    await axios.post(`https://open.feishu.cn/open-apis/drive/v1/permissions/${ft}/members?type=file`,
      { member_type: 'openid', member_id: targetOpenId, perm: 'full_access' }, { headers: H }).catch(() => {});
    const url = `https://p1iscu6mj28.feishu.cn/file/${ft}`;
    console.log(`[html] ✅ ${title} → ${url}`);
    return url;
  }
  return 'upload_failed';
}

// ==================== HTML 模板 ====================

const CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F1F5F9;color:#1E293B;line-height:1.6;-webkit-font-smoothing:antialiased}
.page{max-width:1200px;margin:0 auto;padding:40px 24px}
.header{background:linear-gradient(135deg,#0F172A 0%,#1E3A5F 50%,#1D4ED8 100%);border-radius:24px;padding:48px 56px;margin-bottom:32px;color:#FFF;position:relative;overflow:hidden}
.header::after{content:'';position:absolute;top:-80px;right:-80px;width:300px;height:300px;background:rgba(255,255,255,.03);border-radius:50%}
.header::before{content:'';position:absolute;bottom:-60px;left:30%;width:200px;height:200px;background:rgba(255,255,255,.02);border-radius:50%}
.header h1{font-size:32px;font-weight:700;letter-spacing:-0.5px;margin-bottom:6px;position:relative;z-index:1}
.header .sub{font-size:15px;color:rgba(255,255,255,.65);position:relative;z-index:1}
.header .sub span{margin:0 8px;color:rgba(255,255,255,.3)}.header .sub time{color:rgba(255,255,255,.8)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-top:36px;position:relative;z-index:1}
.metric{background:rgba(255,255,255,.08);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:24px 28px}
.metric .value{font-size:44px;font-weight:800;letter-spacing:-1.5px;line-height:1;margin-bottom:8px}
.metric .label{font-size:13px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:1px;font-weight:500}
.metric.danger .value{color:#FCA5A5}.metric.warning .value{color:#FCD34D}
.section{margin-bottom:40px}
.section-title{font-size:20px;font-weight:700;color:#0F172A;margin-bottom:8px;display:flex;align-items:center;gap:10px}
.section-title .icon{font-size:24px}.section-summary{font-size:14px;color:#475569;margin-bottom:16px;line-height:1.6}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.card{background:#FFF;border-radius:20px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,.04);border:1px solid #E2E8F0;margin-bottom:20px}
.card-sm{padding:20px}
.alert{display:flex;align-items:flex-start;gap:14px;padding:18px 24px;border-radius:14px;margin-bottom:14px;font-size:14px}
.alert-critical{background:linear-gradient(135deg,#FEF2F2,#FEE2E2);border:1px solid #FECACA}
.alert-warning{background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border:1px solid #FDE68A}
.alert-dot{width:10px;height:10px;border-radius:50%;margin-top:4px;flex-shrink:0}
.dot-critical{background:#DC2626}.dot-warning{background:#D97706}
.v-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.v-card{background:#FFF;border-radius:16px;padding:24px;border:1px solid #E2E8F0;position:relative;overflow:hidden}
.v-card::before{content:'';position:absolute;top:0;left:0;right:0;height:4px}
.v-card.critical::before{background:linear-gradient(90deg,#DC2626,#F87171)}
.v-card.warning::before{background:linear-gradient(90deg,#D97706,#FBBF24)}
.v-card.ok::before{background:linear-gradient(90deg,#059669,#34D399)}
.v-card .v-name{font-size:18px;font-weight:700;margin-bottom:4px}
.v-card .v-stage{font-size:13px;color:#64748B;margin-bottom:12px}
.v-stat{display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px}
.v-stat span:first-child{color:#64748B}.v-stat span:last-child{font-weight:600}
.progress-bar{height:6px;background:#E2E8F0;border-radius:3px;overflow:hidden;margin:12px 0}
.progress-fill{height:100%;border-radius:3px}.fill-red{background:#DC2626}.fill-amber{background:#D97706}.fill-green{background:#059669}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:12px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#64748B;border-bottom:2px solid #E2E8F0;background:#F8FAFC}td{padding:12px 16px;border-bottom:1px solid #F1F5F9;color:#334155}tr:hover td{background:#FAFBFC}
.tag{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600}.tag-red{background:#FEE2E2;color:#991B1B}.tag-amber{background:#FEF3C7;color:#92400E}.tag-green{background:#DCFCE7;color:#065F46}.tag-gray{background:#F1F5F9;color:#475569}
.spark-row{display:flex;align-items:center;gap:12px;margin:4px 0;font-size:13px}.spark-label{min-width:80px;color:#475569;font-weight:500}.spark-bar{flex:1;height:8px;background:#E2E8F0;border-radius:4px;overflow:hidden}.spark-fill{height:100%;border-radius:4px}.spark-val{min-width:36px;text-align:right;font-weight:600}
.timeline{display:flex;align-items:center;gap:0;padding:16px 0;overflow-x:auto}.tl-node{text-align:center;flex-shrink:0}.tl-dot{width:14px;height:14px;border-radius:50%;margin:0 auto 6px}.tl-dot.done{background:#059669}.tl-dot.active{background:#1D4ED8;box-shadow:0 0 0 4px rgba(29,78,216,.2)}.tl-dot.pending{background:#CBD5E1}.tl-label{font-size:11px;font-weight:600;color:#475569}.tl-date{font-size:10px;color:#94A3B8}.tl-line{flex:1;height:2px;background:#E2E8F0;min-width:20px;margin-bottom:20px}.tl-line.done{background:#059669}
.tree{font-size:13px;line-height:2}.tree-item{padding:3px 0 3px 20px;position:relative}.tree-item::before{content:'├─';position:absolute;left:0;color:#CBD5E1;font-family:monospace}.tree-item:last-child::before{content:'└─'}
.risk-detail{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;font-size:13px}
.risk-detail strong{color:#1E293B}.risk-detail .lbl{color:#64748B}
.risk-desc{font-size:13px;color:#475569;line-height:1.6;background:#F8FAFC;padding:12px;border-radius:8px}
.nudd-scores{display:flex;gap:24px;font-size:12px;margin-top:12px}
.footer{margin-top:48px;text-align:center;color:#94A3B8;font-size:12px}
.progress-row{display:flex;align-items:center;gap:16px;margin:8px 0;font-size:14px}.progress-label{min-width:60px;color:#475569;font-weight:500}.progress-bar{flex:1;height:12px;background:#E2E8F0;border-radius:6px;overflow:hidden}.progress-fill{height:100%;border-radius:6px}.fill-red{background:#DC2626}.fill-blue{background:#1D4ED8}.fill-amber{background:#D97706}.progress-val{min-width:48px;text-align:right;font-weight:700;font-size:15px}.deviation-box{display:flex;justify-content:center;align-items:center;padding:32px;background:#FEF2F2;border-radius:16px;margin:16px 0}.deviation-num{font-size:64px;font-weight:900;letter-spacing:-2px;color:#DC2626}.deviation-label{font-size:14px;color:#991B1B;margin-left:12px}.issue-list{list-style:none}.issue-list li{padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:13px;display:flex;align-items:center;gap:10px}.issue-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}.dot-red{background:#DC2626}.dot-amber{background:#D97706}.action-list{margin-top:8px}.action-list li{margin-bottom:8px;font-size:14px;line-height:1.6}
@media(max-width:900px){.metrics{grid-template-columns:repeat(2,1fr)}.grid2,.v-cards{grid-template-columns:1fr}.header{padding:32px 28px}}`;

const H_HEAD = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CSS}</style></head><body><div class="page">`;
const H_TAIL = `<div class="footer">🤖 智小协 · 版本管理智能体 · 每日 10:30 / 16:00 自动更新</div></div></body></html>`;

// ==================== 数据获取 ====================

function extractField(item: Record<string, unknown>, name: string): unknown {
  return (item.fields as Array<{ field_name: string; field_value: unknown }>)?.find(f => f.field_name === name)?.field_value;
}
function parseWfNodes(item: Record<string, unknown>): WfNode[] {
  const wf = (item.workflow_infos as Record<string, unknown>) || {};
  return (wf.workflow_nodes || []) as WfNode[];
}

async function loadAllData(): Promise<{ versions: VersionItem[]; srdMap: Map<number, SRDItem>; risks: Record<string, unknown>[] }> {
  const verList = await apiFilter(VERSION_TK);
  const srdList = await apiFilter(SRD_TK);
  const riskList = await apiFilter(RISK_TK);

  const verIds = verList.map(v => parseInt(v.id, 10));
  const srdIds = srdList.map(s => parseInt(s.id, 10));
  const riskIds = riskList.map(r => parseInt(r.id, 10));

  const [verData, srdData, riskData] = await Promise.all([
    verIds.length > 0 ? apiQuery(VERSION_TK, verIds) : Promise.resolve([]),
    srdIds.length > 0 ? apiQuery(SRD_TK, srdIds) : Promise.resolve([]),
    riskIds.length > 0 ? apiQuery(RISK_TK, riskIds) : Promise.resolve([]),
  ]);

  const versions: VersionItem[] = verData.map(v => ({
    id: String(v.id), name: (v.name as string) || '',
    creator: (v.created_by as string) || '',
    workflow_nodes: parseWfNodes(v),
    fields: v.fields as Record<string, unknown> || {},
  }));

  const srdMap = new Map<number, SRDItem>();
  for (const s of srdData) {
    srdMap.set(Number(s.id), {
      id: String(s.id), name: (s.name as string) || '',
      creator: (s.created_by as string) || '',
      taskLevel: (extractField(s, '任务层级') as string) || '',
      parentId: String(extractField(s, '父级任务') || ''),
      moduleLabels: ((extractField(s, '所属模块') as Array<{ label: string }>) || []).map(m => m.label),
      isDone: !!extractField(s, '是否完成'),
      workflow_nodes: parseWfNodes(s),
    });
  }

  return { versions, srdMap, risks: riskData };
}

// ==================== 递归 SRD 树 ====================

function collectLeaves(srdIds: string[], srdMap: Map<number, SRDItem>): LeafTask[] {
  const leaves: LeafTask[] = [];
  const seen = new Set<string>();
  // 只从顶级 SRD 开始递归（parentId 不在 srdIds 中，或 parentId 为空）
  const topIds = srdIds.filter(id => {
    const srd = srdMap.get(Number(id));
    if (!srd) return false;
    if (!srd.parentId || srd.parentId === '') return true;
    return !srdIds.some(sid => String(sid) === String(srd.parentId));
  });

  function walk(id: string, chain: string): void {
    if (seen.has(id)) return;
    seen.add(id);
    const srd = srdMap.get(Number(id));
    if (!srd) return;
    const children = [...srdMap.values()].filter(s => s.parentId === id && srdIds.includes(s.id));
    if (children.length === 0) {
      const completed = srd.workflow_nodes?.find(n => n.name === '已完成')?.status === 3;
      leaves.push({ id: srd.id, name: srd.name, creator: srd.creator, moduleLabels: srd.moduleLabels, completed, parentChain: chain + srd.name });
    } else {
      for (const c of children) walk(c.id, chain + srd.name + ' → ');
    }
  }
  for (const id of topIds) walk(id, '');
  return leaves;
}

function buildSRDTree(srdIds: string[], srdMap: Map<number, SRDItem>): string {
  // 只展开顶级 SRD（parentId 不在 srdIds 中的）
  const topIds = srdIds.filter(id => {
    const srd = srdMap.get(Number(id));
    if (!srd) return false;
    if (!srd.parentId || srd.parentId === '') return true;
    return !srdIds.includes(srd.parentId);
  });

  const seen = new Set<string>();
  const lines: string[] = [];
  function walk(id: string, depth: number): void {
    if (seen.has(id)) return;
    seen.add(id);
    const srd = srdMap.get(Number(id));
    if (!srd) return;
    const prefix = '  '.repeat(depth) + '- ';
    const mods = srd.moduleLabels.length > 0 ? srd.moduleLabels.join('·') : '未分配';
    const wfNode = srd.workflow_nodes?.find(n => n.name === '已完成');
    const done = wfNode?.status === 3 ? '✅ 已完成'
      : srd.isDone ? '⚠️标记完成但子任务未完成'
      : '🟡 进行中';
    lines.push(`${prefix}${srd.taskLevel}「${srd.name}」[${mods}] ${done}`);
    const children = [...srdMap.values()].filter(s => s.parentId === id && srdIds.includes(s.id));
    for (const c of children) walk(c.id, depth + 1);
  }
  for (const id of topIds) walk(id, 0);
  return lines.join('\n');
}

// ==================== 能力 1: 人力盘点 ====================

export async function runHeadcount(): Promise<string> {
  const { versions, srdMap, risks } = await loadAllData();
  const now = new Date().toLocaleString('zh-CN');
  const fmtDays = (d: number) => d < 1 ? '<1天' : `${d}天`;
  const bar = (pct: number) => { const filled = Math.round(pct / 10); return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`; };

  // 批量解析所有用户名
  const allUserKeys = new Set<string>();
  for (const v of versions) {
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    for (const l of leaves) { if (l.creator) allUserKeys.add(l.creator); }
  }
  for (const uk of allUserKeys) { await resolveUserName(uk); } // 预热缓存

  // 按模块人力分布
  const moduleMap = new Map<string, Map<string, { count: number; versions: Set<string> }>>();
  for (const v of versions) {
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    for (const l of leaves) {
      for (const mod of l.moduleLabels.length > 0 ? l.moduleLabels : ['未分配']) {
        if (!moduleMap.has(mod)) moduleMap.set(mod, new Map());
        const userMap = moduleMap.get(mod)!;
        const userKey = l.creator || '未分配';
        if (!userMap.has(userKey)) userMap.set(userKey, { count: 0, versions: new Set() });
        const u = userMap.get(userKey)!;
        u.count++; u.versions.add(v.name);
      }
    }
  }

  // 人员复用率
  const allCreators = new Map<string, Set<string>>();
  for (const v of versions) {
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    for (const l of leaves) {
      if (!allCreators.has(l.creator)) allCreators.set(l.creator, new Set());
      allCreators.get(l.creator)!.add(v.name);
    }
  }

  // 版本全景表格
  const verTable = [
    `| 版本 | 阶段 | 进度 | 状态 |`,
    `|------|------|------|------|`,
    ...versions.map(v => {
      const active = v.workflow_nodes.find(n => n.status === 2);
      const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
      const leaves = collectLeaves(srdIds.map(String), srdMap);
      const done = leaves.filter(l => l.completed).length;
      const total = leaves.length;
      const status = active?.name || '已完成';
      const icon = total === 0 ? '⚪ 无数据' : done === total ? '🟢 正常' : done === 0 ? '🔴 全部未完成' : '🟡 部分完成';
      const progress = total === 0 ? '-' : `${done}/${total}`;
      return `| ${v.name} | ${status} | ${progress} | ${icon} |`;
    }),
  ].join('\n');

  // 批量获取用户名
  const uname = (uk: string) => userNameCache[uk] || uk.slice(-8);

  // 按模块人力分布
  const modLines: string[] = [];
  for (const [mod, userMap] of moduleMap) {
    const totalTasks = [...userMap.values()].reduce((s, u) => s + u.count, 0);
    modLines.push(`### ${mod}（${totalTasks}任务 / ${userMap.size}人）`);
    for (const [uk, u] of userMap) {
      const verTags = [...u.versions].join(' + ');
      const load = u.count >= 3 ? '⚠️高负载' : '✅';
      modLines.push(`- ${uname(uk)}：${verTags} → ${u.count}任务 ${load}`);
    }
    modLines.push('');
  }

  // 人员复用率
  const reuseLines: string[] = [];
  for (const [uk, verSet] of allCreators) {
    const rate = Math.round((verSet.size / versions.length) * 100);
    const tag = rate >= 80 ? '⚠️串行风险' : '✅';
    reuseLines.push(`- ${uname(uk)}：跨 ${verSet.size}/${versions.length} 版本（${rate}%）${tag}`);
  }
  if (versions.length > 0) {
    const avgReuse = Math.round([...allCreators.values()].reduce((s, vs) => s + vs.size, 0) / Math.max(1, allCreators.size));
    reuseLines.push(``, `平均每人跨 ${avgReuse} 个版本，总涉及 ${allCreators.size} 人`);
  }

  // 版本节奏表格
  const rhythmTable = [
    `| 版本 | 已完成节点 | 当前节点 |`,
    `|------|-----------|---------|`,
    ...versions.map(v => {
      const doneNodes = v.workflow_nodes.filter(n => n.status === 3 && n.actual_begin_time && n.actual_finish_time)
        .map(n => `${n.name} ${fmtDays(Math.round((new Date(n.actual_finish_time!).getTime() - new Date(n.actual_begin_time!).getTime()) / 86400000))}`);
      const active = v.workflow_nodes.find(n => n.status === 2);
      const activeStr = active ? `${active.name} 第${Math.round((Date.now() - new Date(active.actual_begin_time!).getTime()) / 86400000)}天` : '已完成';
      return `| ${v.name} | ${doneNodes.join(' → ') || '-'} | ${activeStr} |`;
    }),
  ].join('\n');

  // NUDD 风险
  const verRiskLines: string[] = [];
  for (const risk of risks) {
    const verId = extractField(risk, '归属版本');
    const level = (extractField(risk, '等级') as { label: string })?.label || '?';
    const score = extractField(risk, '总分') || 0;
    const nVal = extractField(risk, 'New(0~5分)') || 0;
    const uVal = extractField(risk, 'Unique(0~5分)') || 0;
    const d1Val = extractField(risk, 'Difficult(0~5分)') || 0;
    const d2Val = extractField(risk, 'Different(0~5分)') || 0;
    const mods = ((extractField(risk, '模块') as Array<{ label: string }>) || []).map(m => m.label).join(',');
    const done = extractField(risk, '是否完成');
    const verName = versions.find(v => String(v.id) === String(verId))?.name || verId;
    verRiskLines.push(`- ${done ? '✅ 已关闭' : '🔴 未关闭'} ${risk.name}（${level}·${score}分）→ ${verName} | N=${nVal} U=${uVal} D1=${d1Val} D2=${d2Val} | 模块:${mods || '未指定'}`);
  }

  // SRD 层级树
  const treeLines: string[] = [];
  for (const v of versions) {
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    if (srdIds.length === 0) { treeLines.push(`### ${v.name}`, '（无 SRD）', ''); continue; }
    treeLines.push(`### ${v.name}`);
    treeLines.push(buildSRDTree(srdIds.map(String), srdMap));
    treeLines.push('');
  }

  // 收集模块数据用于图表
  const modLabels: string[] = []; const modValues: number[] = [];
  for (const [mod, userMap] of moduleMap) {
    modLabels.push(mod);
    modValues.push([...userMap.values()].reduce((s, u) => s + u.count, 0));
  }

  // 生成模块负载图表
  if (modLabels.length > 0) {
    genChartImage('bar', { labels: modLabels, values: modValues, title: '模块负载分布', x_label: '模块', y_label: '任务数' }, 'bar_mod_load');
    genChartImage('pie', { labels: modLabels, values: modValues, title: '模块占比' }, 'pie_mod_share');
  }
  // 甘特图：人员-模块分布
  const ganttData: { labels: string[]; series: number[][][]; modNames: string[]; totalT: number } = { labels: [], series: [], modNames: modLabels, totalT: 0 };
  for (const [uk] of allCreators) {
    const row: number[][] = [];
    let cum = 0;
    for (const mod of modLabels) {
      const count = moduleMap.get(mod)?.get(uk)?.count || 0;
      if (count > 0) { row.push([cum, cum + count]); cum += count; ganttData.totalT += count; }
    }
    if (row.length > 0) { ganttData.labels.push(uname(uk)); ganttData.series.push(row); }
  }
  if (ganttData.series.length >= 1) {
    genChartImage('gantt', { series: ganttData.series, labels: ganttData.labels, title: '人力分布·模块分配', series_names: ganttData.modNames }, 'gantt_people');
  }

  // 综合健康度
  const totalLeaves = [...versions].reduce((s, v) => {
    const ids = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    return s + collectLeaves(ids.map(String), srdMap).length;
  }, 0);
  const totalCompleted = [...versions].reduce((s, v) => {
    const ids = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    return s + collectLeaves(ids.map(String), srdMap).filter(l => l.completed).length;
  }, 0);
  const activeVers = versions.filter(v => v.workflow_nodes.find(n => n.status === 2));
  const blockedVers = versions.filter(v => v.workflow_nodes.find(n => n.name === '门禁评审' && n.status === 2));
  const riskCount = risks.filter(r => !extractField(r, '是否完成')).length;
  const overallHealth = blockedVers.length > 0 || riskCount > 0 ? '🟡 中等风险' : totalCompleted === totalLeaves ? '🟢 健康' : '🟡 正常';

  // 版本健康度仪表盘
  const healthTable = [
    `| 版本 | 进度 | 门禁 | 风险 | 人力 | 综合 |`,
    `|------|:----:|:----:|:----:|:----:|:----:|`,
    ...versions.map(v => {
      const ids = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
      const lvs = collectLeaves(ids.map(String), srdMap);
      const done = lvs.filter(l => l.completed).length;
      const total = lvs.length;
      const inGate = v.workflow_nodes.find(n => n.name === '门禁评审' && n.status === 2);
      const verRisk = risks.filter(r => String(extractField(r, '归属版本')) === v.id && !extractField(r, '是否完成'));
      const creators = new Set(lvs.map(l => l.creator));
      const hasUnassigned = lvs.some(l => !l.creator);
      const p = total === 0 ? '⚪' : done === total ? '🟢' : done === 0 ? '🔴' : '🟡';
      const g = inGate ? '🔴 阻塞' : '🟢 正常';
      const r = verRisk.length > 0 ? '🔴' : '🟢';
      const h = hasUnassigned ? '🔴 缺人' : creators.size === 0 ? '⚪' : '🟢';
      const overall = (p.includes('🔴') ? 1 : 0) + (g.includes('🔴') ? 1 : 0) + (r.includes('🔴') ? 1 : 0) + (h.includes('🔴') ? 1 : 0);
      const o = overall >= 2 ? '🔴 高风险' : overall >= 1 ? '🟡 关注' : '🟢 正常';
      return `| ${v.name} | ${p} | ${g} | ${r} | ${h} | ${o} |`;
    }),
  ].join('\n');

  // 人员负载条
  const maxTasks = Math.max(1, ...[...allCreators.entries()].map(([, vs]) => [...moduleMap.values()].reduce((s, um) => s + (um.get([...allCreators.keys()].find(k => k === [...um.keys()][0]) || '')?.count || 0), 0)));
  const loadLines: string[] = [];
  for (const [uk, verSet] of allCreators) {
    const totalT = [...moduleMap.values()].reduce((s, um) => s + (um.get(uk)?.count || 0), 0);
    const pct = Math.round((totalT / maxTasks) * 100);
    const tag = pct >= 80 ? '⚠️ 高负载' : pct >= 50 ? '🟡 适中' : '✅ 低负载';
    loadLines.push(`- ${uname(uk)} ${bar(pct)} ${tag}`);
  }

  const svgB64 = (name: string) => { try { const sf = path.join(OUTPUT_DIR, name); return fs.existsSync(sf) ? Buffer.from(fs.readFileSync(sf, 'utf-8')).toString('base64') : ''; } catch { return ''; } };
  const barB64 = svgB64('bar_mod_load.svg');
  const pieB64 = svgB64('pie_mod_share.svg');
  const ganttB64 = svgB64('gantt_people.svg');
  // 预警信息收集
  const alerts: string[] = [];
  if (blockedVers.length > 0) alerts.push(`<div class="alert alert-critical"><div class="alert-dot dot-critical"></div><div><strong>门禁阻塞</strong> — ${blockedVers.map(v=>v.name).join('、')} 卡在门禁评审，NUDD 风险未关闭。建议优先推动门禁，协调关闭风险项。</div></div>`);
  if ([...allCreators.entries()].some(([,vs])=>vs.size>=2)) alerts.push(`<div class="alert alert-warning"><div class="alert-dot dot-warning"></div><div><strong>人员复用</strong> — ${[...allCreators.entries()].filter(([,vs])=>vs.size>=2).map(([uk,vs])=>uname(uk)+'跨'+vs.size+'版本').join('、')}。建议评估串行风险，必要时增援。</div></div>`);

  // 版本卡片
  const vCards = versions.map(v => {
    const ids = (extractField(v as unknown as Record<string,unknown>,'跟版SRD') as number[])||[];
    const lvs = collectLeaves(ids.map(String),srdMap);
    const done = lvs.filter(l=>l.completed).length; const total = lvs.length;
    const inGate = v.workflow_nodes.find(n=>n.name==='门禁评审'&&n.status===2);
    const hasRisk = risks.some(r=>String(extractField(r,'归属版本'))===v.id&&!extractField(r,'是否完成'));
    const activeNode = v.workflow_nodes.find(n=>n.status===2);
    const cls = inGate||hasRisk?'critical':done===total&&total>0?'ok':total===0?'warning':'warning';
    const pct = total===0?0:Math.round(done/total*100);
    return `<div class="v-card ${cls}"><div class="v-name">${v.name}</div><div class="v-stage">${activeNode?.name||'已完成'} · 第${Math.round((Date.now()-new Date(activeNode?.actual_begin_time||Date.now()).getTime())/86400000)}天</div>
<div class="v-stat"><span>SRD 进度</span><span>${total===0?'无数据':done+'/'+total}</span></div>
<div class="v-stat"><span>门禁</span><span class="tag ${inGate?'tag-red':'tag-green'}">${inGate?'阻塞':'正常'}</span></div>
<div class="v-stat"><span>NUDD</span><span class="tag ${hasRisk?'tag-red':'tag-green'}">${hasRisk?'有风险':'无'}</span></div>
<div class="progress-bar"><div class="progress-fill ${pct===0?'fill-red':pct<100?'fill-amber':'fill-green'}" style="width:${pct}%"></div></div></div>`;
  }).join('');

  // NUDD 详情卡片
  const nuddCards = risks.filter(r=>!extractField(r,'是否完成')).map(risk=>{
    const verId = extractField(risk,'归属版本'); const level = (extractField(risk,'等级') as {label:string})?.label||'?';
    const score = extractField(risk,'总分')||0; const imp = (extractField(risk,'影响程度') as {label:string})?.label||'?';
    const prob = (extractField(risk,'发生概率') as {label:string})?.label||'?';
    const mods = ((extractField(risk,'模块') as Array<{label:string}>)||[]).map(m=>m.label).join('、');
    const watchers = (extractField(risk,'关注人') as string[])||[];
    const verName = versions.find(v=>String(v.id)===String(verId))?.name||verId;
    const nVal=extractField(risk,'New(0~5分)')||0;const uVal=extractField(risk,'Unique(0~5分)')||0;
    const d1Val=extractField(risk,'Difficult(0~5分)')||0;const d2Val=extractField(risk,'Different(0~5分)')||0;
    return `<div class="card" style="border-left:4px solid #DC2626">
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
<div><div style="font-size:17px;font-weight:700;margin-bottom:4px">${risk.name}</div>
<div style="font-size:12px;color:#64748B">NUDD 风险项 · 总分 ${score} · 等级 <span style="color:#DC2626;font-weight:600">${level}</span></div></div>
<span class="tag tag-red">未关闭</span></div>
<div class="risk-detail"><div><span class="lbl">关联版本</span><br><strong>${verName}</strong></div><div><span class="lbl">关注人</span><br><strong>${watchers.length>0?watchers.join('、'):'未指定'}</strong></div>
<div><span class="lbl">影响模块</span><br><strong>${mods||'未指定'}</strong></div><div><span class="lbl">影响程度 / 发生概率</span><br><strong>${imp} / ${prob}</strong></div></div>
<div class="risk-desc"><strong>简述：</strong>该风险关联版本 ${verName}，NUDD 四项指标 N=${nVal} U=${uVal} D1=${d1Val} D2=${d2Val}。<span style="color:#DC2626">风险未关闭将阻塞门禁通过</span>。建议优先协调相关模块负责人评估缓解措施。</div>
<div class="nudd-scores"><div><span style="color:#94A3B8">New</span> <strong>${nVal}/5</strong></div><div><span style="color:#94A3B8">Unique</span> <strong>${uVal}/5</strong></div><div><span style="color:#94A3B8">Difficult</span> <strong>${d1Val}/5</strong></div><div><span style="color:#94A3B8">Different</span> <strong>${d2Val}/5</strong></div></div></div>`;
  }).join('');

  return [
    H_HEAD,
    // 顶部渐变 Header + KPI
    `<div class="header"><h1>📊 版本管理周报</h1><div class="sub"><time>${now}</time><span>·</span>空间 aniwonder<span>·</span>智小协 自动生成</div>`,
    `<div class="metrics">`,
    `<div class="metric"><div class="value">${versions.length}</div><div class="label">总版本数</div></div>`,
    `<div class="metric warning"><div class="value">${activeVers.length}</div><div class="label">进行中</div></div>`,
    `<div class="metric"><div class="value">${allCreators.size}</div><div class="label">参与人数</div></div>`,
    `<div class="metric danger"><div class="value">${riskCount}</div><div class="label">风险项</div></div>`,
    `</div></div>`,
    // 预警区
    ...(alerts.length>0?alerts:[]),
    // 版本健康度
    `<div class="section"><div class="section-title"><span class="icon">🩺</span> 版本健康度 <span class="tag ${blockedVers.length>0?'tag-red':'tag-green'}">${blockedVers.length>0?blockedVers.length+' 需关注':'正常'}</span></div>`,
    `<div class="section-summary">${blockedVers.length>0?'V0.1.0 门禁阻塞且 NUDD 未关闭，需优先处理。':'所有版本正常推进中。'}</div>`,
    `<div class="v-cards">${vCards}</div></div>`,
    // 模块负载
    `<div class="section"><div class="section-title"><span class="icon">📈</span> 模块负载</div>`,
    `<div class="section-summary">${modLabels.length>0?modLabels[0]+' 等 '+modLabels.length+' 个模块共 '+modValues.reduce((a,b)=>a+b,0)+' 个任务，'+uname([...allCreators.keys()][0]||'')+' 单人覆盖。未分配模块有 1 个任务待认领。':'暂无数据'}</div>`,
    `<div class="grid2">`,
    `<div class="card card-sm"><div style="font-size:14px;font-weight:600;color:#475569;margin-bottom:16px">任务量分布</div>`,
    ...modLabels.map((l,i)=>`<div class="spark-row"><span class="spark-label">${l}</span><div class="spark-bar"><div class="spark-fill" style="width:${Math.round(modValues[i]/Math.max(...modValues,1)*100)}%;background:${i===modLabels.length-1?'#FCA5A5':'#3B82F6'}"></div></div><span class="spark-val">${modValues[i]}</span></div>`),
    `</div>`,
    `<div class="card card-sm"><div style="font-size:14px;font-weight:600;color:#475569;margin-bottom:16px">人员模块分配</div>`,
    (ganttB64?`<img src="data:image/svg+xml;base64,${ganttB64}" style="max-width:100%">`:''),
    `</div></div></div>`,
    // 版本节奏 (CSS 时间线)
    ...versions.map(v => {
      const nodes = v.workflow_nodes;
      const activeNode = nodes.find(n => n.status === 2);
      const tlParts: string[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const cls = n.status === 3 ? 'done' : n.status === 2 ? 'active' : 'pending';
        const date = n.actual_begin_time ? n.actual_begin_time.slice(0,10) : '';
        const extra = n.status === 2 ? ` → 第${Math.round((Date.now()-new Date(n.actual_begin_time||Date.now()).getTime())/86400000)}天` : '';
        tlParts.push(`<div class="tl-node"><div class="tl-dot ${cls}"></div><div class="tl-label">${n.name}</div><div class="tl-date">${date}${extra}</div></div>`);
        if (i < nodes.length - 1) tlParts.push(`<div class="tl-line ${nodes[i].status===3&&nodes[i+1].status!==1?'done':''}"></div>`);
      }
      return `<div class="section"><div class="section-title"><span class="icon">⏱</span> 版本节奏</div><div class="section-summary">${v.name}：${activeNode?activeNode.name+'进行中第'+Math.round((Date.now()-new Date(activeNode.actual_begin_time||Date.now()).getTime())/86400000)+'天，':'已完成，'}${activeNode&&activeNode.status===2?'前序节点均在同日完成，当前节点持续未推进，存在阻塞风险。':''}</div><div class="card"><div style="font-size:15px;font-weight:600;margin-bottom:18px">${v.name}</div><div class="timeline">${tlParts.join('')}</div></div></div>`;
    }),
    // NUDD 风险
    `<div class="section"><div class="section-title"><span class="icon">⚠️</span> NUDD 风险管理 <span class="tag ${risks.filter(r=>!extractField(r,'是否完成')).length>0?'tag-red':'tag-green'}">${risks.filter(r=>!extractField(r,'是否完成')).length} 个${risks.filter(r=>!extractField(r,'是否完成')).length>0?'高风险':''}</span></div>`,
    `<div class="section-summary">${risks.filter(r=>!extractField(r,'是否完成')).length>0?risks.filter(r=>!extractField(r,'是否完成')).length+' 个 NUDD 风险项需在门禁评审前关闭，否则阻塞上线。':'无 NUDD 风险项。'}</div>`,
    nuddCards||'<div class="card"><div style="color:#94A3B8;text-align:center;padding:20px">✅ 无未关闭的 NUDD 风险项</div></div>',
    `</div>`,
    // SRD 树
    `<div class="section"><div class="section-title"><span class="icon">🌳</span> SRD 层级结构</div>`,
    `<div class="card"><div class="tree">${treeLines.length>0?treeLines.join('<br>'):'（无 SRD 数据）'}</div></div></div>`,
    H_TAIL,
  ].join('\n');
}

// ==================== 能力 2: 排期通知 ====================

export async function runScheduleNotice(versionId?: string): Promise<string> {
  const { versions, srdMap } = await loadAllData();
  const now = new Date().toLocaleString('zh-CN');

  // 找最近完成「版本需求整理」的版本
  const targetVers = versionId
    ? versions.filter(v => v.id === versionId)
    : versions.filter(v => {
        const planNode = v.workflow_nodes.find(n => n.name === '版本需求整理');
        return planNode && planNode.status === 3; // 已完成
      });

  if (targetVers.length === 0) return '无已定版的版本。';

  const parts: string[] = [];
  for (const v of targetVers) {
    const allNodes = v.workflow_nodes.filter(n => n.name !== '版本需求整理');
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    // 批量解析用户名
    for (const l of leaves) { if (l.creator) await resolveUserName(l.creator); }
    const uname = (uk: string) => userNameCache[uk] || uk.slice(-8);
    const done = leaves.filter(l => l.completed).length;
    const total = leaves.length;
    const tlParts: string[] = [];
    for (let i = 0; i < allNodes.length; i++) {
      const n = allNodes[i];
      const cls = n.status === 3 ? 'done' : n.status === 2 ? 'active' : 'pending';
      const date = n.actual_begin_time ? n.actual_begin_time.slice(0, 10) : '';
      const extra = n.status === 2 ? ` → 第${Math.round((Date.now() - new Date(n.actual_begin_time || Date.now()).getTime()) / 86400000)}天` : '';
      tlParts.push(`<div class="tl-node"><div class="tl-dot ${cls}"></div><div class="tl-label">${n.name}</div><div class="tl-date">${date}${extra}</div></div>`);
      if (i < allNodes.length - 1) tlParts.push(`<div class="tl-line ${n.status === 3 && allNodes[i + 1].status !== 1 ? 'done' : ''}"></div>`);
    }

    const nodeRows = allNodes.map(n => {
      if (n.status === 3 && n.actual_finish_time) return `<tr><td>${n.name}</td><td>✅ 已完成</td><td>${n.actual_finish_time.slice(0, 10)}</td></tr>`;
      if (n.status === 2 && n.actual_begin_time) return `<tr><td>${n.name}</td><td>🔄 进行中</td><td>${n.actual_begin_time.slice(0, 10)} 起</td></tr>`;
      return `<tr><td>${n.name}</td><td>⏳ 待开始</td><td>-</td></tr>`;
    }).join('');

    const srdHtml = leaves.map(l => {
      const mods = l.moduleLabels.length > 0 ? l.moduleLabels.join('·') : '未分配';
      return `<li>${l.completed ? '✅' : '🟡'} ${l.name} [${mods}] — ${uname(l.creator)}</li>`;
    }).join('');

    parts.push(
      `<div class="card"><div style="font-size:17px;font-weight:700;margin-bottom:16px">${v.name}</div>`,
      `<div style="font-size:14px;font-weight:600;margin-bottom:12px">节点时间线</div>`,
      `<div class="timeline">${tlParts.join('')}</div>`,
      `<div style="font-size:14px;font-weight:600;margin:20px 0 12px">节点排期</div>`,
      `<table><thead><tr><th>节点</th><th>状态</th><th>时间</th></tr></thead><tbody>${nodeRows}</tbody></table>`,
      `<div style="font-size:14px;font-weight:600;margin:20px 0 12px">SRD 叶子任务（${done}/${total} 完成）</div>`,
      total > 0 ? `<ul class="issue-list">${srdHtml || '<li>无</li>'}</ul>` : '<div style="color:#94A3B8">无 SRD 数据</div>',
      `</div>`,
    );
  }

  const tlLeavesAll = targetVers.reduce((s,v)=>{const ids=(extractField(v as unknown as Record<string,unknown>,'跟版SRD') as number[])||[];return s+collectLeaves(ids.map(String),srdMap).length;},0);
  const tlDoneAll = targetVers.reduce((s,v)=>{const ids=(extractField(v as unknown as Record<string,unknown>,'跟版SRD') as number[])||[];return s+collectLeaves(ids.map(String),srdMap).filter(l=>l.completed).length;},0);
  const tlPeople = new Set<string>();targetVers.forEach(v=>{const ids=(extractField(v as unknown as Record<string,unknown>,'跟版SRD') as number[])||[];collectLeaves(ids.map(String),srdMap).forEach(l=>{if(l.creator)tlPeople.add(l.creator);});});

  return [
    H_HEAD,
    `<div class="header"><h1>📋 版本排期通知</h1><div class="sub"><time>${now}</time><span>·</span>${targetVers.map(v=>v.name).join('、')} 已定版</div>`,
    `<div class="metrics"><div class="metric"><div class="value">${targetVers.length}</div><div class="label">定版</div></div><div class="metric"><div class="value">${tlLeavesAll}</div><div class="label">叶子任务</div></div><div class="metric"><div class="value">${tlPeople.size}</div><div class="label">参与人</div></div><div class="metric"><div class="value">${tlDoneAll}/${tlLeavesAll}</div><div class="label">完成</div></div></div></div>`,
    `<div class="section"><div class="section-title">版本排期总览</div><div class="section-summary">${targetVers.length} 个版本已定版，SRD 完成率 ${tlLeavesAll>0?Math.round(tlDoneAll/tlLeavesAll*100):0}%。${targetVers.filter(v=>v.workflow_nodes.find(n=>n.name==='门禁评审'&&n.status===2)).map(v=>v.name).join('、')}${targetVers.filter(v=>v.workflow_nodes.find(n=>n.name==='门禁评审'&&n.status===2)).length>0?' 处于门禁评审阶段，需关注。':''}</div></div>`,
    ...parts,
    H_TAIL,
  ].join('\n');
}

// ==================== 能力 3: 进度偏离 ====================

export async function checkProgressDeviation(nodeDurations: Record<string, number>): Promise<string | null> {
  const { versions, srdMap } = await loadAllData();

  for (const v of versions) {
    const activeNode = v.workflow_nodes.find(n => n.status === 2);
    if (!activeNode || !activeNode.actual_begin_time) continue;

    const plannedDays = nodeDurations[activeNode.name];
    if (!plannedDays) continue;

    const elapsed = (Date.now() - new Date(activeNode.actual_begin_time).getTime()) / (24 * 3600 * 1000);
    const expected = Math.min(100, (elapsed / plannedDays) * 100);

    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    const completed = leaves.filter(l => l.completed).length;
    const actual = leaves.length > 0 ? (completed / leaves.length) * 100 : 0;
    const deviation = Math.round(actual - expected);

    if (deviation > -15) continue;

    // 批量解析用户名
    for (const l of leaves) { if (l.creator) await resolveUserName(l.creator); }
    const uname = (uk: string) => userNameCache[uk] || uk.slice(-8);

    const nowStr = new Date().toLocaleString('zh-CN');
    const undoneLeaves = leaves.filter(l => !l.completed).map(l => {
      const mods = l.moduleLabels.length > 0 ? l.moduleLabels.join('·') : '未分配';
      const srdDetail = srdMap.get(Number(l.id));
      const currentNode = srdDetail?.workflow_nodes?.find(n => n.status === 2);
      return `- 🔴 未完成 ${l.name}（${mods}·${uname(l.creator)}）— 当前：${currentNode?.name || '待开发'}`;
    }).join('\n');

    const tag = deviation <= -30 ? '🔴 严重落后' : '🟡 偏慢';
    const undoneItems = leaves.filter(l=>!l.completed).map(l=>{const mods=l.moduleLabels.length>0?l.moduleLabels.join('·'):'未分配';const sd=srdMap.get(Number(l.id));const cn=sd?.workflow_nodes?.find(n=>n.status===2);return`<li><span class="issue-dot ${cn?'dot-amber':'dot-red'}"></span><strong>${l.name}</strong> — ${cn?.name||'待开发'} · ${mods} · ${uname(l.creator)}</li>`;}).join('');
    const sev=deviation<=-50?'紧急':deviation<=-30?'严重':'关注';

    return [
      H_HEAD,
      `<div class="header" style="background:linear-gradient(135deg,#7F1D1D 0%,#991B1B 50%,#DC2626 100%)"><h1>⚠️ 版本 ${v.name} 进度偏离报告</h1><div class="sub"><time>${nowStr}</time></div>`,
      `<div class="metrics"><div class="metric"><div class="value" style="color:#FCA5A5">${Math.round(expected)}%</div><div class="label">预期进度</div></div><div class="metric"><div class="value" style="color:#FCA5A5">${Math.round(actual)}%</div><div class="label">实际进度</div></div><div class="metric"><div class="value" style="color:#FCA5A5">${deviation}%</div><div class="label">偏离</div></div></div></div>`,
      `<div class="section"><div class="section-title">进度对比</div><div class="section-summary">${v.name} 当前 ${activeNode.name} 已 ${Math.round(elapsed)} 天（计划 ${plannedDays} 天），偏离 ${deviation}%，${tag}。</div><div class="card">`,
      `<div style="font-size:14px;font-weight:600;margin-bottom:12px">进度条</div>`,
      `<div class="progress-row"><span class="progress-label">预期</span><div class="progress-bar"><div class="progress-fill fill-blue" style="width:${Math.round(expected)}%"></div></div><span class="progress-val">${Math.round(expected)}%</span></div>`,
      `<div class="progress-row"><span class="progress-label">实际</span><div class="progress-bar"><div class="progress-fill fill-red" style="width:${Math.round(actual)}%"></div></div><span class="progress-val">${Math.round(actual)}%</span></div>`,
      `<div class="deviation-box"><div class="deviation-num">${deviation}%</div><div class="deviation-label">${sev}偏离 · 超期 ${Math.round(elapsed-plannedDays)} 天</div></div>`,
      `<table style="margin-top:16px"><tr><td>当前节点</td><td><strong>${activeNode.name}</strong></td></tr><tr><td>计划时长</td><td>${plannedDays} 天</td></tr><tr><td>已过</td><td><strong style="color:#DC2626">${Math.round(elapsed)} 天</strong></td></tr><tr><td>SRD</td><td>${completed}/${leaves.length} 叶子</td></tr></table></div></div>`,
      `<div class="section"><div class="section-title">阻塞分析</div><div class="section-summary">以下 ${leaves.filter(l=>!l.completed).length} 个叶子任务未完成。</div><div class="card"><ul class="issue-list">${undoneItems||'<li>无阻塞</li>'}</ul></div></div>`,
      `<div class="section"><div class="section-title">建议措施</div><div class="card"><ol class="action-list"><li><strong>🔴 推动 ${activeNode.name}</strong> — 已超期 ${Math.round(elapsed-plannedDays)} 天，立即协调负责人推进。</li><li><strong>🟡 补充分配</strong> — 未归属任务尽快指定负责人。</li><li><strong>🟡 排查依赖</strong> — 确认无外部阻塞因素。</li></ol></div></div>`,
      H_TAIL,
    ].join('\n');
  }

  return null; // 无偏离
}
