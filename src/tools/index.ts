/**
 * 工具系统入口 — 批量注册所有内置工具
 */
import { toolRegistry } from './_registry';
import { aiAnalyzeTool } from './ai-analyze';
import { wikiReadTool } from './feishu-wiki';
import { docxCreateTool } from './feishu-docx';
import { imSendTool } from './feishu-im';
import { projectQueryTool, projectSearchTool } from './feishu-project';

/** 注册所有内置工具（启动时调用一次） */
export function registerAllTools(): void {
  toolRegistry.register(aiAnalyzeTool);
  toolRegistry.register(wikiReadTool);
  toolRegistry.register(docxCreateTool);
  toolRegistry.register(imSendTool);
  toolRegistry.register(projectQueryTool);
  toolRegistry.register(projectSearchTool);
  console.log(`[Tools] 已注册 ${toolRegistry.list().length} 个工具`);
}

export { toolRegistry } from './_registry';
export type { ToolHandler, ToolContext } from './_types';
