/**
 * 需求澄清 — 从 prompt.md 加载提示词
 */
import fs from 'fs';
import path from 'path';
import { truncateText } from '../utils/prd-parser';
import { aiComplete } from '../utils/ai-client';

export async function analyzePrdForClarification(prdText: string, workItemName: string): Promise<string> {
  const promptPath = path.resolve(__dirname, '../../agents/需求分析/prompt.md');
  const prompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '你是产品需求分析师。';

  return aiComplete({
    maxTokens: 16000,
    system: prompt,
    messages: [{ role: 'user', content: `## PRD文档\n${truncateText(prdText, 40000)}\n## 需求名称\n${workItemName}` }],
  });
}

export function formatClarificationResult(result: string, title: string, prdUrl: string): string {
  return `# ${title}\n\n> 📎 **PRD 文档：** ${prdUrl}\n> 🕐 **生成时间：** ${new Date().toLocaleString('zh-CN')}\n\n---\n\n${result}`;
}
