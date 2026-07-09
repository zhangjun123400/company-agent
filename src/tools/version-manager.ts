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

const CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F8FAFC;padding:32px 20px;color:#1E293B;line-height:1.7}
.container{max-width:1040px;margin:0 auto}
.m-header{background:#FFF;border-radius:16px;padding:32px 36px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,.04);border:1px solid #E2E8F0}
.m-header h1{font-size:26px;font-weight:700;color:#0F172A;letter-spacing:-0.5px;margin-bottom:4px}
.m-header .subtitle{font-size:14px;color:#94A3B8;margin-bottom:24px}
.kpi-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.kpi{flex:1;min-width:150px;background:#F8FAFC;border-radius:14px;padding:20px 24px;text-align:center;border:1px solid #E2E8F0}
.kpi .metric{font-size:42px;font-weight:700;color:#1D4ED8;letter-spacing:-1px;font-variant-numeric:tabular-nums;line-height:1.1}
.kpi .metric.red{color:#DC2626}.kpi .metric.green{color:#059669}.kpi .metric.amber{color:#D97706}
.kpi .label{font-size:12px;color:#64748B;margin-top:6px;text-transform:uppercase;letter-spacing:.5px;font-weight:500}
.alerts{margin-bottom:0}
.alert{padding:14px 20px;border-radius:10px;margin-bottom:10px;font-size:14px;line-height:1.5}
.alert-red{background:#FEF2F2;border-left:4px solid #DC2626}.alert-red .title{color:#991B1B;font-weight:600}
.alert-amber{background:#FFFBEB;border-left:4px solid #D97706}.alert-amber .title{color:#92400E;font-weight:600}
.alert p{margin:4px 0 0;color:#475569;font-size:13px}
.section{margin-bottom:28px}
.section h2{font-size:18px;font-weight:600;color:#1E293B;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #E2E8F0;letter-spacing:-0.3px}
.card{background:#FFF;border-radius:14px;padding:28px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.04);border:1px solid #E2E8F0}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th{background:#F8FAFC;color:#475569;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:10px 14px;text-align:left;border-bottom:2px solid #E2E8F0}
td{padding:10px 14px;border-bottom:1px solid #F1F5F9;color:#334155}
tr:hover td{background:#FAFBFC}
.bar-wrap{display:flex;align-items:center;gap:10px;margin:4px 0}
.bar-name{font-size:13px;min-width:70px;color:#475569}
.bar-bg{flex:1;background:#E2E8F0;border-radius:6px;height:10px;overflow:hidden}
.bar-fg{height:10px;border-radius:6px}
.chart-box{text-align:center;margin:20px 0;padding:16px}
.chart-box img{max-width:100%;height:auto}
.chart-box h3{font-size:15px;font-weight:600;color:#334155;margin-bottom:12px}
.insight{font-size:13px;color:#64748B;margin-top:8px;line-height:1.6}
.insight span{font-weight:600;color:#1E293B}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot-red{background:#DC2626}.dot-amber{background:#D97706}.dot-green{background:#059669}.dot-gray{background:#CBD5E1}
.tag{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600}
.tag-red{background:#FEE2E2;color:#991B1B}.tag-amber{background:#FEF3C7;color:#92400E}.tag-green{background:#DCFCE7;color:#065F46}.tag-gray{background:#F1F5F9;color:#475569}
.rh{color:#DC2626}.ah{color:#D97706}.gh{color:#059669}.gy{color:#94A3B8}`;

const H_HEAD = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CSS}</style></head><body><div class="container">`;
const H_TAIL = `</div></body></html>`;

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
  return [
    H_HEAD,
    // === 顶部卡片 ===
    `<div class="m-header">`,
    `<h1>📊 版本管理周报</h1><div class="subtitle">${now} · 自动生成</div>`,
    `<div class="kpi-row">`,
    `<div class="kpi"><div class="metric">${versions.length}</div><div class="label">总版本</div></div>`,
    `<div class="kpi"><div class="metric ${activeVers.length>0?'amber':''}">${activeVers.length}</div><div class="label">进行中</div></div>`,
    `<div class="kpi"><div class="metric">${allCreators.size}</div><div class="label">参与人数</div></div>`,
    `<div class="kpi"><div class="metric ${riskCount>0?'red':''}">${riskCount}</div><div class="label">风险项</div></div>`,
    `</div>`,
    // 异常预警
    ...(blockedVers.length>0 ? [`<div class="alerts"><div class="alert alert-red"><span class="title">🔴 门禁阻塞</span><p>${blockedVers.map(v=>v.name).join('、')} 卡在门禁评审，NUDD 风险未关闭。建议优先推动门禁，协调关闭风险项。</p></div></div>`] : []),
    ...(allCreators.size>0 && [...allCreators.entries()].some(([,vs])=>vs.size>=2) ? [`<div class="alerts"><div class="alert alert-amber"><span class="title">🟡 人员复用</span><p>${[...allCreators.entries()].filter(([,vs])=>vs.size>=2).map(([uk,vs])=>uname(uk)+'跨'+vs.size+'版本').join('、')}。建议评估串行风险。</p></div></div>`] : []),
    `</div>`,
    // === 图表: 模块负载 ===
    `<div class="section"><h2>📈 模块负载：${modLabels.length>0?modLabels.reduce((a,b,i)=>modValues[i]>modValues[modValues.indexOf(Math.max(...modValues))]?a:b,modLabels[0]):''} 任务最密集</h2>`,
    `<div class="card">`,
    (barB64 ? `<div class="chart-box"><img src="data:image/svg+xml;base64,${barB64}" style="max-width:100%"></div>` : ''),
    `<div class="insight">▸ 共 <span>${modLabels.length}</span> 个模块，<span>${modValues.reduce((a,b)=>a+b,0)}</span> 个任务<br>▸ ${modLabels.filter((_,i)=>modValues[i]===0).length>0?'<span class="rh">'+modLabels.filter((_,i)=>modValues[i]===0).length+' 个模块无任务</span>':'所有模块均已分配'}</div>`,
    `</div></div>`,
    // === 版本健康度 ===
    `<div class="section"><h2>🩺 版本健康度：${blockedVers.length>0?blockedVers.length+' 个版本需关注':riskCount>0?'有风险项待处理':'整体正常'}</h2>`,
    `<div class="card">${healthTable}</div></div>`,
    // === 版本全景 ===
    `<div class="section"><h2>📋 版本全景</h2>`,
    `<div class="card">${verTable}</div></div>`,
    // === 人员负载 ===
    `<div class="section"><h2>👥 人员负载</h2>`,
    `<div class="card">`,
    ...(loadLines.length > 0 ? loadLines : ['（暂无数据）']),
    ``,
    `## 三、人力分布（按模块）`,
    ...(modLines.length > 0 ? modLines : ['（暂无数据）']),
    `## 四、人员复用率`,
    ...(reuseLines.length > 0 ? reuseLines : ['（暂无数据）']),
    ``,
    `## 五、版本节奏`,
    rhythmTable,
    ``,
    `## 六、门禁评审`,
    `- 历史通过率：暂无数据`,
    `- 当前进行中：${blockedVers.map(v=>v.name).join(', ') || '无'}`,
    ``,
    `## 七、NUDD 风险管理`,
    ...(verRiskLines.length > 0 ? verRiskLines : ['- 关联风险：0 个']),
    ``,
    `## 八、SRD 层级树`,
    ...(treeLines.length > 0 ? treeLines : ['（无 SRD 数据）']),
    ``,
    `## 九、综合风险`,
    ...(reuseLines.filter(l => l.includes('⚠️')).length > 0 ? reuseLines.filter(l => l.includes('⚠️')) : ['- 暂无明显风险']),
    H_TAIL,
  ].join('\n')
    .replace(/^## (.+)$/gm, '</div><div class="card"><h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    // 清理多余的开头 card 结束标签
    .replace('</div><div class="card">', '<div class="card">'); // 第一个不需要</div>
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
    const nodeTable = [
      `| 节点 | 状态 | 时间 |`,
      `|------|------|------|`,
      ...allNodes.map(n => {
        if (n.status === 3 && n.actual_finish_time) return `| ${n.name} | ✅ 已完成 | ${n.actual_finish_time.slice(0, 10)} |`;
        if (n.status === 2 && n.actual_begin_time) return `| ${n.name} | 🔄 进行中 | ${n.actual_begin_time.slice(0, 10)} 起 |`;
        return `| ${n.name} | ⏳ 待开始 | - |`;
      }),
    ].join('\n');

    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    // 批量解析用户名
    for (const l of leaves) { if (l.creator) await resolveUserName(l.creator); }
    const uname = (uk: string) => userNameCache[uk] || uk.slice(-8);
    const done = leaves.filter(l => l.completed).length;
    const total = leaves.length;
    const srdLines = leaves.map(l => {
      const mods = l.moduleLabels.length > 0 ? l.moduleLabels.join('·') : '未分配';
      return `- ${l.completed ? '✅' : '🟡'} ${l.name} [${mods}] — ${uname(l.creator)}`;
    }).join('\n');

    // 时间线可视化
    const nodeNames = allNodes.map(n => n.name);
    const maxNameLen = Math.max(...nodeNames.map(n => n.length), 4);
    const timelineWidth = 50;
    const totalNodes = allNodes.length;
    const doneNodes = allNodes.filter(n => n.status === 3).length;
    const timeline = allNodes.map((n, i) => {
      const marker = n.status === 3 ? '█' : n.status === 2 ? '▓' : '░';
      const seg = marker.repeat(Math.floor(timelineWidth / totalNodes));
      return seg;
    }).join('');
    const markers = allNodes.map((n, i) => {
      const pos = Math.floor(timelineWidth / totalNodes) * i;
      const icon = n.status === 3 ? '✅' : n.status === 2 ? '🔽' : '○';
      return ' '.repeat(Math.max(0, pos - i * 3)) + icon + n.name.slice(0, 2);
    }).filter(m => m.trim()).join('');

    parts.push(
      `## ${v.name} 已定版`,
      ``,
      `### 版本时间线`,
      `\`\`\``,
      `${timeline}`,
      `\`\`\``,
      `▲ 当前节点：${allNodes.find(n => n.status === 2)?.name || '已完成'}`,
      ``,
      `### 节点排期`,
      `| 节点 | 状态 | 时间 |`,
      `|------|------|------|`,
      ...allNodes.map(n => {
        if (n.status === 3 && n.actual_finish_time) return `| ${n.name} | ✅ 已完成 | ${n.actual_finish_time.slice(0, 10)} |`;
        if (n.status === 2 && n.actual_begin_time) return `| ${n.name} | 🔄 进行中 | ${n.actual_begin_time.slice(0, 10)} 起 |`;
        return `| ${n.name} | ⏳ 待开始 | - |`;
      }),
      ``,
      `### 进度统计`,
      `- 已完成：${doneNodes}/${totalNodes} 节点`,
      `- 完成率：${Math.round(doneNodes/totalNodes*100)}% ${'█'.repeat(Math.round(doneNodes/totalNodes*10))}${'░'.repeat(10-Math.round(doneNodes/totalNodes*10))}`,
      ``,
      `### SRD 叶子任务（${done}/${total} 完成）`,
      ...(srdLines ? srdLines.split('\n') : ['（无）']),
      ``,
    );
  }

  return [
    H_HEAD,
    `<h1>📋 版本排期通知</h1><p style="color:#9ca3af;margin-bottom:20px">生成时间：${now}</p>`,
    ``,
    ...parts,
    H_TAIL,
  ].join('\n')
    .replace(/^## (.+)$/gm, '</div><div class="card"><h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace('</div><div class="card">', '<div class="card">');
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

    // 进度条可视化
    const expBar = Math.round(expected / 10);
    const actBar = Math.round(actual / 10);
    const progressBar = `预期 █${'█'.repeat(Math.max(0, expBar-1))}${'░'.repeat(10-expBar)} ${Math.round(expected)}%\n实际 █${'█'.repeat(Math.max(0, actBar-1))}${'░'.repeat(10-actBar)} ${Math.round(actual)}%`;

    // 风险矩阵
    const riskMatrix = [
      `| 影响 \\ 概率 | 低 | 中 | 高 |`,
      `|------------|----|----|-----|`,
      `| 大 | - | - | - |`,
      `| 中 | - | 进度偏离 ${Math.abs(deviation)}% | - |`,
      `| 小 | - | - | - |`,
    ].join('\n');

    return [
      H_HEAD,
      `<h1>⚠️ 版本 ${v.name} 进度偏离报告</h1><p style="color:#9ca3af;margin-bottom:20px">时间：${nowStr}</p>`,
      ``,
      `## 进度对比`,
      ``,
      `| 指标 | 值 |`,
      `|------|-----|`,
      `| 当前节点 | ${activeNode.name}（第 ${Math.round(elapsed)} 天 / 计划 ${plannedDays} 天） |`,
      `| 预期进度 | ${Math.round(expected)}% |`,
      `| 实际进度 | ${Math.round(actual)}%（${completed}/${leaves.length} 叶子任务） |`,
      `| 偏离 | ${deviation}% ${tag} |`,
      ``,
      `## 进度可视化`,
      '```',
      progressBar,
      '```',
      ``,
      `## 风险矩阵`,
      riskMatrix,
      ``,
      `## 未完成叶子任务`,
      ...(undoneLeaves ? undoneLeaves.split('\n') : ['（无）']),
      ``,
      `## 建议`,
      `1. 优先排查阻塞任务，协调模块负责人查因`,
      `2. 关注未分配模块的任务，尽快指定负责人`,
      `3. 按当前速率，预计延期 ${Math.max(1, Math.round(Math.abs(deviation) * plannedDays / 100))} 天`,
      H_TAIL,
    ].join('\n')
      .replace(/^## (.+)$/gm, '</div><div class="card"><h2>$1</h2>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace('</div><div class="card">', '<div class="card">');
  }

  return null; // 无偏离
}
