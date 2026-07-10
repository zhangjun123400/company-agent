/**
 * 版本管理 — 共享基础设施
 * 类型、常量、API、CSS/HTML模板、数据加载、SRD工具
 */
import axios from 'axios';
import { execSync } from 'child_process';
import { projectConfig } from '../../../src/config';
import path from 'path';
import fs from 'fs';

// ==================== 常量 ====================

export const TARGET_OPEN_ID = 'ou_8de837db0c63b31eaebbb465c18c9ea8';
export const VERSION_TK = '6a41e22f1dcaa1da30c0ca94';
export const SRD_TK = '6a43902cd74ffc7dc45d66e1';
export const RISK_TK = '62a9886338f01f6454763702';
export const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
export const OUTPUT_DIR = path.resolve(__dirname, '../../output');

// ==================== 类型 ====================

export interface VersionItem {
  id: string; name: string; creator: string;
  workflow_nodes: WfNode[];
  fields: Record<string, unknown>;
}
export interface SRDItem {
  id: string; name: string; creator: string;
  taskLevel: string; parentId: string; moduleLabels: string[];
  isDone: boolean;
  workflow_nodes: WfNode[];
}
export interface WfNode { name: string; status: number; actual_begin_time?: string; actual_finish_time?: string; }
export interface LeafTask { id: string; name: string; creator: string; moduleLabels: string[]; completed: boolean; parentChain: string; }

// ==================== Token / API ====================

let meegleToken: string | null = null;
export async function getToken(): Promise<string> {
  if (meegleToken) return meegleToken;
  const r = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1,
  });
  meegleToken = r.data.data.token as string;
  return meegleToken as string;
}
export async function apiQuery(typeKey: string, ids: number[]): Promise<Record<string, unknown>[]> {
  const H = { 'X-Plugin-Token': await getToken(), 'X-User-Key': projectConfig.userKey };
  const r = await axios.post(`https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/${typeKey}/query`,
    { work_item_ids: ids, expand: { need_workflow: true } }, { headers: H });
  return (r.data.data || []) as Record<string, unknown>[];
}
export async function apiFilter(typeKey: string, pageSize = 20): Promise<{ id: string; name: string }[]> {
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

export const userNameCache: Record<string, string> = {};

export async function resolveUserName(userKey: string): Promise<string> {
  if (!userKey || userKey === 'undefined') return '未分配';
  if (userNameCache[userKey]) return userNameCache[userKey];
  try {
    const H = { 'X-Plugin-Token': await getToken(), 'X-User-Key': projectConfig.userKey };
    const r = await axios.post('https://project.feishu.cn/open_api/user/query',
      { user_keys: [userKey] }, { headers: H });
    const u = (r.data.data || [])[0];
    const name = u?.name?.zh_cn || u?.name_cn || u?.name?.default || u?.name || '';
    if (name) { userNameCache[userKey] = name; return name; }
  } catch { /* ignore */ }
  return userKey.slice(-8);
}

// ==================== 图表生成 ====================

export async function genChartImage(type: string, data: Record<string, unknown>, name: string): Promise<string | null> {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const dataFile = path.join(OUTPUT_DIR, `${name}.json`);
    const svgFile = path.join(OUTPUT_DIR, `${name}.svg`);
    const pngFile = path.join(OUTPUT_DIR, `${name}.png`);
    fs.writeFileSync(dataFile, JSON.stringify(data), 'utf-8');
    execSync(`python "${SCRIPTS_DIR}/gen_charts.py" ${type} "${dataFile}" "${svgFile}"`, { timeout: 15000, stdio: 'pipe' });
    if (!fs.existsSync(svgFile)) return null;

    const sharp = require('sharp');
    await sharp(svgFile).png().toFile(pngFile);
    console.log(`[chart] ✅ ${name}.png`);
    return pngFile;
  } catch (e) { console.error(`[chart] ${name} 失败:`, (e as Error).message); }
  return null;
}

// ==================== HTML 模板 ====================

export const CSS = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#F1F5F9;color:#1E293B;line-height:1.6;-webkit-font-smoothing:antialiased}
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

export const H_HEAD = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>${CSS}</style></head><body><div class="page">`;
export const H_TAIL = `<div class="footer">🤖 智小协 · 版本管理智能体 · 每日 10:30 / 16:00 自动更新</div></div></body></html>`;

// ==================== 数据获取 ====================

export function extractField(item: Record<string, unknown>, name: string): unknown {
  return (item.fields as Array<{ field_name: string; field_value: unknown }>)?.find(f => f.field_name === name)?.field_value;
}
export function parseWfNodes(item: Record<string, unknown>): WfNode[] {
  const wf = (item.workflow_infos as Record<string, unknown>) || {};
  return (wf.workflow_nodes || []) as WfNode[];
}

export async function loadAllData(): Promise<{ versions: VersionItem[]; srdMap: Map<number, SRDItem>; risks: Record<string, unknown>[] }> {
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

export function collectLeaves(srdIds: string[], srdMap: Map<number, SRDItem>): LeafTask[] {
  const leaves: LeafTask[] = [];
  const seen = new Set<string>();
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

export function buildSRDTree(srdIds: string[], srdMap: Map<number, SRDItem>): string {
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
