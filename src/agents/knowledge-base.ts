/**
 * 知识库加载
 * 读取 knowledge/ 目录下的历史技术文档和 PRD 模板
 * 作为 Claude 分析的参考上下文
 */
import * as fs from 'fs';
import * as path from 'path';

const KNOWLEDGE_DIR = path.resolve(__dirname, '../../knowledge');

/**
 * 加载知识库内容
 * 扫描 knowledge/ 目录下所有 .md 和 .txt 文件
 */
export async function loadKnowledgeBase(): Promise<string> {
  try {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
      console.log('[知识库] knowledge/ 目录不存在，使用空知识库');
      return '';
    }

    const files = fs.readdirSync(KNOWLEDGE_DIR);
    const textFiles = files.filter(
      (f) => /\.(md|txt)$/i.test(f) && fs.statSync(path.join(KNOWLEDGE_DIR, f)).isFile()
    );

    if (textFiles.length === 0) {
      console.log('[知识库] 知识库为空');
      return '';
    }

    const contents: string[] = [];
    for (const file of textFiles) {
      const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf-8');
      contents.push(`### ${file}\n\n${content}`);
    }

    console.log(`[知识库] 加载了 ${contents.length} 个文档`);
    return contents.join('\n\n---\n\n');
  } catch (error) {
    console.error('[知识库] 加载失败:', error);
    return '';
  }
}

/**
 * 向知识库添加文档
 */
export function addToKnowledgeBase(fileName: string, content: string): void {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }
  const filePath = path.join(KNOWLEDGE_DIR, fileName);
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`[知识库] 文档已保存: ${fileName}`);
}
