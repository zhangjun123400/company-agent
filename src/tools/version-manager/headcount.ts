/**
 * 版本管理 — 人力盘点 (能力 1)
 */
import path from 'path';
import fs from 'fs';
import {
  extractField, collectLeaves, buildSRDTree, resolveUserName, userNameCache,
  loadAllData, genChartImage,
  H_HEAD, H_TAIL, OUTPUT_DIR,
} from './_shared';

export async function runHeadcount(): Promise<string> {
  const { versions, srdMap, risks } = await loadAllData();
  const now = new Date().toLocaleString('zh-CN');

  // 批量解析所有用户名
  const allUserKeys = new Set<string>();
  for (const v of versions) {
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    const leaves = collectLeaves(srdIds.map(String), srdMap);
    for (const l of leaves) { if (l.creator) allUserKeys.add(l.creator); }
  }
  for (const uk of allUserKeys) { await resolveUserName(uk); }

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

  const uname = (uk: string) => userNameCache[uk] || uk.slice(-8);

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

  // 综合指标
  const activeVers = versions.filter(v => v.workflow_nodes.find(n => n.status === 2));
  const blockedVers = versions.filter(v => v.workflow_nodes.find(n => n.name === '门禁评审' && n.status === 2));
  const riskCount = risks.filter(r => !extractField(r, '是否完成')).length;

  // SVG → Base64
  const svgB64 = (name: string) => { try { const sf = path.join(OUTPUT_DIR, name); return fs.existsSync(sf) ? Buffer.from(fs.readFileSync(sf, 'utf-8')).toString('base64') : ''; } catch { return ''; } };
  const ganttB64 = svgB64('gantt_people.svg');

  // 预警信息
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

  // SRD 层级树
  const treeLines: string[] = [];
  for (const v of versions) {
    const srdIds = (extractField(v as unknown as Record<string, unknown>, '跟版SRD') as number[]) || [];
    if (srdIds.length === 0) { treeLines.push(`### ${v.name}`, '（无 SRD）', ''); continue; }
    treeLines.push(`### ${v.name}`);
    treeLines.push(buildSRDTree(srdIds.map(String), srdMap));
    treeLines.push('');
  }

  return [
    H_HEAD,
    `<div class="header"><h1>📊 版本管理周报</h1><div class="sub"><time>${now}</time><span>·</span>空间 aniwonder<span>·</span>智小协 自动生成</div>`,
    `<div class="metrics">`,
    `<div class="metric"><div class="value">${versions.length}</div><div class="label">总版本数</div></div>`,
    `<div class="metric warning"><div class="value">${activeVers.length}</div><div class="label">进行中</div></div>`,
    `<div class="metric"><div class="value">${allCreators.size}</div><div class="label">参与人数</div></div>`,
    `<div class="metric danger"><div class="value">${riskCount}</div><div class="label">风险项</div></div>`,
    `</div></div>`,
    ...(alerts.length>0?alerts:[]),
    `<div class="section"><div class="section-title"><span class="icon">🩺</span> 版本健康度 <span class="tag ${blockedVers.length>0?'tag-red':'tag-green'}">${blockedVers.length>0?blockedVers.length+' 需关注':'正常'}</span></div>`,
    `<div class="section-summary">${blockedVers.length>0?'V0.1.0 门禁阻塞且 NUDD 未关闭，需优先处理。':'所有版本正常推进中。'}</div>`,
    `<div class="v-cards">${vCards}</div></div>`,
    `<div class="section"><div class="section-title"><span class="icon">📈</span> 模块负载</div>`,
    `<div class="section-summary">${modLabels.length>0?modLabels[0]+' 等 '+modLabels.length+' 个模块共 '+modValues.reduce((a,b)=>a+b,0)+' 个任务，'+uname([...allCreators.keys()][0]||'')+' 单人覆盖。未分配模块有 1 个任务待认领。':'暂无数据'}</div>`,
    `<div class="grid2">`,
    `<div class="card card-sm"><div style="font-size:14px;font-weight:600;color:#475569;margin-bottom:16px">任务量分布</div>`,
    ...modLabels.map((l,i)=>`<div class="spark-row"><span class="spark-label">${l}</span><div class="spark-bar"><div class="spark-fill" style="width:${Math.round(modValues[i]/Math.max(...modValues,1)*100)}%;background:${i===modLabels.length-1?'#FCA5A5':'#3B82F6'}"></div></div><span class="spark-val">${modValues[i]}</span></div>`),
    `</div>`,
    `<div class="card card-sm"><div style="font-size:14px;font-weight:600;color:#475569;margin-bottom:16px">人员模块分配</div>`,
    (ganttB64?`<img src="data:image/svg+xml;base64,${ganttB64}" style="max-width:100%">`:''),
    `</div></div></div>`,
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
    `<div class="section"><div class="section-title"><span class="icon">⚠️</span> NUDD 风险管理 <span class="tag ${risks.filter(r=>!extractField(r,'是否完成')).length>0?'tag-red':'tag-green'}">${risks.filter(r=>!extractField(r,'是否完成')).length} 个${risks.filter(r=>!extractField(r,'是否完成')).length>0?'高风险':''}</span></div>`,
    `<div class="section-summary">${risks.filter(r=>!extractField(r,'是否完成')).length>0?risks.filter(r=>!extractField(r,'是否完成')).length+' 个 NUDD 风险项需在门禁评审前关闭，否则阻塞上线。':'无 NUDD 风险项。'}</div>`,
    nuddCards||'<div class="card"><div style="color:#94A3B8;text-align:center;padding:20px">✅ 无未关闭的 NUDD 风险项</div></div>',
    `</div>`,
    `<div class="section"><div class="section-title"><span class="icon">🌳</span> SRD 层级结构</div>`,
    `<div class="card"><div class="tree">${treeLines.length>0?treeLines.join('<br>'):'（无 SRD 数据）'}</div></div></div>`,
    H_TAIL,
  ].join('\n');
}
