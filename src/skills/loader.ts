/**
 * 技能加载器
 * 扫描 skills/ 目录，解析外部技能的 SKILL.md + handler.ts，
 * 将工具追加注册到全局 toolRegistry
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { toolRegistry } from '../tools';

interface SkillManifest {
  name: string;
  version: string;
  tools: { id: string; description: string }[];
}

class SkillLoader {
  private skillDir = path.resolve(__dirname, '../../skills');
  loaded = new Map<string, SkillManifest>();

  /** 启动时扫描并加载所有外部技能 */
  async loadAll(): Promise<void> {
    if (!fs.existsSync(this.skillDir)) {
      fs.mkdirSync(this.skillDir, { recursive: true });
      console.log('[SkillLoader] skills/ 目录已创建（当前无外部技能）');
      return;
    }

    const dirs = fs.readdirSync(this.skillDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of dirs) {
      try { await this.loadSkill(dir.name); }
      catch (e) { console.error(`[SkillLoader] 加载失败 ${dir.name}:`, e); }
    }

    console.log(`[SkillLoader] ${this.loaded.size} 个外部技能, ${toolRegistry.list().length} 个工具总数`);
  }

  /** 加载单个技能 */
  private async loadSkill(skillName: string): Promise<void> {
    const skillPath = path.join(this.skillDir, skillName);
    const mdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(mdPath)) return;

    // 解析 SKILL.md YAML frontmatter
    const raw = fs.readFileSync(mdPath, 'utf-8');
    const parts = raw.split(/^---$/m);
    if (parts.length < 2) return;

    const manifest = this.parseYaml(parts[1]) as unknown as SkillManifest;
    console.log(`[SkillLoader] ${skillName}: name=${manifest.name} tools=${JSON.stringify(manifest.tools)}`);
    if (!manifest.name || !manifest.tools || manifest.tools.length === 0) {
      console.log(`[SkillLoader] ${skillName}: 无有效工具声明，跳过`);
      return;
    }

    // 动态加载 handler.ts
    const handlerPath = path.join(skillPath, 'handler.ts');
    if (fs.existsSync(handlerPath)) {
      const mod = await import(pathToFileURL(handlerPath).href);
      for (const toolDef of manifest.tools) {
        // 按约定命名: mem0:search → mem0SearchTool
        const exportName = toolDef.id.replace(/[:]([a-z])/g, (_, c) => c.toUpperCase()) + 'Tool';
        const handler = mod[exportName];
        if (handler && handler.id) {
          toolRegistry.register(handler);
          console.log(`[SkillLoader]   + ${handler.id} (来自 ${skillName})`);
        }
      }
    }

    this.loaded.set(skillName, manifest);
  }

  /** 简易 YAML 解析 */
  private parseYaml(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const tools: { id: string; description: string }[] = [];
    let inTools = false;
    let currentTool: Record<string, string> = {};

    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed === 'tools:') { inTools = true; continue; }

      if (inTools) {
        if (trimmed.startsWith('- id:') || trimmed.startsWith('-  id:')) {
          if (currentTool.id) { tools.push({ id: currentTool.id, description: currentTool.description || '' }); }
          // 提取 "- id: xxx" 中冒号后的值
          const m = trimmed.match(/^-\s*id:\s*(.+)/);
          currentTool = { id: m ? m[1].trim() : '' };
        } else if (trimmed.startsWith('description:')) {
          currentTool.description = trimmed.slice(12).trim();
        }
        continue;
      }

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      result[trimmed.slice(0, colonIdx).trim()] = trimmed.slice(colonIdx + 1).trim();
    }
    if (currentTool.id) tools.push({ id: currentTool.id, description: currentTool.description || '' });
    if (tools.length > 0) result.tools = tools;

    return result;
  }
}

export const skillLoader = new SkillLoader();
