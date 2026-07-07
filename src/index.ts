/**
 * 智慧智能体 — 主入口
 * 飞书项目 (Meegle) 对接 | 三大 AI 能力
 */
import express from 'express';
import { projectConfig, feishuApp } from './config';
import { testConnection, exchangeCodeForUserKey, getWorkItemTypes } from './feishu-project/client';
import { storeInitialToken } from './auth/wiki-token';
import { startFeishuWS } from './feishu-im/ws-client';
import { popPending } from './utils/pending-analysis';
import { cleanupOldFiles } from './utils/cleanup';
import { init as initOrchestrator, dispatchNode } from './core/orchestrator';
import { registry } from './core/registry';
import { dispatcher } from './core/dispatcher';
import { isAdmin } from './core/permission';
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
app.get('/auth/feishu-login', (req, res) => {
  const openId = (req.query.open_id as string) || '';
  const state = Math.random().toString(36).substring(2, 10) + (openId ? ':' + openId : '');
  const authUrl =
    `https://open.feishu.cn/open-apis/authen/v1/authorize` +
    `?app_id=${FEISHU_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(`http://localhost:${PORT}/auth/callback`)}` +
    `&state=${state}` +
    `&scope=${encodeURIComponent('wiki:wiki wiki:node:read docx:document:readonly')}`;
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
    // Step 1: 获取 app_access_token
    const appTokenRes = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
      { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }
    );
    const appToken = appTokenRes.data.app_access_token as string;
    if (!appToken) throw new Error('获取 app_access_token 失败');

    // Step 2: 用 app_access_token 换取 user_access_token
    const tokenRes = await axios.post(
      'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
      { grant_type: 'authorization_code', code: code as string },
      { headers: { Authorization: `Bearer ${appToken}` } }
    );
    console.log('[OAuth] raw response:', JSON.stringify(tokenRes.data));

    const td = tokenRes.data as Record<string, unknown>;
    if (td.code !== 0) throw new Error((td.msg as string) || '换取 token 失败');

    const tokenData = td.data as Record<string, unknown>;
    userAccessToken = tokenData?.access_token as string;
    if (!userAccessToken) throw new Error('响应中无 access_token: ' + JSON.stringify(td).substring(0, 200));

    console.log('[OAuth] ✅ token:', userAccessToken.substring(0, 15) + '...');

    // 持久化到文件
    storeInitialToken({
      access_token: userAccessToken,
      refresh_token: (tokenData?.refresh_token as string) || '',
      expires_in: (tokenData?.expires_in as number) || 7200,
      refresh_expires_in: (tokenData?.refresh_expires_in as number) || 1209600,
    });

    // 发飞书消息确认授权成功
    const imToken = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }
    );
    // 从 state 中提取 open_id（授权时传入）
    const senderOpenId = (state as string)?.split(':')[1] || '';
    if (senderOpenId) {
      await axios.post(
        'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
        { receive_id: senderOpenId, msg_type: 'text', content: JSON.stringify({ text: '✅ 授权成功！智小协现在可以读取你授权的文档了。有效期14天，到期后需重新授权。' }) },
        { headers: { Authorization: `Bearer ${imToken.data.tenant_access_token}` } }
      ).catch(() => {});

	    // 检查待处理分析，自动继续
	    const pending = popPending(senderOpenId);
	    if (pending) {
	      const { triggerAnalysis } = await import('./feishu-im/ws-client');
	      setTimeout(async () => {
	        try {
	          const result = await triggerAnalysis(pending.workItemName, pending.chatId, pending.workItemName, senderOpenId);
	          await axios.post(
	            'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
	            { receive_id: senderOpenId, msg_type: 'text', content: JSON.stringify({ text: result }) },
	            { headers: { Authorization: `Bearer ${imToken.data.tenant_access_token}` } }
	          ).catch(() => {});
	        } catch (e) { console.error('[OAuth] 自动继续失败:', e); }
	      }, 2000);
	    }
	  }

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

// ==================== Agent 管理 API ====================

app.get('/api/agents', (_req, res) => {
  res.json({ count: registry.count, agents: registry.getAll().map((a: { id: string; name: string; node: string; department: string; enabled: boolean }) => ({ id: a.id, name: a.name, node: a.node, department: a.department, enabled: a.enabled })) });
});

app.get('/api/agents/nodes', (_req, res) => {
  res.json({ nodes: dispatcher.getRegisteredNodes() });
});

app.post('/api/agents/register', express.json(), (req, res) => {
  try {
    const { config, adminId } = req.body;
    if (!isAdmin(adminId)) { res.status(403).json({ error: '仅管理员可新增智能体' }); return; }
    registry.register(config);
    dispatcher.rebuild();
    res.json({ ok: true, msg: `智能体「${config.name}」已注册` });
  } catch (e: unknown) { res.status(400).json({ error: (e as Error).message }); }
});

app.post('/api/agents/unregister', express.json(), (req, res) => {
  try {
    const { id, adminId } = req.body;
    if (!isAdmin(adminId)) { res.status(403).json({ error: '仅管理员可删除智能体' }); return; }
    registry.unregister(id);
    dispatcher.rebuild();
    res.json({ ok: true, msg: '已删除' });
  } catch (e: unknown) { res.status(400).json({ error: (e as Error).message }); }
});

