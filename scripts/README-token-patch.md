# Feishu Plugin Token Patch

## 修改内容

插件目录：`C:\Users\ZSXC\.local\share\lark-for-claude\`

### server.ts 修改点

1. **Token 预热定时器**（`apiClient` 创建后，大约第 199 行）
   - 新增 `warmupToken()` 函数，每 50 分钟调用 `bot.botInfo.get()` 保持 token 新鲜
   - 新增 `withTokenRetry()` 辅助函数，token 错误时自动重试最多 2 次

2. **API 调用重试包装**
   - `reply` case: `im.message.reply()` 和 `im.message.create()` 用 `withTokenRetry()` 包装
   - `edit_message` case: `im.message.update()` 用 `withTokenRetry()` 包装
   - `send_confirm_card` case: `im.message.create()` 用 `withTokenRetry()` 包装
   - 权限卡片发送: `im.message.create()` 用 `withTokenRetry()` 包装

3. **Token 错误日志增强**（catch 块，大约第 396 行）
   - 检测 `tenant_access_token` 关键字，输出完整 stack trace

4. **Shutdown 定时器清理**（`shutdown()` 函数）
   - 添加 `clearInterval(tokenWarmupTimer)`

### router.ts 修改点

1. **Token 预热定时器**（`apiClient` 创建后，大约第 57 行）
   - 同 server.ts 的预热逻辑

2. **Shutdown 定时器清理**
   - 同 server.ts

### 监控脚本

- `scripts/check-feishu-token.ps1` — 独立的 Token 健康检查脚本
  - 用法：`powershell -File scripts/check-feishu-token.ps1 [-Silent] [-Verbose]`
  - 日志输出到 `~/.claude/channels/feishu/token-health.log`

## 插件更新后重新应用

1. 运行健康检查确认 token 端点正常：
   ```
   powershell -File scripts\check-feishu-token.ps1 -Verbose
   ```

2. 对照上方修改清单，手动将修改应用到新的 `server.ts` 和 `router.ts`

3. 重启 Claude Code 使修改生效

## 搜索标记

在源文件中搜索以下注释可快速定位修改点：
- `Token warmup` — 预热定时器代码段
- `Retry helper` — 重试辅助函数
- `withTokenRetry` — 所有带重试的 API 调用
- `TOKEN ERROR (critical)` — 增强的错误日志
