/**
 * 智慧智能体 — 主入口
 * 飞书项目 (Meegle) 对接 | 三大 AI 能力
 */
import express from 'express';
import { projectConfig, feishuApp } from './config';
import { testConnection, exchangeCodeForUserKey, getWorkItemTypes } from './feishu-project/client';
import { storeInitialToken } from './auth/wiki-token';
import axios from 'axios';

const FEISHU_APP_ID = feishuApp.appId;
const FEISHU_APP_SECRET = feishuApp.appSecret;

// 缓存 user_access_token
let userAccessToken: string | null = null;
// TODO: 待 user_key 配置完成后，启用 agent 模块
// import { runOverdueCheck, generateTechFeasibilityReport, generateClarificationQuestions } from './agents';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = parseInt(process.env.PORT || '3456', 10);

// ==================== 健康检查 ====================

app.get('/health', async (_req, res) => {
  const conn = await testConnection();
  res.json({
    status: 'ok',
    service: '智慧智能体',
    space: projectConfig.spaceKey,
    userKey: projectConfig.userKey ? '已配置' : '❌ 未配置',
    connection: conn.ok ? '✅ 正常' : `❌ ${conn.error}`,
    types: conn.types,
  });
});

// ==================== OAuth 授权（获取 user_key） ====================

/**
 * 授权引导页
 * 访问此页面获取 user_key
 *
 * 飞书项目的 OAuth 比较特殊——需要在飞书项目前端页面内
 * 通过 JSSDK 获取 auth code，无法直接通过 URL 跳转。
 *
 * 方式1（推荐）：在飞书项目网页控制台手动获取
 *   打开浏览器 DevTools → Console → 输入以下代码：
 *     const { code } = await window.JSSDK.utils.getAuthCode();
 *     console.log('AUTH CODE:', code);
 *   然后把 code 贴到 POST /auth/exchange 接口。
 *
 * 方式2：如果你知道自己的 user_key，直接填到 .env 的 FEISHU_PROJECT_USER_KEY
 */
