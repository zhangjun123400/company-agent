/**
 * 版本管理技能 handler
 *
 * 能力:
 *   runHeadcount()         — 人力盘点（递归 SRD 树）
 *   runScheduleNotice()    — 排期通知
 *   checkProgressDeviation() — 进度偏离检测
 */
import axios from 'axios';
import { projectConfig } from '../../src/config';

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

function buildSRDTree(srdIds: string[], srdMap: Map<number, SRDItem>, indent = ''): string {
  const lines: string[] = [];
  for (const id of srdIds) {
    const srd = srdMap.get(Number(id));
    if (!srd) continue;
    const children = [...srdMap.values()].filter(s => s.parentId === id);
    const mods = srd.moduleLabels.length > 0 ? srd.moduleLabels.join('‖') : '未分配';
    const wfNode = srd.workflow_nodes?.find(n => n.name === '已完成');
    const done = wfNode?.status === 3 ? '✅' : srd.isDone && children.length > 0 ? '⚠️标记完成但子任务未完成' : '🟡进行中';
    lines.push(`${indent}${children.length > 0 ? '├─' : '└─'} ${srd.taskLevel}「${srd.name}」[${mods}] ${done}`);
    if (children.length > 0) {
      lines.push(buildSRDTree(children.map(c => c.id), srdMap, indent + '  '));
    }
  }
  return lines.join('\n');
}

// ==================== 能力 1: 人力盘点 ====================