// ==================== 手动触发：分析需求 ====================

app.post('/trigger/new-requirement/:workItemId', async (req, res) => {
  const { workItemId } = req.params;
  const requester = (req.query.requester as string) || '';
  const chatId = (req.query.chat_id as string) || '';
  console.log('[手动触发] 分析需求:', workItemId, requester ? '来自:' + requester : '', chatId ? 'chat:' + chatId : '');
  res.json({ code: 0, msg: '分析已启动', workItemId });
  try {
    const { handleNewRequirement } = await import('./agents/auto-analyzer');
    await handleNewRequirement(workItemId, requester, chatId);
  } catch (e) { console.error('[手动触发] 失败:', e); }
});

// ==================== Webhook：飞书项目事件 → Agent 调度 ====================

app.post('/webhook/project', async (req, res) => {
  res.json({ code: 0, msg: 'received' });
  try {
    const { work_item_id, node_name, work_item_name } = req.body;
    if (!work_item_id || !node_name) return;
    console.log(`[Webhook] ${node_name} → ${work_item_id}`);

    await dispatchNode(node_name, {
      workItemId: String(work_item_id),
      workItemName: work_item_name || '',
      nodeName: node_name,
      fields: req.body.fields || {},
    });
  } catch (e) { console.error('[Webhook] error:', e); }
});

// ==================== 飞书 IM WebSocket 自动触发 ====================

async function handleIMTrigger(workItemName: string, senderOpenId: string) {
  // 在飞书项目中搜索需求
  const pluginRes = await axios.post(
    'https://project.feishu.cn/open_api/authen/plugin_token',
    { plugin_id: projectConfig.pluginId, plugin_secret: projectConfig.pluginSecret, type: 1 }
  );
  const pToken = pluginRes.data.data.token;

  const searchRes = await axios.post(
    'https://project.feishu.cn/open_api/compositive_search',
    { query_type: 'workitem', query: workItemName, page_size: 5 },
    { headers: { 'X-Plugin-Token': pToken, 'X-User-Key': projectConfig.userKey } }
  );
  const items: Array<{ ID: string; name: string }> = searchRes.data.data || [];
  const found = items.find((i) => i.name && i.name.includes(workItemName));

  // 通过 IM 回复
  const imToken = await axios.post(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: feishuApp.appId, app_secret: feishuApp.appSecret }
  );
  const imH = { Authorization: `Bearer ${imToken.data.tenant_access_token}` };

  if (!found) {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: senderOpenId,
        msg_type: 'text',
        content: JSON.stringify({ text: `🤖 未找到「${workItemName}」相关需求，请确认需求名称是否正确。` }),
      },
      { headers: imH }
    );
    return;
  }

  // 回复确认
  await axios.post(
    'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
    {
      receive_id: senderOpenId,
      msg_type: 'text',
      content: JSON.stringify({ text: `🤖 收到！开始分析「${found.name}」，稍后会将报告发给你。` }),
    },
    { headers: imH }
  );

  // 触发分析
  const { handleNewRequirement } = await import('./agents/auto-analyzer');
  const result = await handleNewRequirement(found.ID, senderOpenId);
  if (result.clarificationUrl) {
    await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: senderOpenId,
        msg_type: 'text',
        content: JSON.stringify({
          text: `✅ 「${found.name}」分析完成！\n📋 需求澄清：${result.clarificationUrl}\n📊 技术初评：${result.techReportUrl}`,
        }),
      },
      { headers: imH }
    );
  }
}

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║        🧠 智慧智能体 已启动              ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  地址     : http://localhost:${PORT}        ║`);
  console.log(`║  授权     : http://localhost:${PORT}/auth  ║`);
  console.log(`║  空间     : ${projectConfig.spaceKey.padEnd(29)}║`);
  console.log(`║  user_key : ${(projectConfig.userKey ? '✅ 已配置' : '❌ 待获取').padEnd(22)}║`);
  console.log(`║  IM       : ✅ 独立长连接                ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // 启动飞书 IM WebSocket（本地开发时如与 claude-feishu 冲突，在 config.env 设 FEISHU_WS_ENABLED=false）
  if (process.env.FEISHU_WS_ENABLED !== 'false') {
    startFeishuWS();
  } else {
    console.log('⚠ IM WebSocket 已禁用（FEISHU_WS_ENABLED=false），使用 claude-feishu 接收消息');
  }

  // 启动多智能体编排引擎
  initOrchestrator();

  // 清理旧 MD 文件（7天前）+ 每天执行
  cleanupOldFiles();
  setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);

  // 检查 Wiki Token
  const { hasWikiToken } = require('./auth/wiki-token');
  if (!hasWikiToken()) {
    console.log('');
    console.log('⚠ Wiki 文档读取需要授权（首次，有效期14天自动续期）：');
    console.log(`   浏览器打开: http://localhost:${PORT}/auth/feishu-login`);
    console.log('');
  } else {
    console.log('✅ Wiki Token 有效，自动续期中');
  }

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
