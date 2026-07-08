/**
 * project:query + project:search — 平台能力
 * 查询飞书项目工作项详情、节点、用户；搜索需求
 */
import axios from 'axios';
import type { ToolHandler, ToolContext } from './_types';
import { projectConfig } from '../config';

let meegleToken: string | null = null;
async function getToken(): Promise<string> {
  if (meegleToken) return meegleToken;
  const res = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1,
  });
  meegleToken = res.data.data.token as string;
  return meegleToken as string;
}

/** project:query — 按 type 查询不同资源 */
async function queryExecute(ctx: ToolContext): Promise<string> {
  const t = await getToken();
  const H = { 'X-Plugin-Token': t, 'X-User-Key': projectConfig.userKey };

  const res = await axios.post(
    `https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/story/query`,
    { work_item_ids: [parseInt(ctx.workItemId, 10)], expand: { need_workflow: true } },
    { headers: H }
  );

  const item = (res.data.data || [])[0] || {};
  return JSON.stringify({
    id: item.id,
    name: item.name || '',
    owner: item.created_by || '',
    fields: item.fields || [],
    nodes: (item.current_nodes || []).map((n: Record<string, unknown>) => ({ name: n.name, owners: n.owners })),
  });
}

/** project:search — 模糊搜索需求 */
async function searchExecute(ctx: ToolContext): Promise<string> {
  const keyword = ctx.previousOutput || ctx.workItemName;
  const t = await getToken();
  const res = await axios.post(
    'https://project.feishu.cn/open_api/compositive_search',
    { query_type: 'workitem', query: keyword, page_size: 5 },
    { headers: { 'X-Plugin-Token': t, 'X-User-Key': projectConfig.userKey } }
  );
  return JSON.stringify((res.data.data || []).map((i: Record<string, unknown>) => ({
    id: i.ID || i.id, name: i.name,
  })));
}

export const projectQueryTool: ToolHandler = {
  id: 'project:query',
  description: '查询飞书项目工作项详情/节点/用户',
  execute: queryExecute,
};

export const projectSearchTool: ToolHandler = {
  id: 'project:search',
  description: '模糊搜索飞书项目需求',
  execute: searchExecute,
};
