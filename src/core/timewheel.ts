/**
 * 时间轮提醒基座
 *
 * 加载 config/reminder-rules.json → 定时 tick → 查询飞书项目节点状态
 * → 发现超时 → 发送飞书 IM 提醒
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { projectConfig, feishuApp } from '../config';

// ==================== 类型 ====================

interface ReminderRule {
  id: string;
  name: string;
  description: string;
  trigger: {
    on: 'after_create' | 'after_node_completed';
    workItemType?: string;
    previousNode?: string;
  };
  targetNode: string;
  timeoutMinutes: number;
  remind: {
    target: string;        // "需求提出者" | "节点负责人"
    fallbackName: string;  // 备选人
  };
  enabled: boolean;
}

interface ReminderRulesConfig {
  rules: ReminderRule[];
}

interface WorkflowNode {
  name: string;
  status: number;          // 1=未开始 2=进行中 3=已完成
  actual_begin_time: string;
  actual_finish_time: string;
  role_assignee?: { role: string; owners: string[]; exist: boolean }[];
}

interface WorkItem {
  id: string;
  name: string;
  created_at?: string;
  creator?: string;
  workflow_nodes?: WorkflowNode[];
  current_nodes?: { name: string; owners?: string[] }[];
}

// ==================== 时间轮 ====================

const RULES_FILE = path.resolve(__dirname, '../../config/reminder-rules.json');
const TICK_MS = 30 * 60 * 1000; // 30 分钟 tick 一次

class TimeWheel {
  private rules: ReminderRule[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 加载规则配置 */
  loadRules(): void {
    try {
      if (!fs.existsSync(RULES_FILE)) return;
      const config: ReminderRulesConfig = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
      this.rules = config.rules.filter(r => r.enabled);
      console.log(`[TimeWheel] 已加载 ${this.rules.length} 条提醒规则`);
    } catch (e) { console.error('[TimeWheel] 规则加载失败:', e); }
  }

  /** 启动时间轮 */
  start(): void {
    this.loadRules();
    this.tick(); // 启动时立即执行一次
    this.timer = setInterval(() => this.tick(), TICK_MS);
    console.log(`[TimeWheel] 已启动, tick 间隔 ${TICK_MS / 60000} 分钟`);
  }

  /** 停止时间轮 */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 执行一次完整检查（供手动触发） */
  async runOnce(): Promise<{ totalRules: number; remindersSent: number }> {
    this.loadRules(); // 重新读规则，支持热更新
    let remindersSent = 0;
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      try {
        remindersSent += await this.checkRule(rule);
      } catch (e) { console.error(`[TimeWheel] ${rule.id} 检查失败:`, e); }
    }
    console.log(`[TimeWheel] 手动检查完成: ${this.rules.length} 条规则, ${remindersSent} 条提醒`);
    return { totalRules: this.rules.length, remindersSent };
  }

  /** 定时 tick */
  private async tick(): Promise<void> {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      try { await this.checkRule(rule); }
      catch (e) { /* 单条失败不影响其他规则 */ }
    }
  }

  // ==================== 规则检查 ====================

  private async checkRule(rule: ReminderRule): Promise<number> {
    const items = await this.fetchWorkItems(rule);
    let sent = 0;

    for (const item of items) {
      if (!item.workflow_nodes) continue;

      const isOverdue = rule.trigger.on === 'after_create'
        ? this.checkAfterCreate(item, rule)
        : this.checkAfterNodeCompleted(item, rule);

      if (isOverdue) {
        await this.sendReminder(item, rule);
        sent++;
      }
    }

    if (sent > 0) console.log(`[TimeWheel] ${rule.id}: ${sent} 条超时提醒`);
    return sent;
  }

  /** 规则类型 A: 工作项创建后 N 分钟未完成目标节点 */
  private checkAfterCreate(item: WorkItem, rule: ReminderRule): boolean {
    const target = item.workflow_nodes!.find(n => n.name === rule.targetNode);
    if (!target) return false;

    // 节点正在进行中（status=2）且未完成
    if (target.status !== 2 || target.actual_finish_time) return false;

    // 从节点开始时间计算超时
    const begin = target.actual_begin_time ? new Date(target.actual_begin_time).getTime() : 0;
    if (!begin) return false;

    return Date.now() - begin > rule.timeoutMinutes * 60 * 1000;
  }

  /** 规则类型 B: 上一节点完成后 N 分钟未完成目标节点 */
  private checkAfterNodeCompleted(item: WorkItem, rule: ReminderRule): boolean {
    const prevNodeName = rule.trigger.previousNode;
    const prev = item.workflow_nodes!.find(n => n.name === prevNodeName);
    const target = item.workflow_nodes!.find(n => n.name === rule.targetNode);

    // 上一节点必须已完成（status=3）
    if (!prev || prev.status !== 3) return false;
    // 目标节点正在进行中且未完成
    if (!target || target.status !== 2 || target.actual_finish_time) return false;

    const begin = target.actual_begin_time ? new Date(target.actual_begin_time).getTime() : 0;
    if (!begin) return false;

    return Date.now() - begin > rule.timeoutMinutes * 60 * 1000;
  }

  // ==================== 数据获取 ====================

  private async fetchWorkItems(rule: ReminderRule): Promise<WorkItem[]> {
    const t = await getMeegleToken();
    const H = { 'X-Plugin-Token': t, 'X-User-Key': projectConfig.userKey };

    // 查询指定类型的工作项
    const res = await axios.post(
      `https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/filter`,
      {
        work_item_type_keys: rule.trigger.workItemType ? [ await this.resolveTypeKey(rule.trigger.workItemType) ] : ['story'],
        page_size: 50, page_num: 1,
      },
      { headers: H }
    );

    const items = res.data.data || [];
    if (items.length === 0) return [];

    // 批量查询详情（含 workflow_nodes）
    const ids = items.map((i: { id: string }) => parseInt(i.id, 10));
    const detailRes = await axios.post(
      `https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/story/query`,
      { work_item_ids: ids, expand: { need_workflow: true } },
      { headers: H }
    );

    return (detailRes.data.data || []).map((item: Record<string, unknown>) => ({
      id: String(item.id || ''),
      name: (item.name as string) || '',
      creator: (item.created_by as string) || '',
      created_at: (item.created_at as string) || '',
      workflow_nodes: ((item.workflow_infos as Record<string, unknown>)?.workflow_nodes
        || (item as Record<string, unknown>).workflow_nodes
        || []) as WorkflowNode[],
      current_nodes: (item.current_nodes || []) as { name: string; owners?: string[] }[],
    }));
  }

  private async resolveTypeKey(typeName: string): Promise<string> {
    const t = await getMeegleToken();
    const H = { 'X-Plugin-Token': t, 'X-User-Key': projectConfig.userKey };
    const res = await axios.get(
      `https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/all-types`,
      { headers: H }
    );
    const types = res.data.data || [];
    const found = types.find((tp: { name: string; type_key: string }) => tp.name === typeName);
    return found ? found.type_key : 'story';
  }

  // ==================== 发送提醒 ====================

  private async sendReminder(item: WorkItem, rule: ReminderRule): Promise<void> {
    const openId = await this.resolveTarget(item, rule);
    if (!openId) { console.log(`[TimeWheel] ${rule.id}: ${item.name} 无法解析提醒对象`); return; }

    const t = await getTenantToken();
    const text = [
      `⏰ **${rule.name}**`,
      ``,
      `需求：${item.name}`,
      `节点：${rule.targetNode}`,
      `超时：已超 ${rule.timeoutMinutes} 分钟`,
    ].join('\n');

    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
      { headers: { Authorization: `Bearer ${t}` }, timeout: 10000 }
    ).catch((e: unknown) => console.error(`[TimeWheel] 发送提醒失败:`, (e as Error).message));
  }

  /** 解析提醒对象为 open_id */
  private async resolveTarget(item: WorkItem, rule: ReminderRule): Promise<string | null> {
    if (rule.remind.target === '需求提出者' || rule.remind.target === '工作项创建者') {
      // creator 是 user_key，需要转为 open_id
      if (item.creator) return resolveUserKey(item.creator);
    }

    if (rule.remind.target === '节点负责人') {
      const targetNode = item.workflow_nodes?.find(n => n.name === rule.targetNode);
      const assignees = (targetNode as WorkflowNode)?.role_assignee || [];
      const owners = assignees.flatMap((a: { owners: string[] }) => a.owners).filter(Boolean);
      if (owners.length > 0) return resolveUserKey(owners[0]);
    }

    // 备选：按姓名搜索
    if (rule.remind.fallbackName) {
      return searchUserByName(rule.remind.fallbackName);
    }

    return null;
  }
}

