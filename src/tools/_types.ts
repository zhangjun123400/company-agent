/**
 * 工具系统 — 类型定义
 *
 * 每个工具实现 ToolHandler 接口，注册到 toolHandlers map。
 * Agent 通过 SKILL.md 的 tools 字段声明自己需要哪些工具，
 * 引擎根据 tools 组合自动匹配执行模式。
 */

/** 工具执行上下文 — 贯穿整个工具链 */
export interface ToolContext {
  workItemId: string;
  workItemName: string;
  nodeName: string;
  /** 上一工具的输出，由引擎自动注入 */
  previousOutput?: string;
  /** SKILL.md 正文（系统提示词），ai:analyze 需要 */
  skillBody?: string;
  /** wiki:read 输出，注入上下文供后续工具使用 */
  prdContent?: string;
  /** 飞书字段值 */
  fields: Record<string, unknown>;
  /** 自由扩展 */
  [key: string]: unknown;
}

/** 工具处理器接口 */
export interface ToolHandler {
  /** 工具 ID，如 "wiki:read" */
  id: string;
  /** 一句话描述 */
  description: string;
  /** 执行工具，返回结果字符串 */
  execute(ctx: ToolContext): Promise<string>;
}
