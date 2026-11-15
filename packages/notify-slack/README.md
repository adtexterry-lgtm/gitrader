> License: CPAL-1.0 (see the repository root LICENSE).

# @gitrader/notify-slack

通知通道插件的客户端库：Slack mrkdwn 转义 + Incoming Webhook 单条发送。不含内核接线。

对应插件包 `packages/plugin-notify-slack`（同一套逻辑的 `.mjs` 版，插件不能 import 工作区包）。

## 契约

- 工具名 `notify_send`，输入 `{ notice, params }`、输出 `{ ok, ref?, reason?, retryable? }` 见 `docs/notifications.md`。
- webhook 由调用方传入（`SlackClientOptions.webhookUrl`）：**URL 本身就是凭据**，库不读环境变量、不落盘、不打印；
  插件版从 `SLACK_WEBHOOK_URL` 环境变量读。
- 一条通知只发一条消息：**不分块、不截断**。渲染结果超过 Slack 的 40000 字符上限时报错（`retryable: false`），
  不会拆成两条——同一接管只发一条。
- webhook 成功响应里没有消息 id，所以输出不带 `ref`（`{ ok: true }`）。

## 消息体与转义

- 请求：`POST <webhook url>`，`content-type: application/json`，body 只有 `{"text": "..."}`。
- 正文里 `&` `<` `>` 必须转义成 `&amp;` `&lt;` `&gt;`（Slack mrkdwn 规则，`&` 先转）。
  转义后 `<@U123>`、`<!channel>`、`<https://x|label>` 都无法成立，动态文本不能造提及或链接。
- 模板：第一行 `[LEVEL] *标题*`，随后每条 `lines` 一行，末行 ISO 时间（有 `ts` 时）。只转义，不改写正文。
- 官方依据：<https://api.slack.com/messaging/webhooks>、<https://api.slack.com/reference/surfaces/formatting#escaping>、
  <https://api.slack.com/apis/rate-limits>。

## 响应与重试

| 情形 | 结果 | `retryable` |
|---|---|---|
| 2xx + 纯文本 `ok` | 成功 | — |
| 2xx + JSON 对象且 `ok !== false` | 成功（与 `notify-webhook` 的 slack 方言同口径） | — |
| 2xx + JSON `{ "ok": false, "error": ... }` | `slack_error:<error>` | false |
| 2xx + 其它 body | `slack_unexpected:<摘要>` | false |
| 408 / 429 / 5xx | `http_<status>[:摘要]` | true |
| 其它 4xx（400 / 403 / 404 / 410） | `http_<status>[:摘要]` | false |

429 优先按响应头 `Retry-After`（秒）等待，缺失时用 500 ms 起的指数退避（上限 2000 ms）；重试次数缺省 2，
单次调用总预算缺省 8 s（含重试），超出即报 `timed out` 且 `retryable: true`。同一 webhook 两次发送之间
至少间隔 `minIntervalMs`（缺省 1000 ms，Slack 每频道每秒 1 条）。

## URL 校验

`assertSlackWebhookUrl` 要求：非空、合法 URL、`https`、主机在 `allowedHosts`（缺省 `['hooks.slack.com']`）、
路径以 `/services/` 开头、不带查询串与锚点。任何一条不满足直接抛错（`retryable: false`），不发请求。
`allowInsecureLoopback: true` 只在测试里放开 http + 回环主机（生产路径永远 https）。

## 测试

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/notify-slack
node node_modules/typescript/bin/tsc -p packages/notify-slack --noEmit
```

`test/fake-slack-server.mjs` 是真听回环端口的假 webhook 服务器，按官方规则**独立**校验（方法 / content-type /
只有 `text` 键 / 长度 / 转义），不 import 本包任何代码；`test/fake-server.test.ts` 走真实 socket 联调。

## 覆盖范围（避免夸大）

- 已覆盖：转义、模板、尺寸上限、URL 校验、响应分类、429 重试、超时、节流、脱敏、一条通知一条消息——全部离线。
- 未覆盖：没有连过真实 Slack 工作区，也没有在真网验证过 `Retry-After` 的实际取值与 400/403/404/410 的
  具体错误串；这些只按官方文档实现，判定逻辑只看状态码与 body 形状。
