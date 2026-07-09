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
    on: 'after_create' | 'after_node_completed' | 'version_node_completed' | 'version_progress';
    workItemType?: string;
    previousNode?: string;
    completedNode?: string;
    deviationThreshold?: number;
  };
  nodeDurations?: Record<string, number>;
  targetNode: string;
  timeoutMinutes: number;
  remind: {
    target: string;           // "需求提出者" | "节点负责人"
    fallbackUserKey: string;  // 备选人 user_key（飞书项目双击头像获取）
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
const STATE_FILE = path.resolve(__dirname, '../../output/reminder-state.json');
const TICK_HOURS = [10, 16]; // 每天 10:30 和 16:00 检查
const TICK_MINUTE = 30;
const WINDOW_MINUTES = 5;    // ±5 分钟窗口

interface ReminderState {
  [key: string]: number;  // "ruleId::itemId" → 上次提醒时间戳
}

class TimeWheel {
  private rules: ReminderRule[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickDay = ''; // 防止同一天同一窗口重复 tick

  /** 加载规则配置 */
  loadRules(): void {
    try {
      if (!fs.existsSync(RULES_FILE)) return;
      const config: ReminderRulesConfig = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
      const enabled: ReminderRule[] = [];
      for (const r of config.rules) {
        if (!r.enabled) continue;
        // 校验 after_node_completed 必须指定 previousNode
        if (r.trigger.on === 'after_node_completed' && !r.trigger.previousNode) {
          console.error(`[TimeWheel] ${r.id}: after_node_completed 缺少 previousNode，跳过`);
          continue;
        }
        enabled.push(r);
      }
      this.rules = enabled;
      console.log(`[TimeWheel] 已加载 ${this.rules.length} 条提醒规则`);
    } catch (e) { console.error('[TimeWheel] 规则加载失败:', e); }
  }

  /** 启动时间轮：每分钟检查是否到了提醒时间窗口 */
  start(): void {
    this.loadRules();
    this.timer = setInterval(() => {
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      const day = now.toDateString();

      // 检查是否在 10:30 或 16:00 的 ±5 分钟窗口内
      const inWindow = TICK_HOURS.some(th =>
        h === th && m >= TICK_MINUTE - WINDOW_MINUTES && m <= TICK_MINUTE + WINDOW_MINUTES
      );

      if (inWindow) {
        const slotKey = `${day}-${h}:${TICK_MINUTE}`;
        if (this.lastTickDay === slotKey) return; // 同一窗口已经执行过
        this.lastTickDay = slotKey;
        console.log(`[TimeWheel] ⏰ 定时提醒窗口 ${h}:${TICK_MINUTE}`);
        this.tick();
      }
    }, 60 * 1000); // 每分钟检查一次
    console.log(`[TimeWheel] 已启动, 提醒时间: 每天 ${TICK_HOURS.join(':30 / ')}:30`);
  }

  /** 停止时间轮 */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 执行一次完整检查（供手动触发，不受时间窗口限制） */
  async runOnce(): Promise<{ totalRules: number; remindersSent: number }> {
    this.loadRules();
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
    this.loadRules(); // 每次 tick 重新读规则，支持热更新
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      try { await this.checkRule(rule); }
      catch (e) { /* 单条失败不影响其他规则 */ }
    }
  }

  // ==================== 规则检查 ====================

  private async checkRule(rule: ReminderRule): Promise<number> {
    // 版本管理规则 — 由 handler 统一处理，不逐 item 检查
    if (rule.trigger.on === 'version_node_completed' || rule.trigger.on === 'version_progress') {
      const state = this.loadState();
      const stateKey = `${rule.id}::version`;
      const lastRun = state[stateKey] || 0;
      // version_node_completed 只执行一次（通过 state 持久化去重）
      // version_progress 每次 tick 都检查
      if (rule.trigger.on === 'version_progress' || Date.now() - lastRun > 7 * 24 * 60 * 60 * 1000) {
        await this.handleVersionRule(rule);
        state[stateKey] = Date.now();
        this.saveState(state);
        return 1;
      }
      return 0;
    }

    const items = await this.fetchWorkItems(rule);
    const state = this.loadState();
    let sent = 0;

    for (const item of items) {
      if (!item.workflow_nodes) continue;

      const stateKey = `${rule.id}::${item.id}`;
      const lastReminded = state[stateKey] || 0;
      if (Date.now() - lastReminded < 24 * 60 * 60 * 1000) continue;

      const isOverdue = rule.trigger.on === 'after_create'
        ? this.checkAfterCreate(item, rule)
        : this.checkAfterNodeCompleted(item, rule);

      if (isOverdue) {
        await this.sendReminder(item, rule);
        state[stateKey] = Date.now();
        sent++;
      } else if (this.isCompleted(item, rule.targetNode)) {
        delete state[stateKey];
      }
    }

    if (sent > 0) console.log(`[TimeWheel] ${rule.id}: ${sent} 条超时提醒`);
    this.saveState(state);
    return sent;
  }

  /** 检查目标节点是否已完成 */
  private isCompleted(item: WorkItem, nodeName: string): boolean {
    const node = item.workflow_nodes?.find(n => n.name === nodeName);
    return node ? node.status === 3 && !!node.actual_finish_time : false;
  }

  /** 加载提醒状态 */
  private loadState(): ReminderState {
    try {
      if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch { /* ignore */ }
    return {};
  }

  /** 保存提醒状态 */
  private saveState(state: ReminderState): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 清理超过 7 天的记录
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [k, ts] of Object.entries(state)) {
        if (ts < cutoff) delete state[k];
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch { /* ignore */ }
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
    const typeKey = rule.trigger.workItemType
      ? await this.resolveTypeKey(rule.trigger.workItemType)
      : 'story';

    // 翻页查询全部工作项
    let allItems: { id: string }[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await axios.post(
        `https://project.feishu.cn/open_api/${projectConfig.spaceKey}/work_item/filter`,
        { work_item_type_keys: [typeKey], page_size: 50, page_num: page },
        { headers: H }
      );
      const data = res.data.data || [];
      allItems.push(...data);
      if (data.length < 50) break; // 最后一页
    }

    if (allItems.length === 0) return [];

    // 批量查询详情（含 workflow_nodes），每批最多 50 个
    const ids = allItems.map(i => parseInt(i.id, 10));
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
    if (!found) console.warn(`[TimeWheel] 类型名 "${typeName}" 未匹配，降级为 story`);
    return found ? found.type_key : 'story';
  }

  // ==================== 版本规则处理 ====================

  private async handleVersionRule(rule: ReminderRule): Promise<void> {
    try {
      const { runHeadcount, runScheduleNotice, checkProgressDeviation } = require('../../skills/version-manager/handler');
      const { feishuApp } = await import('../config');
      const { default: axios } = await import('axios');

      const t = await (async () => {
        const r = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
          { app_id: feishuApp.appId, app_secret: feishuApp.appSecret });
        return r.data.tenant_access_token as string;
      })();
      const H = { Authorization: `Bearer ${t}` };

      if (rule.trigger.on === 'version_node_completed') {
        // 人力盘点 + 排期通知（一次性）
        const [headcount, schedule] = await Promise.all([runHeadcount(), runScheduleNotice()]);
        // 上传为飞书文档
        for (const [title, content] of [['版本人力盘点报告', headcount], ['版本排期通知', schedule]]) {
          try {
            const docUrl = await this.uploadAsDoc(title, content, H);
            await this.notifyUser(rule, docUrl, title, H);
          } catch (e) { console.error(`[TimeWheel] ${title} 上传失败:`, e); }
        }
      } else if (rule.trigger.on === 'version_progress') {
        const nodeDurations = rule.nodeDurations || {};
        const report = await checkProgressDeviation(nodeDurations);
        if (report) {
          const docUrl = await this.uploadAsDoc('版本进度偏离报告', report, H);
          await this.notifyUser(rule, docUrl, '版本进度偏离报告', H);
        }
      }
    } catch (e) { console.error('[TimeWheel] 版本规则执行失败:', e); }
  }

  private async uploadAsDoc(title: string, content: string, H: Record<string, string>): Promise<string> {
    const fs = await import('fs'); const path = await import('path');
    const FormData = (await import('form-data')).default;
    const OUTPUT_DIR = path.resolve(__dirname, '../../output');
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const fileName = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    const axios = await import('axios');

    try {
      const fd = new FormData();
      fd.append('file_name', fileName);
      fd.append('parent_type', 'explorer');
      fd.append('parent_node', '');
      fd.append('size', String(fs.statSync(filePath).size));
      fd.append('file', fs.createReadStream(filePath));
      const u = await axios.default.post('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', fd, {
        headers: { ...H, ...fd.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity,
      });
      const fileToken = u.data.data?.file_token;
      if (fileToken) return `https://p1iscu6mj28.feishu.cn/file/${fileToken}`;
    } catch (e) { /* fallback */ }

    const cr = await axios.default.post('https://open.feishu.cn/open-apis/docx/v1/documents', { title }, { headers: H });
    return `https://p1iscu6mj28.feishu.cn/docx/${cr.data.data.document.document_id}`;
  }

  private async notifyUser(rule: ReminderRule, docUrl: string, title: string, H: Record<string, string>): Promise<void> {
    const openId = rule.remind.fallbackUserKey
      ? await resolveUserKey(rule.remind.fallbackUserKey)
      : null;
    if (!openId) { console.log(`[TimeWheel] 版本通知无接收人`); return; }
    const axios = await import('axios');
    await axios.default.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      receive_id: openId, msg_type: 'interactive',
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: { title: { content: `📄 ${title}`, tag: 'plain_text' }, template: 'blue' },
        elements: [
          { tag: 'markdown', content: `**版本管理报告**已生成。\n\n👉 [点击查看](${docUrl})` },
          { tag: 'hr' }, { tag: 'note', elements: [{ tag: 'plain_text', content: '🤖 智小协自动生成' }] },
        ],
      }),
    }, { headers: H, timeout: 10000 }).catch((e: unknown) => console.error('[TimeWheel] 通知发送失败'));
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

    // 备选：从 user_key 解析（飞书项目双击头像获取）
    if (rule.remind.fallbackUserKey) {
      return resolveUserKey(rule.remind.fallbackUserKey);
    }

    return null;
  }
}

// ==================== 单例 ====================

export const timeWheel = new TimeWheel();

// ==================== Token 工具 ====================

let meegleToken: string | null = null;
async function getMeegleToken(): Promise<string> {
  try {
    if (meegleToken) return meegleToken;
  } catch { meegleToken = null; }
  const res = await axios.post('https://project.feishu.cn/open_api/authen/plugin_token', {
    plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1,
  });
  meegleToken = res.data.data.token as string;
  return meegleToken as string;
}

let tenantToken: string | null = null;
async function getTenantToken(): Promise<string> {
  try {
    if (tenantToken) return tenantToken;
  } catch { tenantToken = null; }
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
      const t = await getTenantToken();
      const sr = await axios.get(
        `https://open.feishu.cn/open-apis/contact/v3/users?page_size=3&name=${encodeURIComponent(name)}`,
        { headers: { Authorization: `Bearer ${t}` } }
      );
      const items = sr.data.data?.items || [];
      return items[0]?.open_id || null;
    }
  } catch { /* skip */ }

  return null;
}
