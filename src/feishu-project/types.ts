/**
 * 飞书项目 (Meegle) API 类型定义
 *
 * 注意：Meegle API 的字段命名可能与飞书开放平台不同
 * 使用 snake_case，部分字段名有差异
 */

// === API 响应 ===

export interface MeegleApiResponse<T> {
  code: number;
  msg: string;
  data: T;
}

// === 工作项 ===

export interface WorkItem {
  /** 工作项 ID (Meegle 内部 ID) */
  id: string;
  /** 工作项名称 */
  name: string;
  /** 工作项类型 ID */
  work_item_type_id?: string;
  /** 工作项类型名称 */
  work_item_type_name?: string;
  /** 所属空间 ID */
  space_id?: string;
  /** 状态 */
  status?: string;
  /** 状态名称 */
  status_name?: string;
  /** 创建时间 */
  created_at?: string;
  /** 更新时间 */
  updated_at?: string;
  /** 创建人 */
  creator_id?: string;
  /** 负责人 */
  owner_id?: string;
  /** 自定义字段 */
  fields?: Record<string, unknown>;
  /** 当前节点信息 */
  current_node?: WorkflowNode;
  /** 描述 */
  description?: string;
}

export interface WorkItemSearchParams {
  space_id?: string;
  work_item_type_id?: string;
  status?: string | string[];
  creator_id?: string;
  owner_id?: string;
  keyword?: string;
  /** 页码（从1开始） */
  page?: number;
  page_size?: number;
}

export interface WorkItemSearchResult {
  work_items: WorkItem[];
  total?: number;
}

// === 附件 ===

export interface Attachment {
  /** 附件 ID */
  id: string;
  /** 原 file_token，Meegle 中可能是 id */
  file_token?: string;
  /** 文件名 */
  file_name: string;
  /** 文件大小（字节） */
  file_size: number;
  /** 文件类型 */
  file_type?: string;
  /** 上传时间 */
  upload_time?: string;
  created_at?: string;
  /** 上传者 */
  uploader_id?: string;
  /** 下载 URL */
  download_url?: string;
}

// === 评论 ===

export interface Comment {
  id: string;
  content: string;
  creator_id: string;
  created_at: string;
  updated_at?: string;
}

// === 节点 ===

export interface WorkflowNode {
  id: string;
  name: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'blocked';
  assignee_id?: string;
  started_at?: string;
  completed_at?: string;
  children?: WorkflowNode[];
}

// === 工作项类型 ===

export interface WorkItemType {
  id: string;
  name: string;
  states?: WorkItemState[];
}

export interface WorkItemState {
  id: string;
  name: string;
}

// === 空间 ===

export interface Space {
  id: string;
  key?: string;
  name: string;
}

// === 智能体报告 ===

/** 能力2 产出 */
export interface TechFeasibilityReport {
  title: string;
  generatedAt: string;
  workItemId: string;
  prdSummary: string;
  conclusion: '可行' | '需进一步评估' | '存在重大风险' | '不可行';
  confidence: number;
  challenges: TechChallenge[];
  recommendedApproach: TechApproach;
  alternatives: TechApproach[];
  references: string[];
  risks: TechRisk[];
  draftPlan: string;
}

export interface TechChallenge {
  area: string;
  description: string;
  severity: '低' | '中' | '高' | '严重';
  mitigation: string;
}

export interface TechApproach {
  name: string;
  description: string;
  pros: string[];
  cons: string[];
  estimatedEffort: string;
  techStack: string[];
}

export interface TechRisk {
  category: string;
  description: string;
  probability: '低' | '中' | '高';
  impact: '低' | '中' | '高';
  mitigation: string;
}

/** 能力3 产出 */
export interface ClarificationQuestions {
  title: string;
  generatedAt: string;
  workItemId: string;
  totalQuestions: number;
  categories: QuestionCategory[];
  overallAssessment: string;
}

export interface QuestionCategory {
  name: string;
  questions: ClarificationQuestion[];
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  context: string;
  suggestion?: string;
  priority: '高' | '中' | '低';
}

/** 能力1 产出 */
export interface OverdueReminderResult {
  workItemId: string;
  workItemName: string;
  prdUploadTime: string;
  daysSinceUpload: number;
  currentNode: string;
  currentNodeStatus: string;
  shouldRemind: boolean;
  reminderMessage: string;
  reminderSent: boolean;
}
