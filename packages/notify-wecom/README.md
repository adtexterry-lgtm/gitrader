> License: CPAL-1.0 (see the repository root LICENSE).

# @gitrader/notify-wecom

企业微信群机器人通知通道的客户端库：消息渲染 + webhook 发送。不含内核接线。

## 官方依据

| 事项 | 出处 |
|---|---|
| 入口地址 `POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>` | 企业微信开发者文档「群机器人配置说明」https://developer.work.weixin.qq.com/document/path/91770 |
| `msgtype: markdown`（`markdown.content`）/ `msgtype: text`（`text.content`） | 同上 |
| content 上限：markdown 4096 字节、text 2048 字节，均 UTF-8 | 同上 |
| 每个机器人 20 条/分钟 | 同上 |
| 错误码语义（0 成功；45009 超频；-1 系统繁忙；93000 invalid webhook url） | 企业微信开发者文档「全局错误码」https://developer.work.weixin.qq.com/document/path/90313 |

企业微信群机器人**没有**签名参数（与钉钉不同）：鉴权就是这个 `key`，等同该群的写入权限。

## 用法

```ts
import { WeComClient } from '@gitrader/notify-wecom'

const client = new WeComClient({
  webhookUrl: process.env.WECOM_WEBHOOK_URL ?? '',
  fetchImpl,            // 测试注入；缺省用全局 fetch
  clock: () => Date.now(),
})
await client.sendNotice({ title: 'Risk denial', lines: ['rule Y', 'notional 1200 > 1000'], level: 'warn', ts: Date.now() })
```

- 渲染：markdown 形态为 `### [WARN] 标题` + 每条事实一行 + ISO 时间（行内代码）；text 形态首行 `[WARN] 标题`。
  只接受 `title` / `lines` / `ts` / `level` 四个字段，其余字段不读——通道不掺自由文本。
- 分块：上限按 **UTF-8 字节**（与 Telegram 的字符上限不同）。按行切、行不跨块；单行超限时在码位边界硬切，
  不会切出半个汉字或半个代理对。
- 错误：`WeComConfigError`（地址 / key 形状不对，`retryable=false`）；`WeComError.retryable` 为
  `true`（超时、网络错误、HTTP 429/5xx、45009 与 -1 重试用尽）或 `false`（4xx、其它非 0 errcode）。所有 reason
  先过 `redactSecret`：key 的原样 / URL 编码 / base64 形式与任何 `key=` 查询参数都替换成 `<redacted>`。
- 节流：同一机器人默认 3 s 间隔（官方 20 条/分钟）；单次发送总预算 8 s，可重试失败最多再试一次。
- 去重与限流由内核负责（`notify.rateLimit`），通道每次调用都如实发送。

## 与 Telegram 通道的差异

| 维度 | Telegram | 企业微信 |
|---|---|---|
| 鉴权 | URL 里的 bot token | URL 里的 `key`（无签名） |
| 长度上限 | 4096 **字符**，按字符分块 | markdown 4096 **字节** / text 2048 **字节** |
| 转义 | MarkdownV2 需转义 18 个保留字符 | 无转义机制，字符原样；只折平换行、去控制字符 |
| 成功响应 | `{ok:true, result:{message_id}}` → `ref` 有值 | `{errcode:0, errmsg:"ok"}`，**没有消息 id** → 不返回 `ref` |
| 超频信号 | HTTP 429 + `parameters.retry_after` | HTTP 200 + `errcode: 45009` |

## 测试与验收

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/notify-wecom
node node_modules/typescript/bin/tsc -p packages/notify-wecom --noEmit
```

`test/helpers/fake-wecom.ts` 是离线假服务器：进程内 fetch，不开端口、不联网，**不 import 本库任何代码**，
自己算字节数、自己校验域名 / 路径 / 方法 / content-type / msgtype / content 上限，成功回官方形状。
