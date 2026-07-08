/**
 * Agent 注册中心
 * 统一管理所有 Agent 配置，支持热加载（不停服务更新）
 */
import fs from 'fs';
import path from 'path';

const AGENTS_DIR = path.resolve(__dirname, '../../agents');
const REGISTRY_FILE = path.join(AGENTS_DIR, '_registry.json');

export interface AgentConfig {
  id: string;
  name: string;
  department: string;
  node: string;
  description: string;
  /** 系统提示词 — 定义智能体的身份、能力、行为规则 */
  prompt?: string;
  /** 技能列表 — 可自行新增，每项是自然语言描述的能力 */
  skills: string[];
  tools: string[];
  output: string;
  output_target: string[];
  enabled: boolean;
  timeout_ms: number;
  created_by?: string;
  created_at?: string;
}

class AgentRegistry {
  private agents: Map<string, AgentConfig> = new Map();
  private watcher: fs.FSWatcher | null = null;

  /** 启动时加载所有 Agent */
  loadAll(): void {
    this.agents.clear();
    try {
      const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
      for (const file of registry.agents || []) {
        try {
          const fullPath = path.join(AGENTS_DIR, file);
          let config: AgentConfig;

          if (file.endsWith('.md')) {
            config = this.parseSkillMd(fullPath);
          } else {
            config = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as AgentConfig;
          }

          if (config.enabled !== false) {
            this.agents.set(config.id, config);
            console.log(`[Registry] 加载: ${config.name} → 节点: ${config.node}`);
          }
        } catch (e) {
          console.error(`[Registry] 加载失败 ${file}:`, e);
        }
      }
    } catch (e) {
      console.error('[Registry] 加载注册表失败:', e);
    }
    console.log(`[Registry] 共加载 ${this.agents.size} 个 Agent`);
  }

  /** 解析 SKILL.md YAML frontmatter → AgentConfig */
  private parseSkillMd(filePath: string): AgentConfig {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parts = raw.split(/^---$/m);
    if (parts.length < 2) throw new Error('SKILL.md 缺少 YAML frontmatter');

    // 简单 YAML 解析（兼容顶层 key: value 和列表）
    const frontmatter = parts[1];
    const config: Record<string, unknown> = {};
    let currentKey = '';
    let inList = false;
    const listItems: string[] = [];

    for (const line of frontmatter.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (inList) {
        if (trimmed.startsWith('- ')) {
          listItems.push(trimmed.slice(2).trim());
          continue;
        }
        config[currentKey] = listItems.slice();
        inList = false;
        listItems.length = 0;
      }

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      currentKey = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      if (value === '') {
        inList = true;
      } else {
        // 尝试解析布尔和数字
        if (value === 'true') config[currentKey] = true;
        else if (value === 'false') config[currentKey] = false;
        else if (/^\d+$/.test(value)) config[currentKey] = parseInt(value, 10);
        else config[currentKey] = value;
      }
    }
    if (inList && listItems.length > 0) config[currentKey!] = listItems.slice();

    return {
      id: (config.id as string) || '',
      name: (config.name as string) || path.basename(path.dirname(filePath)),
      department: (config.department as string) || '',
      node: (config.node as string) || '',
      description: (config.description as string) || '',
      skills: (config.skills as string[]) || [],
      tools: (config.tools as string[]) || [],
      output: (config.output as string) || 'feishu_doc',
      output_target: (config.output_target as string[]) || [],
      enabled: config.enabled !== false,
      timeout_ms: (config.timeout_ms as number) || 300000,
    };
  }

  /** 注册新 Agent — 写入 SKILL.md 格式 */
  register(config: AgentConfig): void {
    if (!config.id || !config.name || !config.node) {
      throw new Error('Agent 配置缺少必填字段: id, name, node');
    }

    const agentDir = path.join(AGENTS_DIR, config.name);
    if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });

    // 生成 SKILL.md
    const tools = (config.tools || ['wiki:read', 'ai:analyze', 'docx:create', 'im:send']).map(t => `  - ${t}`).join('\n');
    const targets = (config.output_target || ['节点负责人']).map(t => `  - ${t}`).join('\n');
    const skillMd = `---
name: ${config.name}
id: ${config.id}
description: ${config.description}
node: ${config.node}
department: ${config.department || ''}
tools:
${tools}
output_target:
${targets}
timeout_ms: ${config.timeout_ms || 300000}
---

${config.prompt || `# ${config.name}

${config.description}

请在此处完善系统提示词。`}
`;
    fs.writeFileSync(path.join(agentDir, 'SKILL.md'), skillMd, 'utf-8');

    // 更新注册表（使用 SKILL.md 路径）
    const entryName = `${config.name}/SKILL.md`;
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    if (!registry.agents.includes(entryName)) {
      registry.agents.push(entryName);
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    }

    // 内存热加载
    this.agents.set(config.id, config);
    console.log(`[Registry] ✅ 热注册: ${config.name} → 节点: ${config.node} (SKILL.md)`);
  }

  /** 注销 Agent */
  unregister(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent ${id} 不存在`);

    // 从注册表移除（兼容旧 .json 和新 SKILL.md 路径）
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    const oldEntry = `${agent.name}.json`;
    const newEntry = `${agent.name}/SKILL.md`;
    registry.agents = registry.agents.filter((f: string) => f !== oldEntry && f !== newEntry);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');

    // 删除 Agent 目录或旧文件
    const agentDir = path.join(AGENTS_DIR, agent.name);
    const oldFile = path.join(AGENTS_DIR, `${agent.name}.json`);
    try {
      if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true });
      else if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    } catch { /* ignore */ }

    // 内存移除
    this.agents.delete(id);
    console.log(`[Registry] ❌ 已注销: ${agent.name}`);
  }

  /** 获取所有 Agent */
  getAll(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  /** 获取单个 Agent */
  get(id: string): AgentConfig | undefined {
    return this.agents.get(id);
  }

  /** 获取数量 */
  get count(): number {
    return this.agents.size;
  }

  /** 启动文件监听（热加载） */
  startWatch(): void {
    this.watcher = fs.watch(AGENTS_DIR, (_event, filename) => {
      if (!filename || filename === '_registry.json') return;
      if (!filename.endsWith('.json')) return;

      // 延迟等文件写入完成
      setTimeout(() => {
        try {
          const filePath = path.join(AGENTS_DIR, filename);
          if (!fs.existsSync(filePath)) return;
          const config = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AgentConfig;

          // 检查注册表中是否有此文件
          const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
          if (!registry.agents.includes(filename)) return;

          if (config.enabled) {
            this.agents.set(config.id, config);
            console.log(`[Registry] 🔄 热更新: ${config.name}`);
          }
        } catch { /* 文件可能还在写入 */ }
      }, 500);
    });
    console.log('[Registry] 文件监听已启动');
  }
}

/** 单例 */
export const registry = new AgentRegistry();
