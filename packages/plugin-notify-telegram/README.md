> 许可证：CPAL-1.0。

# @gitrader/plugin-notify-telegram

Telegram 通知通道插件：纯 `.mjs`，不经构建，由内核用 Node 子进程拉起（GSP stdio），把内核通知发到 Telegram 聊天。

## 清单要点（`gitrader-plugin.json`）

- `tools[].name = "notify_send"`（内核通知出口按这个名字找通道）；`input` / `output` 见 B0 契约。
- `permissions: ["net.fetch"]` + `net.hosts: ["api.telegram.org"]`：只出网到 Bot API。
- `secrets: ["TELEGRAM_BOT_TOKEN"]`：内核按用户配置解析后**作为环境变量**注入，插件只从 `process.env` 读，不打印、不回传。
- `privacy.hosted: false`；`privacy.sends` 只能是协议枚举的四个值（watchlist / positions / addresses / orders），
  发通知文本与 chatId 不属于其中任何一项，因此为 `[]`——实际发送内容写在 `risk.disclosure` 里。
- 处理函数内部网络超时 8 s（`DEFAULT_TIMEOUT_MS`，单次请求含 429 重试共用一份预算），超时返回 `retryable: true`；429 按 `retry_after` 重试至多 2 次。

## 文件

| 文件 | 作用 |
|---|---|
| `gsp.mjs` | GSP stdio 循环：hello / 版本协商 / describe / health / tool.call / shutdown，秘密字段 5006，退出码 |
| `index.mjs` | 通知处理函数：读令牌 → `renderNotice` → 4096 分块 → 逐块 `sendMessage` → B0 形状 |
| `telegram.mjs` | `sendMessage` 客户端（注入 fetch / clock / 超时 / 429 重试）、`redactToken` / `redactSecrets` |
| `format.mjs` | MarkdownV2 转义、按行分块、固定模板 `renderNotice` |

`telegram.mjs` / `format.mjs` 是 `packages/notify-telegram/src/{telegram,format}.ts` 的 JS 版副本（插件不能 import 工作区包），改逻辑先改库。

## 本地跑

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/plugin-notify-telegram
node packages/plugin-notify-telegram/run-conformance.mjs
node node_modules/typescript/bin/tsc -p packages/plugin-notify-telegram --noEmit
```

`GITRADER_PLUGIN_FAKE_FETCH=1` 时插件用内置假响应（`message_id = 4242`），不发任何网络请求；冒烟测试与协议一致性套件都靠它离线跑。

## 工具名

清单里 `tools[].name` 是协议合法名 `notify_send`（`PLUGIN_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/` 不接受点号），
`plugin.describe` 返回的就是这份清单，`run-conformance.mjs` 默认跑法 G01–G08 全过。
插件只暴露清单声明的 `notify_send`；B0 契约里的 `notify.send` 由内核侧映射（清单与运行时能力一致）。

- `params.apiBase`（可选，自托管 / 离线测试）：只取 origin 的 `https://` 地址（不带路径、查询串、凭据）；给了它，请求发到这个 origin，路径仍取自环境变量里的原 URL，官方主机检查改为只认它。不给则走官方地址 `https://api.telegram.org`。明文 `http://` 回环（`127.0.0.1` / `localhost` / `[::1]`）只在测试开关（调用 handler 时 `deps.allowInsecureLoopback`）下放行，随包运行的插件进程里不会开。
- 每次调用内核在 `params.idempotencyKey` 里带幂等键，插件放进请求头 `Idempotency-Key`（多块消息每块加 `:序号` 后缀）；官方端点会忽略这个头，自建代理可用它去重。
