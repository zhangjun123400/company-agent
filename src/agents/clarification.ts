/**
 * 能力3：PRD 需求澄清问题清单
 */
import type { ClarificationQuestions, ClarificationQuestion, QuestionCategory } from '../feishu-project/types';
import { truncateText } from '../utils/prd-parser';
import { aiComplete } from '../utils/ai-client';

async function analyzePrd(
  prdText: string,
  workItem: { name: string; fields?: Record<string, unknown> },
  comments: { content: string }[]
): Promise<ClarificationQuestions> {
  const existingCtx = comments.length > 0
    ? `\n## 已有评论\n${comments.map((c) => c.content).join('\n---\n')}`
    : '';

  const response = await aiComplete({
    maxTokens: 6000,
    system: `你是资深产品需求分析师，负责审查PRD的质量和完整性。
从以下维度找出需要澄清的问题：业务逻辑、技术约束、UI/UX、数据模型、非功能性需求、验收标准。
每个问题给出背景(为什么需要澄清)和建议方向。严格按JSON格式输出。`,
    messages: [{
      role: 'user',
      content: `## PRD文档\n${truncateText(prdText, 40000)}
## 工作项上下文\n需求名称: ${workItem.name}\n字段: ${JSON.stringify(workItem.fields || {}, null, 2)}${existingCtx}
## 输出JSON格式
{
  "categories": [{"name": "分类名", "questions": [
    {"id": "Q-001", "question": "问题描述", "context": "为何需要澄清", "suggestion": "建议方向", "priority": "高|中|低"}
  ]}],
  "overallAssessment": "整体PRD质量评估(100-200字)"
}`,
    }],
  });

  return parseQuestions(response, workItem.name);
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
      generatedAt: new Date().toISOString(), workItemId: '',
      totalQuestions: categories.reduce((s, c) => s + c.questions.length, 0),
      categories, overallAssessment: (parsed.overallAssessment as string) || '',
    };
  } catch {
    return {
      title: `需求澄清问题清单 - ${name}`, generatedAt: new Date().toISOString(), workItemId: '',
      totalQuestions: 1, categories: [{ name: '解析异常', questions: [{ id: 'Q-001', question: '自动分析异常，请人工审阅PRD', context: content.slice(0, 300), priority: '高' }] }],
      overallAssessment: '自动分析异常，建议人工审阅。',
    };
  }
}

function parseQuestionsFromCategory(raw: unknown, _catIdx: number): ClarificationQuestion[] {
  const arr = raw as unknown[];
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map((q, qIdx) => {
    const r = q as Record<string, unknown>;
    return {
      id: (r.id as string) || `Q-${String(qIdx + 1).padStart(3, '0')}`,
      question: (r.question as string) || '', context: (r.context as string) || '',
      suggestion: (r.suggestion as string) || '', priority: (r.priority as ClarificationQuestion['priority']) || '中',
    };
  });
}

function formatQuestions(questions: ClarificationQuestions): string {
  const e: Record<string, string> = { '高': '🔴', '中': '🟡', '低': '🟢' };
  const lines = [`## ❓ 需求澄清问题清单`, `**问题总数：** ${questions.totalQuestions} 个`, ''];
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

export async function analyzePrdForClarification(prdText: string, workItemName: string): Promise<ClarificationQuestions> {
  return analyzePrd(prdText, { name: workItemName }, []);
}
export function formatClarificationResult(result: ClarificationQuestions, prdUrl?: string): string {
  const header = prdUrl ? `📎 **PRD 文档链接：** ${prdUrl}\n\n---\n\n` : '';
  return header + formatQuestions(result);
}
