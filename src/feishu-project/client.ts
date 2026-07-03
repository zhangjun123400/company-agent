/**
 * 飞书项目 (Meegle) API 客户端
 *
 * 基于 meeglesdk 官方 SDK，所有 API 路径和鉴权由 SDK 管理。
 * 封装为内部统一接口，简化调用。
 *
 * 关键：飞书项目所有 API 都需要 user_key（用户身份）。
 * 首次使用需要通过 OAuth 授权获取 user_key。
 */
import axios from 'axios';
import { projectConfig, PLUGIN_TOKEN_URL } from '../config';

// ==================== Token 管理 ====================

interface PluginToken {
  token: string;
  expireAt: number;
}

let pluginToken: PluginToken | null = null;

/** 获取或刷新 plugin_access_token */
async function getPluginToken(): Promise<string> {
  if (pluginToken && Date.now() < pluginToken.expireAt - 300_000) {
    return pluginToken.token;
  }

  const res = await axios.post(PLUGIN_TOKEN_URL, {
    plugin_id: projectConfig.pluginId,
    plugin_secret: projectConfig.pluginSecret,
    type: 1, // virtual_plugin_token — 作为插件身份调用 API
  });

  if (res.data.error?.code !== 0) {
    throw new Error(`获取 plugin_token 失败: ${res.data.error?.msg}`);
  }

  pluginToken = {
    token: res.data.data.token,
    expireAt: Date.now() + res.data.data.expire_time * 1000,
  };

  return pluginToken.token;
}

/** 构建 API 请求头 */
async function getHeaders(): Promise<Record<string, string>> {
  const token = await getPluginToken();
  const headers: Record<string, string> = {
    'X-Plugin-Token': token,
    'Content-Type': 'application/json; charset=utf-8',
  };
  // 必须带上 user_key
  if (projectConfig.userKey) {
    headers['X-User-Key'] = projectConfig.userKey;
  }
  return headers;
}

// ==================== OAuth 获取 user_key ====================

/**
 * 通过授权码换取 user_key 和 user_access_token
 *
 * 流程：前端在飞书项目页面调用 window.JSSDK.utils.getAuthCode() 获取 code，
 * 传给后端此函数换取 user_key。
 */
export async function exchangeCodeForUserKey(code: string): Promise<{
  userKey: string;
  userToken: string;
  refreshToken: string;
  expireTime: number;
}> {
  const token = await getPluginToken();
  const res = await axios.post(
    `https://project.feishu.cn/open_api/authen/user_plugin_token`,
    { code, grant_type: 'authorization_code' },
    { headers: { 'X-Plugin-Token': token, 'Content-Type': 'application/json' } }
  );

  if (res.data.error?.code !== 0) {
    throw new Error(`OAuth 授权失败: ${res.data.error?.msg}`);
  }

  return {
    userKey: res.data.data.user_key,
    userToken: res.data.data.token,
    refreshToken: res.data.data.refresh_token,
    expireTime: res.data.data.expire_time,
  };
}

// ==================== API 封装 ====================

const BASE = 'https://project.feishu.cn';

function apiPath(path: string, params: Record<string, string>): string {
  let result = path;
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(`:${key}`, encodeURIComponent(value));
  }
  return result;
}

async function get<T>(path: string, pathParams: Record<string, string> = {}): Promise<T> {
  const headers = await getHeaders();
  const url = apiPath(path, { project_key: projectConfig.spaceKey, ...pathParams });
  const res = await axios.get(`${BASE}${url}`, { headers });
  if (res.data.err_code !== 0) throw new Error(`API错误 [${res.data.err_code}]: ${res.data.err_msg}`);
  return res.data.data as T;
}

async function post<T>(
  path: string,
  body: unknown,
  pathParams: Record<string, string> = {}
): Promise<T> {
  const headers = await getHeaders();
  const url = apiPath(path, { project_key: projectConfig.spaceKey, ...pathParams });
  const res = await axios.post(`${BASE}${url}`, body, { headers });
  if (res.data.err_code !== 0) throw new Error(`API错误 [${res.data.err_code}]: ${res.data.err_msg}`);
  return res.data.data as T;
}

// ==================== 空间 & 工作项类型 ====================

