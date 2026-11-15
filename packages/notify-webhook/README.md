> 许可证：CPAL-1.0。

# @gitrader/notify-webhook

通知通道的 Webhook 客户端库：方言识别（飞书 / 钉钉 / 企业微信 / Slack / Discord / 自建）、厂商签名、请求构造、
响应校验、带退避的重试。只用 node 标准库（`node:crypto`），不含内核接线，不发任何内置网络请求以外的东西。

- 移植起点：`packages/kernel/src/notify/webhook.ts`（内核里的同一份逻辑）；本库补齐企业微信方言、Markdown / 纯文本
  两种消息体形态、`retryable` 判定与重试客户端。上游 QD 出处见各函数上方注释。
- 密钥只从构造参数进：不读环境变量、不落盘、不打印、不进任何返回值；错误原因串统一过 `redactSecret`
  （原文与它的 base64 形态都换成 `<redacted>`）。
- fetch / 时钟 / 等待都可注入，测试全离线。

## 用法

```ts
import { WebhookClient } from '@gitrader/notify-webhook'

const client = new WebhookClient({
  url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxx',
  secret: process.env.FEISHU_BOT_SECRET ?? '',
  timeoutMs: 4000,
  maxRetries: 1,
})

const result = await client.send('BTC 资金费率 0.3%', { title: '资金费率告警' })
// { ok: true, status: 200 }
// { ok: false, reason: 'http_503', retryable: true }
```

`send` 永不抛：网络错误 / 超时 / 厂商错误都折算成 `{ ok: false, reason, retryable }`。
`reason` 是短句（≤300 字符，超长截断加 `...`），不含密钥；文本里出现的 Webhook URL 会被收成
`origin + 路径第一段`（query 与深层 path 本身是凭据，一律去掉），整条 URL 也计入脱敏清单。

## 方言与消息体

| 方言 | 识别路径片段 | 缺省形态 | 签名 |
|---|---|---|---|
| `feishu` | `open.feishu.cn` / `open.larksuite.com` / `open.larkoffice.com` / `www.larksuite.com` + `/open-apis/bot/v2/hook/` | 纯文本 `msg_type: text`（`markdown: true` 时改发 `interactive` 卡片，`lark_md`） | body 里 `timestamp`（秒，字符串）+ `sign` |
| `dingtalk` | `oapi.dingtalk.com/robot/send` | Markdown `msgtype: markdown`（`### 标题`） | URL 查询串 `timestamp`（毫秒）+ `sign` |
| `wecom` | `qyapi.weixin.qq.com/cgi-bin/webhook/send` | Markdown `markdown.content` | 无（密钥已在 URL 的 `key` 参数） |
| `slack` | `hooks.slack.com/services/` | `{ text }`，标题 `*加粗*` | 无 |
| `discord` | `discord.com/api/webhooks` | `{ content }`，标题 `**加粗**` | 无 |
| `generic` | 其它 | `{ text }`，纯文本 | 无 |

纯文本形态（`markdown: false`）对每种方言都可用：标题作为正文首行，不做任何标记语法。
UTF-8 原样发送；正文**不截断、不改写**（厂商尺寸上限由调用方负责），只有 dingtalk 的 `markdown.title` 字段按厂商限制
截到 64 字符。

## 签名

- `signFeishu(secret, timestampSec)`：`HMAC-SHA256(secret = "<ts>\n<secret>", message = "")` → base64（不 URL 编码）。
- `signDingtalk(secret, timestampMs)`：`HMAC-SHA256(key = secret, message = "<ts>\n<secret>")` → base64 → **URL 编码**
  （返回值已编码，拼 URL 时不要再编码一次）。

时间戳由 `clock()` 派生（缺省 `Date.now()`），每次尝试重新取，重试不会复用过期签名。

## 响应校验与重试

| 情形 | `ok` | `retryable` |
|---|---|---|
| 飞书 `code` / `StatusCode` 为 0；钉钉 / 企业微信 `errcode` 为 0；非 JSON 或回空 body | true | — |
| 厂商非 0 码（`<dialect>_error:code=<码>:<msg>`） | false | false |
| Slack 文本 `ok` 或 JSON 对象 | true | — |
| Slack `{"ok":false,...}`（`slack_error:<error>`） | false | false |
| Discord 204 / 任意 2xx | true | — |
| 408 / 429 / 500 / 502 / 503 / 504 | false | true |
| 其它 4xx | false | false |

重试：指数退避 `min(maxBackoffMs, backoffBaseMs × 2^retry)`，缺省基数 500 ms、上限 2000 ms，次数上限 `maxRetries`
（缺省 1）。缺省超时 4000 ms —— 内核给插件的调用预算 10 s，4 s × 2 次尝试仍在预算内。

## 备注（与 QD 的差异）

- QD `notifications/webhook.py` 本身没有重试逻辑（`grep -n "retry\|backoff"` 无命中）；重试与「429 / 5xx 可重试」
  的集合取自 QD `signal_notifier.py:832-835`，其余按标段 B0 的返回契约实现。
- QD 会把正文 `shorten(..., 4000)`；本库不截断（内核契约要求插件不改写 `title` / `lines` 内容）。

## 测试

离线，注入假 fetch / 假时钟 / 立即返回的 sleep：

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/notify-webhook
node node_modules/typescript/bin/tsc -p packages/notify-webhook --noEmit
```
