/**
 * wiki:read — 平台能力
 * 从飞书项目工作项中提取 Wiki PRD 链接，读取文档内容
 */
import axios from 'axios';
import type { ToolHandler, ToolContext } from './_types';
import { getWikiAccessToken } from '../auth/wiki-token';
import { projectConfig } from '../config';

async function execute(ctx: ToolContext): Promise<string> {
  // 1. 获取工作项详情，提取 Wiki URL
  const t = await getMeegleToken();
  const res = await axios.post(
    'https://project.feishu.cn/open_api/aniwonder/work_item/story/query',
    { work_item_ids: [parseInt(ctx.workItemId, 10)], expand: { need_workflow: true } },
    { headers: { 'X-Plugin-Token': t, 'X-User-Key': projectConfig.userKey } }
  );

  const item = (res.data.data || [])[0] || {};
  const fields = item.fields || [];

  // 查找包含 wiki URL 的字段
  for (const f of fields) {
    const v = f.field_value as string;
    if (v && typeof v === 'string' && v.includes('feishu.cn/wiki/')) {
      const text = await readWikiByUrl(v);
      if (text) return text;
      // needAuth — 返回特殊标记，由上层处理
      return '__NEED_AUTH__';
    }
  }
  return '';
}

async function readWikiByUrl(url: string): Promise<string | null> {
  const match = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (!match) return null;
  const token = await getWikiAccessToken();
  if (!token) return null;

  const nodeRes = await axios.get(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${match[1]}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const docId = nodeRes.data.data?.node?.obj_token || nodeRes.data.data?.node_token;
  if (!docId) return null;

  // 优先 raw_content
  const rawRes = await axios.get(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/raw_content`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const raw = rawRes.data.data?.content || '';
  if (raw.trim()) return raw;

  // Fallback: blocks API
  const blockRes = await axios.get(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks?page_size=500`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const items = blockRes.data.data?.items || [];
  return items.map((item: Record<string, unknown>) => {
    const text = item.text as Record<string, unknown> | undefined;
    return ((text?.elements as Array<Record<string, unknown>>) || [])
      .map((e: Record<string, unknown>) => {
        const run = e.text_run as Record<string, unknown> | undefined;
        return (run?.content as string) || '';
      }).join('');
  }).join('\n');
}

let meegleToken: string | null = null;
async function getMeegleToken(): Promise<string> {
  if (meegleToken) return meegleToken;
  const res = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: projectConfig.pluginId,
    plugin_secret: projectConfig.pluginSecret,
    type: 1,
  });
  meegleToken = res.data.data.token as string;
  return meegleToken as string;
}

export const wikiReadTool: ToolHandler = {
  id: 'wiki:read',
  description: '从飞书项目工作项提取 Wiki PRD 内容',
  execute,
};
