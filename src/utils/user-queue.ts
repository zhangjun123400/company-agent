/**
 * 用户消息队列
 * 确保同一用户消息有序处理、不同用户完全隔离
 */
type Task = () => Promise<void>;

const queues = new Map<string, Promise<void>>();

/**
 * 按用户串行执行任务
 * 同一用户的多个请求依次处理，不并发、不遗漏
 * 不同用户互不阻塞
 */
export function enqueue(userKey: string, task: Task): void {
  const prev = queues.get(userKey) || Promise.resolve();
  const next = prev.then(task).catch((e) => console.error(`[Queue] ${userKey}:`, e));
  queues.set(userKey, next);
}
