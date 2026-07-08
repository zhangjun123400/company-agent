/**
 * 配置管理
 * 统一从 config/config.env 加载所有平台凭据和参数
 * 修改 config/config.env 后重启服务即可生效
 */
import dotenv from 'dotenv';
import path from 'path';

// 加载 config/config.env（集中配置）
dotenv.config({ path: path.resolve(__dirname, '../config/config.env') });
dotenv.config({ path: path.resolve(__dirname, '../config/.env') }); // 兼容旧文件

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少必需配置: ${key}，请在 config.env 中设置`);
  }
  return value;
}
function optionalEnv(key: string, defaultValue = ''): string {
  return process.env[key] || defaultValue;
}

// ==================== 飞书项目平台 ====================

export const projectConfig = {
  pluginId: requireEnv('FEISHU_PROJECT_PLUGIN_ID'),
  pluginSecret: requireEnv('FEISHU_PROJECT_PLUGIN_SECRET'),
  userKey: optionalEnv('FEISHU_PROJECT_USER_KEY'),
  apiBase: optionalEnv('FEISHU_PROJECT_API_BASE', 'https://project.feishu.cn/open_api'),
  spaceKey: optionalEnv('PROJECT_SPACE_KEY', 'aniwonder'),
  spaceId: optionalEnv('PROJECT_SPACE_ID'),
  prdReviewTimeoutDays: parseInt(process.env.PRD_REVIEW_TIMEOUT_DAYS || '3', 10),
};

// ==================== 飞书 IM + 文档（智小协机器人） ====================

export const feishuApp = {
  appId: requireEnv('FEISHU_APP_ID'),
  appSecret: requireEnv('FEISHU_APP_SECRET'),
};

// ==================== 大模型 ====================

export const aiModel = optionalEnv('AI_MODEL', 'deepseek');
export const deepseekApiKey = optionalEnv('DEEPSEEK_API_KEY');
export const deepseekBaseUrl = optionalEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com');

// ==================== 定时任务 ====================

export const checkCron = optionalEnv('CHECK_CRON', '0 9 * * *');

// ==================== API 端点常量 ====================

export const PLUGIN_TOKEN_URL = 'https://project.feishu.cn/open_api/authen/plugin_token';
export const FEISHU_IM_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
export const projectApi = (p: string) => `${projectConfig.apiBase}${p}`;
