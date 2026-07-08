/**
 * docx:create — 平台能力
 * 将 Markdown 内容上传飞书云空间，返回文档链接
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import type { ToolHandler, ToolContext } from './_types';
import { feishuApp } from '../config';

const OUTPUT_DIR = path.resolve(__dirname, '../../output');

async function execute(ctx: ToolContext): Promise<string> {
  const content = ctx.previousOutput || '';
  const title = `${ctx.workItemName} · 分析报告`;
  const fileName = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');

  const t = await getTenantToken();
  const H = { Authorization: `Bearer ${t}` };

  // 方式 1：上传 MD 文件
  try {
    const fd = new FormData();
    fd.append('file_name', fileName);
    fd.append('parent_type', 'explorer');
    fd.append('parent_node', '');
    fd.append('size', String(fs.statSync(filePath).size));
    fd.append('file', fs.createReadStream(filePath));

    const u = await axios.post('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', fd, {
      headers: { ...H, ...fd.getHeaders() },
      maxContentLength: Infinity, maxBodyLength: Infinity,
    });

    const fileToken = u.data.data?.file_token;
    if (fileToken) return `https://p1iscu6mj28.feishu.cn/file/${fileToken}`;
  } catch (e) { console.error('[docx:create] Upload failed:', e); }

  // 方式 2：创建 docx 并写入 blocks
  const cr = await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents', { title }, { headers: H });
  const docId: string = cr.data.data.document.document_id;
  const blocks = content.split('\n').filter(l => l.trim()).map(l => {
    const t = l.trim();
    if (t.startsWith('### ')) return { block_type: 5, heading3: { elements: [{ text_run: { content: t.slice(4) } }], style: {} } };
    if (t.startsWith('## ')) return { block_type: 4, heading2: { elements: [{ text_run: { content: t.slice(3) } }], style: {} } };
    if (t.startsWith('# ')) return { block_type: 3, heading1: { elements: [{ text_run: { content: t.slice(2) } }], style: {} } };
    return { block_type: 2, text: { elements: [{ text_run: { content: t.substring(0, 400) } }] } };
  });
  for (let i = 0; i < blocks.length; i += 20) {
    await axios.post(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      { children: blocks.slice(i, i + 20) }, { headers: H }
    ).catch(() => {});
    if (i + 20 < blocks.length) await new Promise(r => setTimeout(r, 500));
  }
  return `https://p1iscu6mj28.feishu.cn/docx/${docId}`;
}

let tenant: string | null = null;
async function getTenantToken(): Promise<string> {
  if (tenant) return tenant;
  const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: feishuApp.appId, app_secret: feishuApp.appSecret,
  });
  tenant = res.data.tenant_access_token as string;
  return tenant as string;
}

export const docxCreateTool: ToolHandler = {
  id: 'docx:create',
  description: '将 Markdown 内容上传飞书云空间 / 创建 docx 文档',
  execute,
};