export interface WorkItemTypeInfo {
  type_key: string;
  name: string;
  id?: string;
}

/** 获取空间下工作项类型 */
export async function getWorkItemTypes(): Promise<WorkItemTypeInfo[]> {
  return get('/open_api/:project_key/work_item/all-types');
}

// ==================== 工作项 ====================

export interface MeegleWorkItem {
  id: string;
  name: string;
  work_item_type_key?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  creator?: { user_key?: string; name?: string };
  owner?: { user_key?: string; name?: string };
  field_values?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FilterResult {
  data: MeegleWorkItem[];
  pagination: { total: number; page_size: number; page_num: number; has_next: boolean };
}

/** 过滤/搜索工作项 */
export async function filterWorkItems(params: {
  work_item_type_keys?: string[];
  work_item_ids?: string[];
  work_item_name?: string;
  page_size?: number;
  page_num?: number;
  status?: string | string[];
  [key: string]: unknown;
}): Promise<FilterResult> {
  return post('/open_api/:project_key/work_item/filter', params);
}

/** 获取所有工作项（自动翻页） */
export async function getAllWorkItems(
  workItemTypeKey: string,
  maxPages = 20
): Promise<MeegleWorkItem[]> {
  const all: MeegleWorkItem[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await filterWorkItems({
      work_item_type_keys: [workItemTypeKey],
      page_size: 50,
      page_num: page,
    });
    all.push(...result.data);
    if (!result.pagination.has_next) break;
  }
  return all;
}

// ==================== 评论 ====================

export interface MeegleComment {
  id: string;
  content: string;
  creator?: { user_key?: string; name?: string };
  created_at?: string;
}

/** 获取评论列表 */
export async function getComments(
  workItemTypeKey: string,
  workItemId: string
): Promise<MeegleComment[]> {
  return get(`/open_api/:project_key/work_item/:work_item_type_key/:work_item_id/comments`, {
    work_item_type_key: workItemTypeKey,
    work_item_id: workItemId,
  });
}

/** 添加评论 */
export async function addComment(
  workItemTypeKey: string,
  workItemId: string,
  content: string
): Promise<string> {
  return post(
    `/open_api/:project_key/work_item/:work_item_type_key/:work_item_id/comment/create`,
    { content },
    { work_item_type_key: workItemTypeKey, work_item_id: workItemId }
  );
}

// ==================== 附件 ====================

/** 下载附件 */
export async function downloadAttachment(
  workItemTypeKey: string,
  workItemId: string,
  uuid: string
): Promise<Buffer> {
  const headers = await getHeaders();
  const url = apiPath(
    `/open_api/:project_key/work_item/:work_item_type_key/:work_item_id/file/download`,
    { project_key: projectConfig.spaceKey, work_item_type_key: workItemTypeKey, work_item_id: workItemId }
  );
  const res = await axios.post(`${BASE}${url}`, { uuid }, { headers, responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ==================== 查询工作项详情 ====================

/** 查询工作项详情（通过 query API，支持 expand） */
export async function queryWorkItems(
  workItemTypeKey: string,
  workItemIds: string[],
  expand?: Record<string, boolean>
): Promise<MeegleWorkItem[]> {
  return post(
    `/open_api/:project_key/work_item/:work_item_type_key/query`,
    {
      work_item_ids: workItemIds,
      expand: expand || { need_workflow: true },
    },
    { work_item_type_key: workItemTypeKey }
  );
}

/** 获取单个工作项 */
export async function getWorkItem(
  workItemTypeKey: string,
  workItemId: string
): Promise<MeegleWorkItem | null> {
  const items = await queryWorkItems(workItemTypeKey, [workItemId]);
  return items[0] || null;
}

// ==================== 健康检查 ====================

/**
 * 测试连接：获取工作项类型列表
 */
export async function testConnection(): Promise<{ ok: boolean; types: string[]; error?: string }> {
  try {
    if (!projectConfig.userKey) {
      return { ok: false, types: [], error: '缺少 user_key，请先通过 OAuth 授权或手动填入 .env' };
    }
    const types = await getWorkItemTypes();
    return { ok: true, types: types.map((t) => `${t.name}(${t.type_key})`) };
  } catch (error) {
    return { ok: false, types: [], error: String(error) };
  }
}
