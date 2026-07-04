/**
 * 智慧智能体 功能测试
 *
 * 用法:
 *   npx tsx src/test.ts                    # 全量测试
 *   npx tsx src/test.ts --work-item <id>   # 测试指定工作项
 *   npx tsx src/test.ts --capability 1     # 只测能力1
 *   npx tsx src/test.ts --capability 2     # 只测能力2
 *   npx tsx src/test.ts --capability 3     # 只测能力3
 */
import dotenv from 'dotenv';
dotenv.config();

import * as feishuProject from './feishu-project/client';
import { projectConfig, imConfig } from './config';
import {
  runOverdueCheck,
  generateTechFeasibilityReport,
  generateClarificationQuestions,
} from './agents';

async function main() {
  const args = process.argv.slice(2);
  const capIdx = args.indexOf('--capability');
  const wiIdx = args.indexOf('--work-item');
  const capability = capIdx >= 0 ? parseInt(args[capIdx + 1], 10) : 0;
  const workItemId = wiIdx >= 0 ? args[wiIdx + 1] : null;

  console.log('═══════════════════════════════════════════');
  console.log('  智慧智能体 功能测试');
  console.log('═══════════════════════════════════════════');
  console.log(`  飞书项目空间: ${projectConfig.spaceKey}`);
  console.log(`  IM 通知: ${imConfig?.enabled ? '✅' : '⚠ 未配置(降级为评论)'}`);
  console.log(`  超时阈值: ${projectConfig.prdReviewTimeoutDays} 天`);
  console.log('═══════════════════════════════════════════\n');

  try {
    // 验证 API 连接
    console.log('[测试] 验证飞书项目 API 连接...');
    const types = await feishuProject.getWorkItemTypes();
    console.log(`[测试] ✅ 连接成功！${types.length} 种工作项类型:`);
    for (const t of types) console.log(`  - ${t.name} (${t.id})`);
    console.log('');

    if (workItemId) {
      await testSingleItem(workItemId, capability);
      return;
    }

    if (capability === 0 || capability === 1) {
      console.log('────── 能力1: PRD超时提醒 ──────');
      const r = await runOverdueCheck();
      console.log(`检查: ${r.totalChecked} | 超时: ${r.overdueCount} | 提醒: ${r.remindersSent}`);
      for (const d of r.details.filter((d) => d.shouldRemind)) {
        console.log(`  ⚠ ${d.workItemName}: ${d.daysSinceUpload}天`);
      }
      console.log('');
    }

    if (capability === 0 || capability === 2) {
      console.log('────── 能力2: 技术可行性初评 ──────');
      const prdType = types.find((t) => ['需求', 'Story', 'story'].includes(t.name));
      if (prdType) {
        const items = await feishuProject.getAllWorkItems(prdType.type_key, 10);
        if (items.length > 0) {
          const report = await generateTechFeasibilityReport(items[0].id);
          if (report) {
            console.log(`需求: ${items[0].name}`);
            console.log(`结论: ${report.conclusion} | 置信度: ${(report.confidence * 100).toFixed(0)}%`);
            console.log(`挑战: ${report.challenges.length} | 风险: ${report.risks.length}`);
          }
        } else {
          console.log('(空间无需求类型工作项)');
        }
      }
      console.log('');
    }

    if (capability === 0 || capability === 3) {
      console.log('────── 能力3: 需求澄清清单 ──────');
      const prdType = types.find((t) => ['需求', 'Story', 'story'].includes(t.name));
      if (prdType) {
        const items = await feishuProject.getAllWorkItems(prdType.type_key, 10);
        if (items.length > 0) {
          const q = await generateClarificationQuestions(items[0].id);
          if (q) {
            console.log(`需求: ${items[0].name}`);
            console.log(`问题: ${q.totalQuestions} 个`);
            for (const c of q.categories) console.log(`  ${c.name}: ${c.questions.length}个`);
          }
        } else {
          console.log('(空间无需求类型工作项)');
        }
      }
      console.log('');
    }

    console.log('═══════════════════════════════════════════');
    console.log('  测试完成');
    console.log('═══════════════════════════════════════════');
  } catch (error) {
    console.error('[测试] 失败:', error);
    process.exit(1);
  }
}

async function testSingleItem(id: string, cap: number) {
  const item = await feishuProject.getWorkItem(id);
  console.log(`[测试] ${item.name} (${item.id}) | 状态: ${item.status}\n`);

  if (cap === 0 || cap === 2) {
    console.log('--- 技术可行性 ---');
    const report = await generateTechFeasibilityReport(id);
    if (report) {
      console.log(JSON.stringify({
        conclusion: report.conclusion,
        confidence: report.confidence,
        approach: report.recommendedApproach.name,
        challenges: report.challenges.length,
        risks: report.risks.length,
      }, null, 2));
    }
  }

  if (cap === 0 || cap === 3) {
    console.log('--- 需求澄清 ---');
    const q = await generateClarificationQuestions(id);
    if (q) {
      console.log(JSON.stringify({
        total: q.totalQuestions,
        categories: q.categories.map((c) => ({ name: c.name, count: c.questions.length })),
      }, null, 2));
    }
  }
}

main();
