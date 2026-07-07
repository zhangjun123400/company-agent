/**
 * 文档模板引擎
 *
 * 每个智能体有自己的输出模板，存放在 agents/<智能体名>/ 目录下
 * 模板文件可以是任意 .md 文件名（如"具身智能软件需求澄清清单.md"）
 * 引擎自动检测目录下第一个非 agent.json 的 .md 文件
 * 每次使用时从磁盘读取（天然热加载，无需重启）
 */
import fs from 'fs';
import path from 'path';

const AGENTS_DIR = path.resolve(__dirname, '../../agents');

/** 查找 Agent 目录下的模板文件 */
function findTemplate(agentName: string): string | null {
  const dir = path.join(AGENTS_DIR, agentName);
  if (!fs.existsSync(dir)) return null;
  try {
    const files = fs.readdirSync(dir);
    const tmpl = files.find(f => f.endsWith('.md') && f !== 'agent.json');
    return tmpl ? path.join(dir, tmpl) : null;
  } catch { return null; }
}

/**
 * 按智能体名称加载模板并替换占位符
 * @returns 替换后的文本，无模板时返回 null
 */
export function applyTemplate(
  agentName: string,
  vars: Record<string, string>
): string | null {
  const templatePath = findTemplate(agentName);
  if (!templatePath) {
    console.warn(`[Template] ${agentName} 目录下无模板文件`);
    return null;
  }

  // 每次从磁盘读取（天然热加载）
  let template = fs.readFileSync(templatePath, 'utf-8');

  for (const [key, value] of Object.entries(vars)) {
    template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }

  return template;
}
