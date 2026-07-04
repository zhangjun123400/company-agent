/**
 * 流程编排引擎
 * 维护「飞书项目节点 → Agent 列表」映射，事件路由
 */
import { registry, type AgentConfig } from './registry';

class Dispatcher {
  private nodeMap: Map<string, string[]> = new Map();

  /** 重建节点→Agent映射 */
  rebuild(): void {
    this.nodeMap.clear();
    for (const agent of registry.getAll()) {
      if (!agent.enabled) continue;
      const list = this.nodeMap.get(agent.node) || [];
      list.push(agent.id);
      this.nodeMap.set(agent.node, list);
    }
    console.log(`[Dispatcher] 节点映射已重建: ${this.nodeMap.size} 个节点`);
    for (const [node, ids] of this.nodeMap) {
      console.log(`  ${node} → [${ids.join(', ')}]`);
    }
  }

  /** 根据节点获取 Agent 列表 */
  getAgentsForNode(nodeName: string): AgentConfig[] {
    // 精确匹配 + 模糊匹配
    let ids = this.nodeMap.get(nodeName) || [];

    // 模糊匹配（节点名包含关键词）
    if (ids.length === 0) {
      for (const [key, val] of this.nodeMap) {
        if (nodeName.includes(key) || key.includes(nodeName)) {
          ids = [...ids, ...val];
        }
      }
    }

    return [...new Set(ids)].map((id) => registry.get(id)!).filter(Boolean);
  }

  /** 列出所有已注册节点 */
  getRegisteredNodes(): string[] {
    return Array.from(this.nodeMap.keys());
  }
}

export const dispatcher = new Dispatcher();
