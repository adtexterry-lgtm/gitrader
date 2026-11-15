> 许可证：CPAL-1.0。

# @gitrader/plugin-notify-slack

Slack 通知通道插件：纯 `.mjs`，不经构建，由内核用 Node 子进程拉起（GSP stdio），把内核通知发到 webhook 绑定的频道。

## 清单要点（`gitrader-plugin.json`）

- `tools[].name = "notify_send"`（内核通知出口按这个名字找通道）；`input` / `output` 见 B0 契约与 `docs/notifications.md`。
- `permissions: ["net.fetch"]` + `net.hosts: ["hooks.slack.com"]`：只出网到 Slack 的 webhook 主机。
- `secrets: ["SLACK_WEBHOOK_URL"]`：内核按用户配置解析后**作为环境变量**注入，插件只从 `process.env` 读，
  不打印、不回传；错误原因先过 `redactWebhookUrl`（webhook URL 本身即凭据）。
- `params` 不参与发送：Slack 的目标频道由 webhook 决定，插件只校验它是对象，内容一律忽略——**不会**把
  `params` 里的文本拼进正文。
- `privacy.hosted: false`；`privacy.sends` 只能是协议枚举的四个值（watchlist / positions / addresses / orders），
  发通知文本不属于其中任何一项，因此为 `[]`——实际发送内容写在 `risk.disclosure` 里。
- 处理函数内部网络超时 8 s（单次调用含 429 重试共用一份预算），超时返回 `retryable: true`；429 优先按
  `Retry-After`（秒）重试，缺省 2 次。

## 消息格式

`POST <webhook url>`，`content-type: application/json`，body 只有 `{"text": "..."}`。
正文里 `&` `<` `>` 按 Slack mrkdwn 规则转义成 `&amp;` `&lt;` `&gt;`（`&` 先转），因此
`<@U123>`、`<!channel>`、`<https://x|label>` 都不可能成立。模板：`[LEVEL] *标题*`，随后每条 `lines` 一行，
末行 ISO 时间（有 `ts` 时）。只转义、不改写正文。

**一条通知一条消息**：正文超过 Slack 的 40000 字符上限时报错（`retryable: false`），不拆分、不截断。
webhook 的成功响应里没有消息 id，所以输出是 `{ "ok": true }`，不带 `ref`。

官方依据：<https://api.slack.com/messaging/webhooks>、
<https://api.slack.com/reference/surfaces/formatting#escaping>、<https://api.slack.com/apis/rate-limits>。

## 文件

| 文件 | 作用 |
|---|---|
| `gsp.mjs` | GSP stdio 循环：hello / 版本协商 / describe / health / tool.call / shutdown，秘密字段 5006，退出码 |
| `index.mjs` | `notify_send` 处理函数：读 webhook → `renderNotice` → 一条 POST → B0 形状 |
| `slack.mjs` | webhook 客户端（URL 校验、注入 fetch / clock / sleep、8 s 超时、429 重试）、`redactWebhookUrl` |
| `format.mjs` | mrkdwn 转义、固定模板 `renderNotice`、40000 上限 |

`slack.mjs` / `format.mjs` 是 `packages/notify-slack/src/{slack,format}.ts` 的 JS 版副本（插件不能 import 工作区包），
改逻辑先改库；`test/parity.test.ts` 逐字节比对两边输出，只改一边会红。

## 本地跑

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/plugin-notify-slack
node node_modules/typescript/bin/tsc -p packages/plugin-notify-slack --noEmit
node packages/plugin-notify-slack/run-conformance.mjs
```

`GITRADER_PLUGIN_FAKE_FETCH=1` 时插件用内置假响应（body `ok`），不发任何网络请求；冒烟测试与协议一致性套件都靠它离线跑。

## 工具名

清单里 `tools[].name` 是协议合法名 `notify_send`（`PLUGIN_TOOL_NAME_RE` 不接受点号）；插件运行时同时接受
B0 契约里的点号名由内核侧映射，插件只暴露清单声明的 `notify_send`。

- `params.apiBase`（可选，自托管 / 离线测试）：只取 origin 的 `https://` 地址（不带路径、查询串、凭据）；给了它，请求发到这个 origin，路径仍取自环境变量里的原 URL，官方主机检查改为只认它。不给则走官方地址 `https://hooks.slack.com`。明文 `http://` 回环（`127.0.0.1` / `localhost` / `[::1]`）只在测试开关（调用 handler 时 `deps.allowInsecureLoopback`）下放行，随包运行的插件进程里不会开。
- 每次调用内核在 `params.idempotencyKey` 里带幂等键，插件放进请求头 `Idempotency-Key`（多块消息每块加 `:序号` 后缀）；官方端点会忽略这个头，自建代理可用它去重。
