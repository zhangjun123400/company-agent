/**
 * 版本管理 — 进度偏离报告 (能力 3)
 */
import {
  extractField, collectLeaves, resolveUserName, userNameCache,
  loadAllData,
  H_HEAD, H_TAIL,
} from './_shared';

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
    const tag = deviation <= -30 ? '🔴 严重落后' : '🟡 偏慢';
    const sev = deviation <= -50 ? '紧急' : deviation <= -30 ? '严重' : '关注';

    const undoneItems = leaves.filter(l=>!l.completed).map(l=>{const mods=l.moduleLabels.length>0?l.moduleLabels.join('·'):'未分配';const sd=srdMap.get(Number(l.id));const cn=sd?.workflow_nodes?.find(n=>n.status===2);return`<li><span class="issue-dot ${cn?'dot-amber':'dot-red'}"></span><strong>${l.name}</strong> — ${cn?.name||'待开发'} · ${mods} · ${uname(l.creator)}</li>`;}).join('');

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

  return null;
}
