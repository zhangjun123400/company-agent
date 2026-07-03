/**
 * 能力3：PRD 需求澄清问题清单
 *
 * 1. 从工作项获取 PRD 文档
 * 2. Claude 从 6 个维度审查 PRD
 * 3. 输出分类问题清单
 * 4. 结果写入飞书项目评论 + 通知
 */
import Anthropic from '@anthropic-ai/sdk';
import { projectConfig, anthropicApiKey } from '../config';
import { feishuProject } from '../feishu-project';
import type { ClarificationQuestions, ClarificationQuestion, QuestionCategory } from '../feishu-project';
import { extractPrdFromWorkItem, truncateText } from '../utils/prd-parser';
import { sendClarificationCard } from '../utils/feishu-message';

let claude: Anthropic | null = null;
function getClaude(): Anthropic {
  if (!claude) {
    if (!anthropicApiKey) throw new Error('ANTHROPIC_API_KEY 未配置');
    claude = new Anthropic({ apiKey: anthropicApiKey });
  }
  return claude;
}

export async function generateClarificationQuestions(
  workItemId: string
): Promise<ClarificationQuestions | null> {
  console.log(`[能力3] 开始分析工作项 ${workItemId}...`);

  const prd = await extractPrdFromWorkItem(workItemId);
  if (!prd) {
    console.log('[能力3] 未找到 PRD 文档');
    return null;
  }

  const workItem = await feishuProject.getWorkItem(workItemId);
  const existingComments = await feishuProject.getComments(workItemId);
  const questions = await analyzePrd(prd.text, workItem, existingComments);

  // 写入评论
  try {
    await feishuProject.addComment(workItemId, formatQuestions(questions));
    console.log('[能力3] 问题清单已写入评论');
  } catch (error) {
    console.error('[能力3] 写入评论失败:', error);
  }

  // 发送通知
  await sendClarificationCard(workItemId, workItem.name, questions.totalQuestions);

  return questions;
}

async function analyzePrd(
  prdText: string,
  workItem: { name: string; fields?: Record<string, unknown> },
  comments: { content: string }[]
): Promise<ClarificationQuestions> {
  const anthropic = getClaude();
  const existingCtx = comments.length > 0
    ? `\n## 已有评论\n${comments.map((c) => c.content).join('\n---\n')}`
    : '';

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 6000,
    system: `你是资深产品需求分析师，负责审查PRD的质量和完整性。
从以下维度找出需要澄清的问题：业务逻辑、技术约束、UI/UX、数据模型、非功能性需求、验收标准。
每个问题给出背景(为什么需要澄清)和建议方向。严格按JSON格式输出。`,
    messages: [{
      role: 'user',
      content: `## PRD文档\n${truncateText(prdText, 40000)}

## 工作项上下文\n需求名称: ${workItem.name}\n字段: ${JSON.stringify(workItem.fields || {}, null, 2)}${existingCtx}

## 输出JSON格式
{
  "categories": [{
    "name": "分类名",
    "questions": [{
      "id": "Q-001",
      "question": "问题描述",
      "context": "为何需要澄清",
      "suggestion": "建议方向",
      "priority": "高|中|低"
    }]
  }],
  "overallAssessment": "整体PRD质量评估(100-200字)"
}`,
    }],
  });

  const content = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return parseQuestions(content, workItem.name);
}

function parseQuestionsFromCategory(
  rawQuestions: unknown,
  _catIdx: number
): ClarificationQuestion[] {
  const arr = rawQuestions as unknown[];
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map((q, qIdx) => {
    const r = q as Record<string, unknown>;
    return {
      id: (r.id as string) || `Q-${String(qIdx + 1).padStart(3, '0')}`,
      question: (r.question as string) || '',
      context: (r.context as string) || '',
      suggestion: (r.suggestion as string) || '',
      priority: (r.priority as ClarificationQuestion['priority']) || '中',
    };
  });
}

function parseQuestions(content: string, name: string): ClarificationQuestions {
  let json = content.trim();
  if (json.startsWith('```')) json = json.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  try {
    const parsed = JSON.parse(json);
    const rawCategories: Array<Record<string, unknown>> = parsed.categories || [];
    const categories: QuestionCategory[] = rawCategories.map((cat, catIdx) => ({
      name: (cat.name as string) || `分类${catIdx + 1}`,
      questions: parseQuestionsFromCategory(cat.questions, catIdx),
    }));

    return {
      title: `需求澄清问题清单 - ${name}`,
      generatedAt: new Date().toISOString(),
      workItemId: '',
      totalQuestions: categories.reduce((s, c) => s + c.questions.length, 0),
      categories,
      overallAssessment: (parsed.overallAssessment as string) || '',
    };
  } catch (error) {
    console.error('[能力3] JSON解析失败:', error);
    return {
      title: `需求澄清问题清单 - ${name}`,
      generatedAt: new Date().toISOString(),
      workItemId: '',
      totalQuestions: 1,
      categories: [{
        name: '解析异常',
        questions: [{
          id: 'Q-001',
          question: '自动分析异常，请人工审阅PRD',
          context: content.slice(0, 300),
          priority: '高',
        }],
      }],
      overallAssessment: '自动分析异常，建议人工审阅。',
    };
  }
}

function formatQuestions(questions: ClarificationQuestions): string {
  const e: Record<string, string> = { '高': '🔴', '中': '🟡', '低': '🟢' };
  const lines = [
    `## ❓ 需求澄清问题清单`,
    `**生成时间：** ${questions.generatedAt}  |  **问题总数：** ${questions.totalQuestions} 个`,
    '',
  ];

  for (const cat of questions.categories) {
    if (cat.questions.length === 0) continue;
    lines.push(`### 📂 ${cat.name}（${cat.questions.length}个）`);
    for (const q of cat.questions) {
      lines.push(`**${q.id}** ${e[q.priority] || ''} [${q.priority}] ${q.question}`);
      if (q.context) lines.push(`> 背景: ${q.context}`);
      if (q.suggestion) lines.push(`> 💡 建议: ${q.suggestion}`);
      lines.push('');
    }
  }

  lines.push(`### 📋 整体评估\n${questions.overallAssessment}`);
  lines.push(`> 此清单由智慧智能体自动生成，请逐项确认后完善PRD。`);
  return lines.join('\n');
}