export async function runHeadcount(): Promise<string> {
  const { versions, srdMap, risks } = await loadAllData();
  const now = new Date().toLocaleString('zh-CN');

  // 版本全景
  const verLines = versions.map(v => {
    const active = v.workflow_nodes.find(n => n.status === 2);
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    const done = leaves.filter(l => l.completed).length;
    const total = leaves.length;
    const status = active?.name || '已完成';
    const icon = done === total && total > 0 ? '🟢' : done === 0 ? '🔴' : '🟡';
    return ` ${v.name} | ${status} | ${icon} ${done}/${total} 叶子任务`;
  }).join('\n');

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
  const modLines: string[] = [];
  for (const [mod, userMap] of moduleMap) {
    const totalTasks = [...userMap.values()].reduce((s, u) => s + u.count, 0);
    const totalUsers = userMap.size;
    modLines.push(`  ${mod}（${totalTasks}任务 / ${totalUsers}人）`);
    for (const [uk, u] of userMap) {
      const verTags = [...u.versions].join('+');
      const load = u.count >= 3 ? '⚠️高负载' : '✅';
      modLines.push(`    ${uk.slice(-8)}：${verTags} → ${u.count}任务 ${load}`);
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
  const reuseLines: string[] = [];
  for (const [uk, verSet] of allCreators) {
    const rate = Math.round((verSet.size / versions.length) * 100);
    const tag = rate >= 80 ? '⚠️串行风险' : '✅';
    reuseLines.push(`  ${uk.slice(-8)}：跨 ${verSet.size}/${versions.length} 版本（${rate}%）${tag}`);
  }

  // 版本节奏
  const rhythmLines = versions.map(v => {
    const nodes = v.workflow_nodes.filter(n => n.status === 3 && n.actual_begin_time && n.actual_finish_time);
    const parts = nodes.map(n => {
      const days = Math.round((new Date(n.actual_finish_time!).getTime() - new Date(n.actual_begin_time!).getTime()) / 86400000);
      return `${n.name} ${days}天`;
    });
    const active = v.workflow_nodes.find(n => n.status === 2);
    if (active && active.actual_begin_time) {
      const elapsed = Math.round((Date.now() - new Date(active.actual_begin_time).getTime()) / 86400000);
      parts.push(`${active.name} 第${elapsed}天`);
    }
    return ` ${v.name}：${parts.join(' → ')}`;
  }).join('\n');

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
    verRiskLines.push(`  ${done ? '✅' : '🔴'} ${risk.name}（${level}·${score}分）→ ${verName} | N=${nVal} U=${uVal} D1=${d1Val} D2=${d2Val} | 模块:${mods || '未指定'}`);
  }

  // SRD 层级树
  const treeLines: string[] = [];
  for (const v of versions) {
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    if (srdIds.length === 0) continue;
    treeLines.push(` ${v.name}:`);
    treeLines.push(buildSRDTree(srdIds.map(String), srdMap, '  '));
  }

  // 组装报告
  const sep = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  return [
    `📊 智慧智能体 · 版本人力盘点报告`,
    `生成时间：${now}`,
    ``,
    `${sep}`,
    `一、版本全景（${versions.length} 个版本在跑）`,
    `${sep}`,
    ...verLines,
    ``,
    `${sep}`,
    `二、人力分布（按模块）`,
    `${sep}`,
    ...modLines,
    ``,
    `${sep}`,
    `三、人员复用率`,
    `${sep}`,
    ...reuseLines.length > 0 ? reuseLines : ['  （暂无人力数据）'],
    ``,
    `${sep}`,
    `四、版本节奏进化`,
    `${sep}`,
    ...rhythmLines,
    ``,
    `${sep}`,
    `五、门禁评审`,
    `${sep}`,
    ` 历史通过率：N/A（尚无完成记录）`,
    ` 当前进行中：${versions.filter(v => v.workflow_nodes.find(n => n.name === '门禁评审' && n.status === 2)).map(v=>v.name).join(', ') || '无'}`,
    ``,
    `${sep}`,
    `六、NUDD 风险管理`,
    `${sep}`,
    ...(verRiskLines.length > 0 ? verRiskLines : ['  关联风险：0 个']),
    ``,
    `${sep}`,
    `七、SRD 层级树（递归展开）`,
    `${sep}`,
    ...treeLines.length > 0 ? treeLines : ['  （无 SRD 数据）'],
    ``,
    `${sep}`,
    `八、综合风险提示`,
    `${sep}`,
    ` 🔴 自动盘点，请关注以上标记的异常项`,
    ` ⚠️ 高负载人员和未分配任务需尽快处理`,
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

  const sep = '━━━━━━━━━━━━━━━━━━━━━━';
  const parts: string[] = [];
  for (const v of targetVers) {
    const allNodes = v.workflow_nodes.filter(n => n.name !== '版本需求整理');
    const nodeLines = allNodes.map(n => {
      if (n.status === 3 && n.actual_finish_time) {
        return `✅ ${n.name}  已完成  ${n.actual_finish_time.slice(0, 10)}`;
      }
      if (n.status === 2 && n.actual_begin_time) {
        return `🔄 ${n.name}  进行中  ${n.actual_begin_time.slice(0, 10)} → 预计 待定`;
      }
      return `⏳ ${n.name}  待开始  预计 待定`;
    }).join('\n');

    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    const done = leaves.filter(l => l.completed).length;
    const total = leaves.length;
    const srdLines = leaves.map(l => {
      const mods = l.moduleLabels.length > 0 ? l.moduleLabels.join('·') : '未分配';
      return `  ${l.completed ? '✅' : '🟡'} ${l.name} [${mods}]`;
    }).join('\n');

    parts.push(
      `📋 版本 ${v.name} 已定版，进入开发阶段`,
      ``,
      `${sep}`,
      `版本排期计划`,
      `${sep}`,
      nodeLines,
      ``,
      `${sep}`,
      `SRD 任务清单（叶子任务 ${done}/${total} 完成）`,
      `${sep}`,
      srdLines,
    );
  }

  return [
    `📋 版本排期通知`,
    `生成时间：${now}`,
    ``,
    ...parts,
    ``,
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

    if (deviation > -15) continue; // 偏离未超阈值

    const nowStr = new Date().toLocaleString('zh-CN');
    const undoneLeaves = leaves.filter(l => !l.completed).map(l => {
      const mods = l.moduleLabels.length > 0 ? l.moduleLabels.join('·') : '未分配';
      const srdDetail = srdMap.get(Number(l.id));
      const currentNode = srdDetail?.workflow_nodes?.find(n => n.status === 2);
      return `🔴 ${l.name}（${mods}）— ${currentNode?.name || '待开发'}`;
    }).join('\n');

    const tag = deviation <= -30 ? '🔴 严重落后' : '🟡 偏慢';
    const sep = '━━━━━━━━━━━━━━━━━━━━━━';
    return [
      `⚠️ 版本 ${v.name} 进度偏离报告`,
      `时间：${nowStr}`,
      ``,
      `${sep}`,
      `进度对比`,
      `${sep}`,
      `当前节点：${activeNode.name}（第 ${Math.round(elapsed)} 天 / 计划 ${plannedDays} 天）`,
      `预期进度：${Math.round(expected)}%（按时间线性）`,
      `实际进度：${Math.round(actual)}%（${completed}/${leaves.length} 叶子任务）`,
      `偏离：${deviation}% ${tag}`,
      ``,
      `${sep}`,
      `未完成叶子任务`,
      `${sep}`,
      undoneLeaves || '  （无）',
      ``,
      `${sep}`,
      `建议`,
      `${sep}`,
      `1. 优先排查阻塞任务，协调模块负责人`,
      `2. 关注未分配任务，尽快指定负责人`,
      `3. 按当前速率，预计延期 ${Math.max(1, Math.round(Math.abs(deviation) * plannedDays / 100))} 天`,
    ].join('\n');
  }

  return null; // 无偏离
}