app.get('/auth', (_req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>智慧智能体 — 授权</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 60px auto; padding: 20px; color: #333; }
  h1 { color: #1a73e8; }
  .step { background: #f5f7fa; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .step h3 { margin-top: 0; }
  code { background: #e8eaed; padding: 3px 8px; border-radius: 4px; font-size: 14px; }
  .highlight { background: #e3f2fd; border-left: 3px solid #1a73e8; padding: 12px 16px; border-radius: 4px; margin: 16px 0; }
  input, button { font-size: 16px; padding: 8px 16px; border-radius: 4px; }
  input { border: 1px solid #dadce0; width: 100%; max-width: 400px; }
  button { background: #1a73e8; color: #fff; border: none; cursor: pointer; margin-top: 8px; }
  button:hover { background: #1557b0; }
  #result { margin-top: 16px; padding: 12px; border-radius: 4px; display: none; }
  .success { background: #e8f5e9; border: 1px solid #4caf50; }
  .error { background: #ffebee; border: 1px solid #f44336; }
</style>
</head>
<body>
<h1>🧠 智慧智能体 — 授权获取 user_key</h1>

<div class="step">
  <h3>方式一：从飞书项目控制台获取 auth code（推荐）</h3>
  <p>在飞书项目页面打开开发者工具（F12），粘贴以下代码：</p>
  <code>const { code } = await window.JSSDK.utils.getAuthCode(); console.log('CODE:', code);</code>
</div>

<div class="step">
  <h3>方式二：如果你知道 user_key</h3>
  <p>直接写到 <code>.env</code> 文件的 <code>FEISHU_PROJECT_USER_KEY=</code></p>
</div>

<div class="step">
  <h3>方式三：用 auth code 换取 user_key</h3>
  <p>输入 auth code：</p>
  <input id="codeInput" placeholder="粘贴 auth code..." />
  <button onclick="exchange()">换取 user_key</button>
  <div id="result"></div>
</div>

<hr />
<p><small>当前空间：<code>${projectConfig.spaceKey}</code> | 插件：<code>${projectConfig.pluginId.substring(0, 10)}...</code></small></p>

<script>
async function exchange() {
  const code = document.getElementById('codeInput').value.trim();
  const resultEl = document.getElementById('result');
  if (!code) { resultEl.className = 'error'; resultEl.style.display = 'block'; resultEl.textContent = '请输入 auth code'; return; }

  resultEl.style.display = 'block';
  resultEl.textContent = '正在换取 user_key...';
  try {
    const res = await fetch('/auth/exchange', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({code}) });
    const data = await res.json();
    if (data.ok) {
      resultEl.className = 'success';
      resultEl.innerHTML = '<b>✅ 成功！</b><br>user_key: <code>' + data.userKey + '</code><br>请将此值写入 .env 文件的 FEISHU_PROJECT_USER_KEY';
    } else {
      resultEl.className = 'error';
      resultEl.textContent = '❌ 失败: ' + data.error;
    }
  } catch(e) {
    resultEl.className = 'error';
    resultEl.textContent = '❌ 请求失败: ' + e.message;
  }
}
</script>
</body>
</html>
  `);
});

/**
 * 发起飞书 OAuth 授权（获取 user_access_token 读取 Wiki）
 * GET /auth/feishu-login
 */
app.get('/auth/feishu-login', (_req, res) => {
  const state = Math.random().toString(36).substring(2, 10);
  const authUrl =
    `https://open.feishu.cn/open-apis/authen/v1/authorize` +
    `?app_id=${FEISHU_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(`http://localhost:${PORT}/auth/callback`)}` +
    `&state=${state}` +
    `&scope=${encodeURIComponent('wiki:wiki wiki:node:read docx:document:readonly')}`;
  console.log('[OAuth] 授权链接:', authUrl);
  res.redirect(authUrl);
});

/**
 * OAuth 回调 — 飞书重定向到此，带 code 参数
 * GET /auth/callback?code=xxx&state=xxx
 */
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) {
    res.status(400).send('<h2>❌ 缺少 code 参数</h2>');
    return;
  }
  try {
    // 用 code 换取 user_access_token（飞书 OAuth v1 接口）
    const tokenRes = await axios.post(
      'https://open.feishu.cn/open-apis/authen/v1/access_token',
      {
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET,
        grant_type: 'authorization_code',
        code: code as string,
      }
    );

    if (tokenRes.data.code !== 0) {
      throw new Error(tokenRes.data.msg || '换取 token 失败');
    }

    userAccessToken = tokenRes.data.data?.access_token;
    console.log('[OAuth] ✅ user_access_token 获取成功:', userAccessToken?.substring(0, 15) + '...');

    res.send(`
      <html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center">
      <h1>✅ 授权成功！</h1>
      <p>user_access_token 已缓存</p>
      <p>API 应用: <code>${FEISHU_APP_ID}</code></p>
      <p>state: ${state}</p>
      <a href="/health">查看状态</a>
      </body></html>
    `);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[OAuth] ❌ 失败:', msg);
    res.status(500).send(`<h2>❌ 授权失败</h2><p>${msg}</p>`);
  }
});

/**
 * 读取 Wiki 文档
 * GET /wiki/read?token=GNvrw9JInilNMAkmlCSctb2AnRh
 */
app.get('/token', (_req, res) => {
  res.json({ hasToken: !!userAccessToken, token: userAccessToken?.substring(0, 15) + '...' });
});

app.get('/wiki/read', async (req, res) => {
  const wikiToken = req.query.token as string;
  if (!wikiToken) { res.status(400).json({ error: '缺少 token' }); return; }
  if (!userAccessToken) { res.status(401).json({ error: '未授权' }); return; }

  try {
    // wiki node → document_id
    const nodeRes = await axios.get(
      `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${wikiToken}`,
      { headers: { Authorization: `Bearer ${userAccessToken}` }, validateStatus: () => true }
    );
    console.log('[Wiki] get_node:', nodeRes.status, JSON.stringify(nodeRes.data).substring(0, 500));

    if (nodeRes.data.code !== 0) {
      res.status(400).json({ step: 'wiki_get_node', ...nodeRes.data });
      return;
    }

    const node = nodeRes.data.data?.node || nodeRes.data.data;
    const docId = node?.obj_token || node?.node_token || node?.origin_space_id;
    console.log('[Wiki] node:', node?.title, 'docId:', docId);

    if (!docId) { res.json({ step: 'no_docid', node }); return; }

    // docx blocks
    const docRes = await axios.get(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks`,
      { headers: { Authorization: `Bearer ${userAccessToken}` }, validateStatus: () => true }
    );
    console.log('[Wiki] docx:', docRes.status, JSON.stringify(docRes.data).substring(0, 300));

    if (docRes.data.code !== 0) {
      res.status(400).json({ step: 'docx_blocks', ...docRes.data });
      return;
    }

    // 提取文本内容
    const items = docRes.data.data?.items || [];
    const textParts: string[] = [];
    for (const item of items) {
      const elements = item.text?.elements || [];
      const line = elements.map((e: Record<string, unknown>) => {
        const run = e.text_run as Record<string, unknown> | undefined;
        return (run?.content as string) || '';
      }).join('');
      if (line.trim()) textParts.push(line);
    }

    res.json({
      ok: true,
      title: node?.title || '',
      content: textParts.join('\n'),
      raw_node: node,
      block_count: items.length,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Wiki] ERROR:', msg);
    res.status(500).json({ error: msg });
  }
});

/**
 * 用 auth code 换取 user_key
 * POST /auth/exchange  { code: "xxx" }
 */
app.post('/auth/exchange', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    res.json({ ok: false, error: '缺少 code 参数' });
    return;
  }
  try {
    const result = await exchangeCodeForUserKey(code);
    console.log('[Auth] user_key 获取成功:', result.userKey);
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('[Auth] 换取失败:', error);
    res.json({ ok: false, error: String(error) });
  }
});

// ==================== 启动 ====================

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        🧠 智慧智能体 已启动              ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  地址     : http://localhost:${PORT}        ║`);
  console.log(`║  授权     : http://localhost:${PORT}/auth  ║`);
  console.log(`║  空间     : ${projectConfig.spaceKey.padEnd(29)}║`);
  console.log(`║  user_key : ${(projectConfig.userKey ? '✅ 已配置' : '❌ 待获取').padEnd(22)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  if (!projectConfig.userKey) {
    console.log('⚠ 缺少 user_key，请先获取：');
    console.log('  1. 打开飞书项目页面，F12 控制台执行：');
    console.log('     const { code } = await window.JSSDK.utils.getAuthCode();');
    console.log('     console.log("CODE:", code);');
    console.log('');
    console.log('  2. 访问 http://localhost:3456/auth 输入 code 换取 user_key');
    console.log('');
  }
});

export default app;
