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

  // 生成模块负载图表 PNG
  let chartPngFile: string | null = null;
  if (modLabels.length > 0) {
    chartPngFile = await genChartImage('bar', { labels: modLabels, values: modValues, title: '模块负载分布', x_label: '模块', y_label: '任务数' }, 'bar_mod_load');
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

  return [
    `# 📊 版本人力盘点报告`,
    `> 生成时间：${now}`,
    ``,
    `## 📊 执行摘要`,
    `| 指标 | 值 |`,
    `|------|-----|`,
    `| 总版本数 | ${versions.length} 个 |`,
    `| 进行中版本 | ${activeVers.length} 个（${activeVers.map(v=>v.name).join('、') || '无'}） |`,
    `| 总叶子任务 | ${totalLeaves} 个（完成 ${totalCompleted}） |`,
    `| 总涉及人数 | ${allCreators.size} 人 |`,
    `| 高风险版本 | ${blockedVers.length} 个 |`,
    `| NUDD 风险 | ${riskCount} 个未关闭 |`,
    `| 总体健康度 | ${overallHealth} |`,
    ``,
    `## 版本健康度`,
    healthTable,
    ``,
    `> 进度=叶子任务完成率 | 门禁=是否卡在门禁评审 | 风险=关联NUDD数量 | 人力=有无未分配任务`,
    ``,
    `## 一、版本全景（${versions.length} 个版本）`,
    verTable,
    ``,
    `## 二、人员负载`,
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
    `# 📋 版本排期通知`,
    `> 生成时间：${now}`,
    ``,
    ...parts,
    `---`,
    `如有疑问请联系版本 PM。`,
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
      `# ⚠️ 版本 ${v.name} 进度偏离报告`,
      `> 时间：${nowStr}`,
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
    ].join('\n');
  }

  return null; // 无偏离
}
