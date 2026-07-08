/**
 * 工具注册表
 *
 * 全局单例，维护 toolId → ToolHandler 的映射。
 * 启动时自动注册所有内置工具。
 */
import type { ToolHandler } from './_types';

class ToolRegistry {
  private tools = new Map<string, ToolHandler>();

  /** 注册工具（幂等 — 重复注册会覆盖） */
  register(handler: ToolHandler): void {
    this.tools.set(handler.id, handler);
  }

  /** 获取工具 */
  get(id: string): ToolHandler | undefined {
    return this.tools.get(id);
  }

  /** 列出所有已注册工具 */
  list(): ToolHandler[] {
    return [...this.tools.values()];
  }

  /** 检查一组工具是否全部可用 */
  hasAll(ids: string[]): boolean {
    return ids.every((id) => this.tools.has(id));
  }
}

/** 全局单例 */
export const toolRegistry = new ToolRegistry();
