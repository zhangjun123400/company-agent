/**
 * 版本管理 — HTML 发布能力
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { OUTPUT_DIR, TARGET_OPEN_ID } from './_shared';

export async function publishAsHtml(title: string, htmlContent: string): Promise<string> {
  const tokenRes = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: (await import('../../../src/config')).feishuApp.appId,
    app_secret: (await import('../../../src/config')).feishuApp.appSecret,
  });
  const H = { Authorization: `Bearer ${tokenRes.data.tenant_access_token}` };

  const fn = `${title.replace(/[\\/:*?"<>|]/g, '_')}.html`;
  const fp = path.join(OUTPUT_DIR, fn);
  fs.writeFileSync(fp, htmlContent, 'utf-8');

  const fd = new (require('form-data'))();
  fd.append('file_name', fn); fd.append('parent_type', 'explorer'); fd.append('parent_node', '');
  fd.append('size', String(fs.statSync(fp).size)); fd.append('file', fs.createReadStream(fp));
  const u = await axios.post('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', fd, {
    headers: { ...H, ...fd.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  const ft = u.data.data?.file_token;
  if (ft) {
    await axios.post(`https://open.feishu.cn/open-apis/drive/v1/permissions/${ft}/members?type=file`,
      { member_type: 'openid', member_id: TARGET_OPEN_ID, perm: 'full_access' }, { headers: H }).catch(() => {});
    const url = `https://p1iscu6mj28.feishu.cn/file/${ft}`;
    console.log(`[html] ✅ ${title} → ${url}`);
    return url;
  }
  return 'upload_failed';
}
