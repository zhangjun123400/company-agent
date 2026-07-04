/**
 * 权限管理器
 * 管理员白名单校验，控制谁可以新增/删除/修改 Agent
 */
import fs from 'fs';
import path from 'path';

const ADMINS_FILE = path.resolve(__dirname, '../../config/admins.json');

let adminCache: Set<string> | null = null;

function loadAdmins(): Set<string> {
  try {
    const raw = fs.readFileSync(ADMINS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return new Set((data.admins || []).map((a: { open_id: string }) => a.open_id));
  } catch {
    return new Set();
  }
}

export function isAdmin(openId: string): boolean {
  if (!adminCache) adminCache = loadAdmins();
  return adminCache.has(openId);
}

export function reloadAdmins(): void {
  adminCache = null;
}

export function addAdmin(openId: string, name: string): void {
  const admins = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf-8'));
  if (admins.admins.find((a: { open_id: string }) => a.open_id === openId)) return;
  admins.admins.push({ open_id: openId, name, added_at: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(admins, null, 2), 'utf-8');
  adminCache = null;
}

export function removeAdmin(openId: string): void {
  const admins = JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf-8'));
  admins.admins = admins.admins.filter((a: { open_id: string }) => a.open_id !== openId);
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(admins, null, 2), 'utf-8');
  adminCache = null;
}

export function listAdmins(): Array<{ open_id: string; name: string }> {
  try {
    return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf-8')).admins;
  } catch { return []; }
}
