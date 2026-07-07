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
          const config = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as AgentConfig;
          if (config.enabled) {
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

  /** 注册新 Agent（热加载） */
  register(config: AgentConfig): void {
    // 验证必填字段
    if (!config.id || !config.name || !config.node) {
      throw new Error('Agent 配置缺少必填字段: id, name, node');
    }

    // 写入配置文件
    const fileName = `${config.name}.json`;
    const filePath = path.join(AGENTS_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');

    // 更新注册表
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    if (!registry.agents.includes(fileName)) {
      registry.agents.push(fileName);
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    }

    // 内存热加载
    this.agents.set(config.id, config);
    console.log(`[Registry] ✅ 热注册: ${config.name} → 节点: ${config.node}`);
  }

  /** 注销 Agent */
  unregister(id: string): void {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Agent ${id} 不存在`);

    // 从注册表移除
    const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    registry.agents = registry.agents.filter((f: string) => f !== `${agent.name}.json`);
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');

    // 删除配置文件
    const filePath = path.join(AGENTS_DIR, `${agent.name}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

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
