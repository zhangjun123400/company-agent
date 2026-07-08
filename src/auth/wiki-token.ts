/**
 * Wiki Token 持久化管理
 * OAuth user_access_token 有效期 2h → refresh_token 14天自动续期
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const TOKEN_FILE = path.resolve(
  process.env.HOME || process.env.USERPROFILE || '~',
  '.claude/channels/feishu/wiki_token.json'
);
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface WikiTokenData {
  access_token: string;
  refresh_token: string;
  expire_at: number;
  refresh_expire_at: number;
}

let cachedToken: WikiTokenData | null = null;

function loadToken(): WikiTokenData | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8')) as WikiTokenData;
    if (Date.now() >= data.refresh_expire_at) { console.log('[WikiToken] refresh_token 已过期'); return null; }
    return data;
  } catch { return null; }
}

function saveToken(data: WikiTokenData): void {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) { console.error('[WikiToken] 保存失败:', error); }
}

export function storeInitialToken(authResult: {
  access_token: string; refresh_token: string;
  expires_in: number; refresh_expires_in: number;
}): void {
  const now = Date.now();
  cachedToken = {
    access_token: authResult.access_token, refresh_token: authResult.refresh_token,
    expire_at: now + authResult.expires_in * 1000,
    refresh_expire_at: now + (authResult.refresh_expires_in || 1209600) * 1000,
  };
  saveToken(cachedToken);
}

export async function getWikiAccessToken(): Promise<string | null> {
  if (!cachedToken) cachedToken = loadToken();
  if (!cachedToken) return null;

  // access_token 有效 → 直接返回
  if (Date.now() < cachedToken.expire_at) return cachedToken.access_token;

  // access_token 过期但 refresh_token 有效 → 自动续期
  if (Date.now() < cachedToken.refresh_expire_at) {
    console.log('[WikiToken] access_token 过期，尝试 refresh_token 续期...');
    const newToken = await refreshAccessToken(cachedToken);
    if (newToken) {
      console.log('[WikiToken] ✅ 自动续期成功');
      return newToken;
    }
    console.log('[WikiToken] ❌ 续期失败，需重新授权');
  }

  // refresh_token 也过期 → 需重新 OAuth 授权
  console.log('[WikiToken] refresh_token 已过期，需重新授权');
  cachedToken = null; try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
  return null;
}

async function refreshAccessToken(data: WikiTokenData): Promise<string | null> {
  try {
    const res = await axios.post('https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token', {
      grant_type: 'refresh_token', refresh_token: data.refresh_token,
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    if (res.data.code !== 0) return null;
    const now = Date.now();
    cachedToken = {
      access_token: res.data.data.access_token, refresh_token: res.data.data.refresh_token,
      expire_at: now + res.data.data.expires_in * 1000,
      refresh_expire_at: now + (res.data.data.refresh_expires_in || 1209600) * 1000,
    };
    saveToken(cachedToken);
    return cachedToken.access_token;
  } catch { return null; }
}

export function hasWikiToken(): boolean {
  if (!cachedToken) cachedToken = loadToken();
  return cachedToken !== null && Date.now() < cachedToken.refresh_expire_at;
}
