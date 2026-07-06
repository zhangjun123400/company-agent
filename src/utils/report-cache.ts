/**
 * 分析报告缓存
 * 同一需求 2 周内不重复分析，直接返回已有报告
 * 检测 PRD 内容变化（hash 对比），变化后自动重新分析
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.resolve(__dirname, '../../output/cache');
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14天

interface CacheEntry {
  workItemId: string;
  workItemName: string;
  prdHash: string;
  clarificationUrl: string;
  techReportUrl: string;
  generatedAt: number;  // epoch ms
  expiresAt: number;    // epoch ms
}

function cacheFile(workItemId: string): string {
  return path.join(CACHE_DIR, `${workItemId}.json`);
}

function hashContent(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

export function initCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/** 查找缓存 */
export function getCachedReport(workItemId: string, prdText: string): CacheEntry | null {
  initCacheDir();
  const file = cacheFile(workItemId);
  if (!fs.existsSync(file)) return null;

  try {
    const entry: CacheEntry = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      fs.unlinkSync(file);
      return null;
    }
    // 检查 PRD 是否变化
    const currentHash = hashContent(prdText);
    if (entry.prdHash !== currentHash) {
      // PRD 已更新，删除旧缓存
      fs.unlinkSync(file);
      return null;
    }
    console.log(`[Cache] ✅ 命中缓存: ${entry.workItemName} (${workItemId})`);
    return entry;
  } catch {
    return null;
  }
}

/** 存入缓存 */
export function setCachedReport(
  workItemId: string,
  workItemName: string,
  prdText: string,
  clarificationUrl: string,
  techReportUrl: string,
): void {
  initCacheDir();
  const now = Date.now();
  const entry: CacheEntry = {
    workItemId,
    workItemName,
    prdHash: hashContent(prdText),
    clarificationUrl,
    techReportUrl,
    generatedAt: now,
    expiresAt: now + CACHE_TTL_MS,
  };
  fs.writeFileSync(cacheFile(workItemId), JSON.stringify(entry, null, 2), 'utf-8');
  console.log(`[Cache] 💾 已缓存: ${workItemName} (${workItemId})`);
}
