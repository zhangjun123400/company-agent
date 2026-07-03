/**
 * 能力2：PRD 技术可行性初评报告
 *
 * 1. 从工作项获取 PRD 文档
 * 2. 加载内部知识库（历史技术文档 + PRD）
 * 3. Claude 综合分析，生成技术方案初稿和可行性结论
 * 4. 结果写入飞书项目评论 + 通知
 */
import Anthropic from '@anthropic-ai/sdk';
import { projectConfig, anthropicApiKey } from '../config';
import { feishuProject } from '../feishu-project';
import type { TechFeasibilityReport } from '../feishu-project';
import { extractPrdFromWorkItem, truncateText } from '../utils/prd-parser';
import { sendTechReportCard } from '../utils/feishu-message';
import { loadKnowledgeBase } from './knowledge-base';

let claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!claude) {
    if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY 未配置');
    claude = new Anthropic({ apiKey: anthropicApiKey });
  }
  return claude;
}

export async function generateTechFeasibilityReport(
  workItemId: string
): Promise<TechFeasibilityReport | null> {
  console.log(`[能力2] 开始分析工作项 ${workItemId}...`);

  const prd = await extractPrdFromWorkItem(workItemId);
  if (!prd) {
    console.log('[能力2] 未找到 PRD 文档');
    return null;
  }

  const knowledge = await loadKnowledgeBase();
  const workItem = await feishuProject.getWorkItem(workItemId);
  const report = await analyzeWithClaude(prd.text, workItem, knowledge);

  // 写入评论
  try {
    await feishuProject.addComment(workItemId, formatReportForComment(report));
    console.log('[能力2] 报告已写入评论');
  } catch (error) {
    console.error('[能力2] 写入评论失败:', error);
  }

  // 发送通知
  await sendTechReportCard(workItemId, workItem.name, report.conclusion);

  return report;
}

async function analyzeWithClaude(
  prdText: string,
  workItem: { name: string; fields?: Record<string, unknown> },
  knowledge: string
): Promise<TechFeasibilityReport> {
  const anthropic = getClaude();
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 8000,
    system: `你是资深技术架构师，负责对PRD进行技术可行性分析。

你需要:
1. 参考内部历史文档和PRD，确保方案延续性和可复用性
2. 结合当前市场主流技术方案，给出业界最佳实践
3. 识别核心技术挑战和风险
4. 给出可落地的技术方案初稿

严格按JSON格式输出，不要输出JSON之外的内容。`,
    messages: [{
      role: 'user',
      content: buildPrompt(prdText, workItem, knowledge),
    }],
  });

  const content = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseReport(content, workItem.name);
}

function buildPrompt(
  prdText: string,
  workItem: { name: string; fields?: Record<string, unknown> },
  knowledge: string
): string {
  return `## PRD 文档\n${truncateText(prdText, 40000)}

## 工作项上下文
需求名称: ${workItem.name}
字段: ${JSON.stringify(workItem.fields || {}, null, 2)}

## 内部历史文档
${truncateText(knowledge, 20000) || '(暂无)'}

## 市场技术趋势参考
- 前端: React/Vue 持续演进，微前端方案成熟
- 后端: 微服务/Serverless/容器化主流
- AI融合: 大模型应用/RAG/Agent模式
- DevOps: CI/CD/GitOps 标准化
- 云原生: K8s + 边缘计算

## 输出JSON格式
{
  "title": "技术可行性初评 - [需求名]",
  "prdSummary": "PRD摘要(200字)",
  "conclusion": "可行|需进一步评估|存在重大风险|不可行",
  "confidence": 0.0-1.0,
  "challenges": [{"area":"领域","description":"描述","severity":"低|中|高|严重","mitigation":"缓解措施"}],
  "recommendedApproach": {"name":"方案名","description":"描述","pros":["优点"],"cons":["缺点"],"estimatedEffort":"工时","techStack":["技术"]},
  "alternatives": [{"name":"备选","description":"描述","pros":[],"cons":[],"estimatedEffort":"工时","techStack":[]}],
  "risks": [{"category":"类别","description":"描述","probability":"低|中|高","impact":"低|中|高","mitigation":"缓解"}],
  "draftPlan": "技术方案初稿(500-1000字)",
  "references": ["参考文档"]
}`;
}

function parseReport(content: string, name: string): TechFeasibilityReport {
  let json = content.trim();
  if (json.startsWith('```')) json = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  try {
    return { ...JSON.parse(json), generatedAt: new Date().toISOString(), workItemId: '' };
  } catch {
    return {
      title: `技术可行性初评 - ${name}`,
      prdSummary: '解析失败',
      conclusion: '需进一步评估' as const,
      confidence: 0.3,
      challenges: [],
      recommendedApproach: { name: '待确认', description: content.slice(0, 300), pros: [], cons: [], estimatedEffort: '待评估', techStack: [] },
      alternatives: [],
      risks: [],
      references: [],
      draftPlan: content,
      generatedAt: new Date().toISOString(),
      workItemId: '',
    };
  }
}

function formatReportForComment(report: TechFeasibilityReport): string {
  const e: Record<string, string> = { '可行': '✅', '需进一步评估': '🟡', '存在重大风险': '⚠️', '不可行': '❌' };
  return [
    `## 🤖 技术可行性初评报告`,
    `**结论：** ${e[report.conclusion] || ''} ${report.conclusion}  |  **置信度：** ${(report.confidence * 100).toFixed(0)}%  |  **生成时间：** ${report.generatedAt}`,
    `### 📝 PRD摘要\n${report.prdSummary}`,
    `### 🔍 核心挑战`,
    ...report.challenges.map((c) => `- **${c.area}** [${c.severity}]: ${c.description} → ${c.mitigation}`),
    `### 💡 推荐方案: ${report.recommendedApproach.name}`,
    `描述: ${report.recommendedApproach.description}`,
    `优点: ${report.recommendedApproach.pros.join('、')}  |  缺点: ${report.recommendedApproach.cons.join('、')}`,
    `预估工时: ${report.recommendedApproach.estimatedEffort}  |  技术栈: ${report.recommendedApproach.techStack.join(', ')}`,
    `### ⚠️ 风险`,
    ...report.risks.map((r) => `- [${r.category}] ${r.description} (概率${r.probability}/影响${r.impact}) → ${r.mitigation}`),
    `### 📐 技术方案初稿\n${report.draftPlan}`,
    `> 此报告由智慧智能体自动生成，最终方案需团队评审确认。`,
  ].join('\n\n');
}