// ==================== 单例 ====================

export const timeWheel = new TimeWheel();

// ==================== Token 工具 ====================

let meegleToken: string | null = null;
async function getMeegleToken(): Promise<string> {
  if (meegleToken) return meegleToken;
  const res = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1,
  });
  meegleToken = res.data.data.token as string;
  return meegleToken as string;
}

let tenantToken: string | null = null;
async function getTenantToken(): Promise<string> {
  if (tenantToken) return tenantToken;
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: feishuApp.appId, app_secret: feishuApp.appSecret,
  });
  tenantToken = res.data.tenant_access_token as string;
  return tenantToken as string;
}

// ==================== 用户解析 ====================
// 复用 auto-analyzer.ts 的硬编码缓存 + Meegle 用户名搜索兜底

const userCache: Record<string, string> = {
  '7649567855117192178': 'ou_8de837db0c63b31eaebbb465c18c9ea8',
};

async function resolveUserKey(userKey: string): Promise<string | null> {
  if (userCache[userKey]) return userCache[userKey];

  // Method 1: Contact API batch_get_id
  try {
    const t = await getTenantToken();
    const res = await axios.post(
      'https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id',
      { user_ids: [userKey], id_type: 'user_key' },
      { headers: { Authorization: `Bearer ${t}` } }
    );
    if (res.data.code === 0 && res.data.data?.user_list) {
      const id = res.data.data.user_list[0]?.user_id;
      if (id) { userCache[userKey] = id; return id; }
    }
  } catch { /* continue */ }

  // Method 2: Meegle user query → get name → contact search
  try {
    const mt = await getMeegleToken();
    const ur = await axios.post('https://project.feishu.cn/open_api/user/query',
      { user_keys: [userKey] },
      { headers: { 'X-Plugin-Token': mt, 'X-User-Key': projectConfig.userKey } }
    );
    const uArr = ur.data.data || [];
    const name = uArr[0]?.name?.zh_cn || uArr[0]?.name_cn || uArr[0]?.name?.default || '';
    if (name) {
      return searchUserByName(name);
    }
  } catch { /* skip */ }

  return null;
}

async function searchUserByName(name: string): Promise<string | null> {
  try {
    const t = await getTenantToken();
    const res = await axios.get(
      `https://open.feishu.cn/open-apis/contact/v3/users?page_size=3&name=${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${t}` } }
    );
    const items = res.data.data?.items || [];
    return items[0]?.open_id || null;
  } catch { return null; }
}
