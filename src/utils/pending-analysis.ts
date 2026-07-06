/**
 * 待处理分析队列
 * Token 过期 → 存起来 → 授权成功后自动继续
 */
interface PendingItem { workItemName: string; chatId: string; }
const pending = new Map<string, PendingItem>();

export function savePending(openId: string, item: PendingItem): void {
  pending.set(openId, item);
}
export function popPending(openId: string): PendingItem | undefined {
  const item = pending.get(openId);
  pending.delete(openId);
  return item;
}
