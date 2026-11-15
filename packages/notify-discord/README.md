> License: CPAL-1.0 (see the repository root LICENSE).

# @gitrader/notify-discord

通知通道插件的客户端库：Discord 通知文本渲染（2000 字符上限）+ `POST /webhooks/{id}/{token}` 发送。不含内核接线。

- webhook URL 只从调用方传入（`url`）：库不读环境变量、不落盘、不打印；`reason` 一律先过 `redactText`（token 与整条 URL 都抹掉）。
- 只接受官方主机（`discord.com` / `discordapp.com` / `canary` / `ptb`）的 `https://<主机>/api/webhooks/<id>/<token>`；`http`、非官方主机、`/slack` 与 `/github` 兼容路由、带查询串的 URL 一律拒绝。
- 正文超过 2000 字符按行分块（`sendText`），单行超长按码点硬切。
- 请求固定带 `wait=true`：这样 Discord 回 message 对象，`ref` 取 message id；不带时官方只回 204，拿不到 id。
- `allowed_mentions.parse` 恒为 `[]`：通知正文里的 `@everyone` / 角色 / 用户提及都不会触发提及。
- 429 按官方 `retry_after`（秒）等待后重试一次；等待超过 5 s 或会突破总预算时不等，直接返回 `retryable: true`。4xx（401 令牌错、404 webhook 不存在、400 表单错）不重试。

## 用法

```ts
import { DiscordWebhookClient, renderNotice } from '@gitrader/notify-discord'

const client = new DiscordWebhookClient({ url: process.env.DISCORD_WEBHOOK_URL ?? '' })
await client.sendText(renderNotice({ title: 'Risk denial', lines: ['account acct_x'], ts: Date.now(), level: 'warn' }))
```

`fetchImpl` / `clock` / `sleep` / `timeoutMs`（缺省 4 s）/ `maxRetries`（缺省 1）/ `maxRetryAfterMs`（缺省 5000）都可注入，测试全程离线。

## 官方依据（每条实现都对得上文档）

| 行为 | 出处 |
|---|---|
| `POST /webhooks/{webhook.id}/{webhook.token}`、`wait`、`thread_id`、`content` ≤2000、`allowed_mentions` | https://discord.com/developers/docs/resources/webhook#execute-webhook |
| 返回 message 对象或 `204 No Content`（取决于 `wait`） | 同上 |
| 429 结构 `{ message, retry_after, global }` 与 `Retry-After` 头、`X-RateLimit-*` | https://discord.com/developers/docs/topics/rate-limits |
| 错误体 `{ message, code }`；`10015` Unknown webhook、`50027` Invalid webhook token、`50035` Invalid form body；`<t:秒:f>` 时间戳语法 | https://discord.com/developers/docs/topics/opcodes-and-status-codes#json-json-error-codes 、https://discord.com/developers/docs/reference#message-formatting |
| 客户端要带 `DiscordBot ($url, $versionNumber)` 形式的 User-Agent | https://discord.com/developers/docs/reference#user-agent |

## 已验与未验（别把这条读成「对着真 Discord 跑过」）

验过的：请求形状（路径、查询参数、body 字段）、200/204/429/4xx/5xx 的判定、2000 字符分块、`allowed_mentions.parse` 为空时假服务器不产生提及、token 不出现在任何 `reason` 里。判定依据是 `test/fake-discord.ts`——它按官方规则**独立**实现（不 import `src/`，`test/independence.test.ts` 会核对）。

没验的：
- 没有对真实 Discord 端点发过请求（本包测试全离线）；
- 官方文档没有逐字列出 Markdown 转义字符表，`escapeDiscordMarkdown` 的字符集按客户端实际行为取（`\ * _ ~ ` | > [ ]`），渲染效果未在真客户端逐字核对；
- 错误码到 HTTP 状态的映射（如 50027 常配 401、10015 常配 404）来自错误码表语义，文档未逐条写明；
- `errors.<field>._errors[]` 的细分码（`BASE_TYPE_REQUIRED` / `BASE_TYPE_MAX_LENGTH`）官方只给了示例，假服务器照示例形状写，只用于让失败更可读，客户端不依赖它们。

## 本地跑

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/notify-discord
node node_modules/typescript/bin/tsc -p packages/notify-discord --noEmit
```
