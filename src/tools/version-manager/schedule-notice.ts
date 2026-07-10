/**
 * 版本管理 — 排期通知 (能力 2)
 */
import {
  extractField, collectLeaves, resolveUserName, userNameCache,
  loadAllData,
  H_HEAD, H_TAIL,
} from './_shared';

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
