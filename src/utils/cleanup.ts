/**
 * 输出目录自动清理
 * 删除超过 7 天的 .md 文件
 */
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = path.resolve(__dirname, '../../output');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cleanupOldFiles(): void {
  if (!fs.existsSync(OUTPUT_DIR)) return;
  const now = Date.now();
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.md'));
  let deleted = 0;
  for (const f of files) {
    const fp = path.join(OUTPUT_DIR, f);
    try {
      if (now - fs.statSync(fp).mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(fp);
        deleted++;
      }
    } catch { /* skip */ }
  }
  if (deleted > 0) console.log(`[Cleanup] 删除了 ${deleted} 个旧 MD 文件（>7天）`);
}
