/**
 * 通知发送工具
 *
 * 双通道策略：
 * 1. 如果配置了飞书 IM 机器人 → 发送飞书群消息
 * 2. 否则 → 将提醒以评论形式写入飞书项目工作项
 */
import axios from 'axios';
import { imConfig, projectConfig, FEISHU_IM_TOKEN_URL } from '../config';
import { feishuProject } from '../feishu-project';

// ==================== 飞书 IM 通道（可选） ====================

let imToken: { token: string; expireAt: number } | null = null;

async function getImToken(): Promise<string | null> {
  if (!imConfig.enabled) return null;

  if (imToken && Date.now() < imToken.expireAt - 300_000) {
    return imToken.token;
  }

  try {
    const res = await axios.post(FEISHU_IM_TOKEN_URL, {
      app_id: imConfig.appId,
      app_secret: imConfig.appSecret,
    });

    if (res.data.code !== 0) {
      console.error('[IM] 获取 token 失败:', res.data);
      return null;
    }

    imToken = {
      token: res.data.tenant_access_token,
      expireAt: Date.now() + res.data.expire * 1000,
    };
    return imToken.token;
  } catch (error) {
    console.error('[IM] 获取 token 异常:', error);
    return null;
  }
}

/** 发送飞书群卡片消息 */
async function sendImCard(
  title: string,
  markdownContent: string,
  color: 'blue' | 'green' | 'red' | 'yellow' = 'blue'
): Promise<boolean> {
  if (!imConfig.chatId) return false;

  const token = await getImToken();
  if (!token) return false;

  try {
    await axios.post(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        receive_id: imConfig.chatId,
        msg_type: 'interactive',
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          header: {
            title: { content: title, tag: 'plain_text' },
            template: color,
          },
          elements: [
            { tag: 'markdown', content: markdownContent },
            { tag: 'hr' },
            {
              tag: 'note',
              elements: [
                {
                  tag: 'plain_text',
                  content: `🤖 智慧智能体 · ${new Date().toLocaleString('zh-CN')}`,
                },
              ],
            },
          ],
        }),
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return true;
  } catch (error) {
    console.error('[IM] 发送消息失败:', error);
    return false;
  }
}

// ==================== 统一通知接口 ====================

/**
 * 发送通知（自动选择通道）
 *
 * 优先飞书群消息，降级为飞书项目评论
 */
export async function sendNotification(
  workItemId: string,
  title: string,
  markdownContent: string,
  color: 'blue' | 'green' | 'red' | 'yellow' = 'blue'
): Promise<void> {
  // 先尝试飞书 IM
  const imSent = await sendImCard(title, markdownContent, color);
  if (imSent) {
    console.log('[通知] 已通过飞书 IM 发送');
    return;
  }

  // 降级为飞书项目评论
  try {
    const commentText = `## ${title}\n\n${markdownContent}\n\n> 🤖 智慧智能体自动生成`;
    await feishuProject.addComment(workItemId, commentText);
    console.log('[通知] 已通过飞书项目评论发送（IM 未配置）');
  } catch (error) {
    console.error('[通知] 所有通道发送失败:', error);
  }
}

// ==================== 专项通知 ====================

/** PRD 超时提醒 */
export async function sendOverdueReminder(
  workItemId: string,
  workItemName: string,
  daysSinceUpload: number
): Promise<void> {
  const color = daysSinceUpload > 7 ? 'red' : 'yellow';
  const projectUrl = `https://project.feishu.cn/${projectConfig.spaceKey}/story/${workItemId}`;

  await sendNotification(
    workItemId,
    '⚠ PRD 超时未评审提醒',
    [
      `**需求名称：** ${workItemName}`,
      `**PRD 上传：** ${daysSinceUpload} 天前`,
      `**状态：** 仍未组织评审`,
      '',
      `> 根据规范，PRD 上传后应在 ${projectConfig.prdReviewTimeoutDays} 天内组织评审，请尽快安排。`,
      '',
      `[查看需求详情](${projectUrl})`,
    ].join('\n'),
    color
  );
}

/** 技术可行性报告通知 */
export async function sendTechReportCard(
  workItemId: string,
  workItemName: string,
  conclusion: string
): Promise<void> {
  const color = conclusion.includes('可行') && !conclusion.includes('不') ? 'green' : 'yellow';
  const projectUrl = `https://project.feishu.cn/${projectConfig.spaceKey}/story/${workItemId}`;

  await sendNotification(
    workItemId,
    '📊 技术可行性初评完成',
    [
      `**需求名称：** ${workItemName}`,
      `**技术可行性结论：** ${conclusion}`,
      '',
      `技术方案初稿已生成，详细报告请查看工作项评论。`,
      '',
      `[查看详情](${projectUrl})`,
    ].join('\n'),
    color
  );
}

/** 需求澄清清单通知 */
export async function sendClarificationCard(
  workItemId: string,
  workItemName: string,
  totalQuestions: number
): Promise<void> {
  const projectUrl = `https://project.feishu.cn/${projectConfig.spaceKey}/story/${workItemId}`;

  await sendNotification(
    workItemId,
    '❓ 需求澄清问题清单已生成',
    [
      `**需求名称：** ${workItemName}`,
      `**待澄清问题：** ${totalQuestions} 个`,
      '',
      `请查看详细问题清单并逐一确认。`,
      '',
      `[查看详情](${projectUrl})`,
    ].join('\n'),
    'blue'
  );
}
