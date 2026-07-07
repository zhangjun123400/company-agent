/**
 * 飞书文档生成技能 — MD 文件上传方式
 * AI 生成 Markdown → 保存 .md → 上传飞书文件 → 返回链接
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';

const OUTPUT_DIR = path.resolve(__dirname, '../../output');

export async function createFormattedDoc(title: string, content: string): Promise<{ id: string; url: string }> {
  const fileName = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
  const filePath = path.join(OUTPUT_DIR, fileName);
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');

  const t = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: process.env.FEISHU_APP_ID || '',
    app_secret: process.env.FEISHU_APP_SECRET || '',
  });
  const H = { Authorization: `Bearer ${t.data.tenant_access_token}` };

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
    if (fileToken) {
      return { id: fileToken, url: `https://p1iscu6mj28.feishu.cn/file/${fileToken}` };
    }
  } catch (e) { console.error('[Doc] Upload failed:', e); }

  // 4. Fallback: 创建飞书文档（纯文本 block）
  const cr = await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents', { title }, { headers: H });
  const docId: string = cr.data.data.document.document_id;
  const blocks = content.split('\n').filter(l => l.trim()).map(l => {
    const t2 = l.trim();
    if (t2.startsWith('### ')) return { block_type: 5, heading3: { elements: [{ text_run: { content: t2.slice(4) } }], style: {} } };
    if (t2.startsWith('## ')) return { block_type: 4, heading2: { elements: [{ text_run: { content: t2.slice(3) } }], style: {} } };
    if (t2.startsWith('# ')) return { block_type: 3, heading1: { elements: [{ text_run: { content: t2.slice(2) } }], style: {} } };
    return { block_type: 2, text: { elements: [{ text_run: { content: t2.substring(0, 400) } }] } };
  });
  for (let i = 0; i < blocks.length; i += 20) {
    await axios.post(`https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
      { children: blocks.slice(i, i + 20) }, { headers: H }).catch(() => {});
    if (i + 20 < blocks.length) await new Promise(r => setTimeout(r, 500));
  }
  return { id: docId, url: `https://p1iscu6mj28.feishu.cn/docx/${docId}` };
}
