/**
 * 配置管理
 * 从环境变量加载，区分飞书项目 API 和飞书 IM 两套凭据
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少必需的环境变量: ${key}，请在 .env 文件中配置`);
  }
  return value;
}

function optionalEnv(key: string): string {
  return process.env[key] || '';
}

// ==================== 飞书项目 (Meegle) API ====================

export const projectConfig = {
  /** 插件 ID */
  pluginId: requireEnv('FEISHU_PROJECT_PLUGIN_ID'),
  /** 插件 Secret */
  pluginSecret: requireEnv('FEISHU_PROJECT_PLUGIN_SECRET'),
  /** 用户标识（可选） */
  userKey: optionalEnv('FEISHU_PROJECT_USER_KEY'),
  /** API 基础路径 */
  apiBase: optionalEnv('FEISHU_PROJECT_API_BASE') || 'https://project.feishu.cn/open_api',
  /** 空间 Key（URL 中的标识） */
  spaceKey: optionalEnv('PROJECT_SPACE_KEY') || 'aniwonder',
  /** 空间 ID（可选，会自动查询） */
  spaceId: optionalEnv('PROJECT_SPACE_ID'),
  /** PRD 未评审超时天数 */
  prdReviewTimeoutDays: parseInt(process.env.PRD_REVIEW_TIMEOUT_DAYS || '3', 10),
};

// ==================== 飞书 IM（可选，用于发送群消息） ====================

export const imConfig = {
  enabled: !!(process.env.FEISHU_IM_APP_ID && process.env.FEISHU_IM_APP_SECRET),
  appId: optionalEnv('FEISHU_IM_APP_ID'),
  appSecret: optionalEnv('FEISHU_IM_APP_SECRET'),
  chatId: optionalEnv('FEISHU_IM_CHAT_ID'),
};

// ==================== Claude API ====================

export const anthropicApiKey = optionalEnv('ANTHROPIC_API_KEY');

// ==================== 定时任务 ====================

export const checkCron = optionalEnv('CHECK_CRON') || '0 9 * * *';

// ==================== API 端点常量 ====================

/** 飞书项目 token 端点 */
export const PLUGIN_TOKEN_URL = 'https://project.feishu.cn/open_api/authen/plugin_token';

/** 飞书 IM token 端点 */
export const FEISHU_IM_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

/** 构建飞书项目 API URL */
export const projectApi = (path: string): string =>
  `${projectConfig.apiBase}${path}`;
