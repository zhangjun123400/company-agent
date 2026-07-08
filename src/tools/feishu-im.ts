/**
 * im:send — 平台能力
 * 发送飞书消息（交互卡片或文本）给指定目标
 */
import axios from 'axios';
import type { ToolHandler, ToolContext } from './_types';
import { feishuApp } from '../config';

async function execute(ctx: ToolContext): Promise<string> {
  const docUrl = ctx.previousOutput || '';
  const token = await getTenantToken();
  const H = { Authorization: `Bearer ${token}` };

  // 发交互卡片（含文档链接）
  await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
    {
      receive_id: ctx.requester || '',
      msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: { title: { content: `📄 分析报告`, tag: 'plain_text' }, template: 'blue' },
        elements: [
          { tag: 'markdown', content: `**${ctx.workItemName}** 的分析报告已生成。\n\n👉 [点击查看](${docUrl})` },
          { tag: 'hr' },
          { tag: 'note', elements: [{ tag: 'plain_text', content: '🤖 智小协自动生成' }] },
        ],
      }),
    },
    { headers: H, timeout: 10000 }
  ).catch((e: unknown) => console.error('[im:send]', (e as Error).message));

  return docUrl;
}

let tenant: string | null = null;
async function getTenantToken(): Promise<string> {
  if (tenant) return tenant;
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: feishuApp.appId, app_secret: feishuApp.appSecret,
  });
  tenant = res.data.tenant_access_token as string;
  return tenant as string;
}

export const imSendTool: ToolHandler = {
  id: 'im:send',
  description: '发送飞书消息/卡片',
  execute,
};
