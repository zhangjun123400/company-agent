/**
 * 能力1：PRD 超时未评审提醒
 *
 * 1. 获取空间中"需求"类型的工作项
 * 2. 识别状态 — 哪些已上传 PRD 但未组织/完成"评审"
 * 3. 超出 projectConfig.prdReviewTimeoutDays 天则发送提醒
 * 4. 提醒通过飞书 IM 发送（降级为飞书项目评论）
 */
import dayjs from 'dayjs';
import { getWorkItemTypes, getAllWorkItems, getComments, addComment, filterWorkItems, queryWorkItems } from '../feishu-project/client';
import type { WorkItem, OverdueReminderResult, WorkflowNode } from '../feishu-project';
import { sendOverdueReminder } from '../utils/feishu-message';
import { projectConfig } from '../config';

export interface ReminderRunResult {
  totalChecked: number;
  overdueCount: number;
  remindersSent: number;
  details: OverdueReminderResult[];
}

/**
 * 执行一次完整的超时检查与提醒
 */
export async function runOverdueCheck(): Promise<ReminderRunResult> {
  console.log('[能力1] 开始 PRD 超时未评审检查...');

  const allItems = await fetchAllPrdWorkItems();
  console.log(`[能力1] 获取到 ${allItems.length} 个需求`);

  const results: OverdueReminderResult[] = [];
  for (const item of allItems) {
    const result = await checkSingleWorkItem(item);
    results.push(result);
  }

  let remindersSent = 0;
  for (const result of results) {
    if (result.shouldRemind) {
      try {
        await sendOverdueReminder(
          result.workItemId,
          result.workItemName,
          result.daysSinceUpload
        );
        result.reminderSent = true;
        remindersSent++;
        console.log(`[能力1] ✅ 已发送提醒: ${result.workItemName}`);
      } catch (error) {
        console.error(`[能力1] ❌ 发送提醒失败: ${result.workItemName}`, error);
      }
    }
  }

  const summary: ReminderRunResult = {
    totalChecked: results.length,
    overdueCount: results.filter((r) => r.shouldRemind).length,
    remindersSent,
    details: results,
  };

  console.log(
    `[能力1] 完成: ${summary.totalChecked} 个需求, ` +
    `${summary.overdueCount} 超时, ${summary.remindersSent} 条提醒已发送`
  );
  return summary;
}

async function fetchAllPrdWorkItems(): Promise<WorkItem[]> {
  const types = await getWorkItemTypes();
  const prdType = types.find(
    (t: { key: string; name: string }) =>
      t.name === '需求' || t.name === 'Story' ||
      t.name === 'story' || t.name.toLowerCase().includes('prd')
  );

  const params: Record<string, unknown> = { page_size: 50 };
  if (prdType) {
    params.work_item_type_id = prdType.id;
  }

  return feishuProject.getAllWorkItems(params);
}

async function checkSingleWorkItem(item: WorkItem): Promise<OverdueReminderResult> {
  const workItemId = item.id;
  const workItemName = item.name;

  // 1. 获取附件，找 PRD 文档
  const attachments = await feishuProject.getAttachments(workItemId);
  const prdAttachment = attachments.find((a: { file_name: string; upload_time?: string; created_at?: string; file_type?: string }) => {
    const name = a.file_name.toLowerCase();
    return (
      name.includes('prd') || name.includes('需求文档') ||
      name.includes('产品需求') || /\.(pdf|docx?|md)$/i.test(name)
    );
  });

  if (!prdAttachment) {
    return emptyResult(item, '无PRD附件');
  }

  // 2. 获取节点信息，找评审节点
  const nodes = await feishuProject.getWorkItemNodes(workItemId);
  const reviewNode = findReviewNode(nodes);

  if (reviewNode && reviewNode.status === 'completed') {
    return {
      ...emptyResult(item, '已评审'),
      prdUploadTime: prdAttachment.upload_time || prdAttachment.created_at || '',
      daysSinceUpload: dayjs().diff(
        dayjs(prdAttachment.upload_time || prdAttachment.created_at), 'day'
      ),
      currentNode: reviewNode.name,
      currentNodeStatus: reviewNode.status,
    };
  }

  // 3. 判断是否超时
  const uploadTime = prdAttachment.upload_time || prdAttachment.created_at || '';
  const daysSinceUpload = dayjs().diff(dayjs(uploadTime), 'day');
  const timeoutDays = projectConfig.prdReviewTimeoutDays;

  if (daysSinceUpload <= timeoutDays) {
    return {
      ...emptyResult(item, '未超时'),
      prdUploadTime: uploadTime,
      daysSinceUpload,
      currentNode: reviewNode?.name || '',
      currentNodeStatus: reviewNode?.status || '',
    };
  }

  // 4. 超时
  return {
    workItemId,
    workItemName,
    prdUploadTime: uploadTime,
    daysSinceUpload,
    currentNode: reviewNode?.name || '无评审节点',
    currentNodeStatus: reviewNode?.status || 'unknown',
    shouldRemind: true,
    reminderMessage: [
      `⚠ PRD 超时未评审提醒`,
      `- 需求：${workItemName}`,
      `- PRD 已上传：${daysSinceUpload} 天`,
      `- 超时：${daysSinceUpload - timeoutDays} 天`,
      `- 当前节点：${reviewNode?.name || '未找到评审节点'}`,
    ].join('\n'),
    reminderSent: false,
  };
}

function findReviewNode(nodes: WorkflowNode[]): WorkflowNode | null {
  const keywords = ['评审', 'review', '方案评审', '需求评审', '技术评审'];
  const search = (list: WorkflowNode[]): WorkflowNode | null => {
    for (const node of list) {
      if (keywords.some((kw) => node.name.toLowerCase().includes(kw.toLowerCase()))) {
        return node;
      }
      if (node.children) {
        const found = search(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return search(nodes);
}

function emptyResult(
  item: WorkItem,
  reason: string
): OverdueReminderResult {
  return {
    workItemId: item.id,
    workItemName: item.name,
    prdUploadTime: '',
    daysSinceUpload: -1,
    currentNode: reason,
    currentNodeStatus: '',
    shouldRemind: false,
    reminderMessage: '',
    reminderSent: false,
  };
}
