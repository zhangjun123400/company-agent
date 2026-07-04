/**
 * 飞书 IM WebSocket 事件监听
 *
 * 使用飞书官方 @larksuiteoapi/node-sdk 长连接接收消息，
 * 解析用户意图后自动触发需求分析。
 * 服务独立运行，不依赖 Claude Code 中转。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import axios from 'axios';
import { feishuApp, projectConfig } from '../config';

const TRIGGER_KEYWORDS = ['分析', '需求澄清', '技术可行性', '出报告'];

function extractRequirementName(text: string): string | null {
  const patterns = [/(?:分析|出)[「《]?(.+?)[」》]?(?:需求|游戏|项目|的)/, /萝卜蹲\S*/];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1]?.trim() || m[0].trim(); }
  return null;
}

export function startFeishuWS(
  onTrigger: (workItemName: string, openId: string) => Promise<void>
): void {
  try {
    const wsClient = new Lark.WSClient({
      appId: feishuApp.appId,
      appSecret: feishuApp.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        try {
          const message = data.message as Record<string, unknown>;
          const content = parseMessageContent((message.content as string) || '');
          const sender = data.sender as Record<string, unknown> | undefined;
          const senderId = (sender?.sender_id as Record<string, string>)?.open_id || '';

          console.log(`[FeishuWS] 收到: ${content}`);

          if (!TRIGGER_KEYWORDS.some((kw) => content.includes(kw))) return;
          const name = extractRequirementName(content);
          if (!name) return;

          console.log(`[FeishuWS] 触发分析: ${name}`);
          await onTrigger(name, senderId);
        } catch (e) {
          console.error('[FeishuWS] 消息处理异常:', e);
        }
      },
    });

    wsClient.start({ eventDispatcher: dispatcher }).then(() => {
      console.log('[FeishuWS] ✅ 长连接已启动');
    }).catch((e: Error) => {
      console.error('[FeishuWS] 启动失败:', e.message);
    });

  } catch (e) {
    console.error('[FeishuWS] 初始化失败:', e);
  }
}

function parseMessageContent(raw: string): string {
  try { return JSON.parse(raw).text || raw; } catch { return raw; }
}
