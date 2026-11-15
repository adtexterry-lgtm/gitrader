> 许可证：CPAL-1.0。

# @gitrader/plugin-notify-webhook

Gitrader 的通知通道插件：把内核的 `notify.send` 调用按平台方言发到用户配置的 Webhook 地址。纯 `.mjs`，不经构建，由内核用 Node 子进程拉起（`cwd` = 插件目录），不 import 仓库里的任何包。

## 方言与主机

| 方言 | 识别规则（主机名精确匹配 + 路径前缀） | 清单里声明的主机 | 密钥参与方式 |
|---|---|---|---|
| `feishu` | 主机 `open.feishu.cn` / `open.larksuite.com` / `open.larkoffice.com` / `www.larksuite.com`，路径以 `/open-apis/bot/v2/hook/` 开头 | `open.feishu.cn` | 可选：`timestamp` + `sign` 写进请求体 |
| `dingtalk` | 主机 `oapi.dingtalk.com`，路径以 `/robot/send` 开头 | `oapi.dingtalk.com` | 可选：`timestamp` + `sign` 追加到 URL 查询串 |
| `wecom` | 主机 `qyapi.weixin.qq.com`，路径以 `/cgi-bin/webhook/send` 开头 | `qyapi.weixin.qq.com` | 不需要（key 在 URL 里） |
| `slack` | 主机 `hooks.slack.com`，路径以 `/services/` 开头 | `hooks.slack.com` | 不需要 |
| `discord` | 主机 `discord.com` / `discordapp.com`，路径以 `/api/webhooks` 开头 | `discord.com` | 不需要 |
| `generic` | 其它（含相似域名，如 `open.feishu.cn.example`） | **不在清单里**：自建端点的主机来自用户配置的 `params.url` | 可选，插件不用它 |

`generic` 的目标主机无法在安装时确定，所以清单的 `net.hosts` 只列五个平台主机；自建端点的地址由用户在 `params.url` 里给，内核按 `notify.channels[].params` 原样传入。

## 参数（`notify.channels[].params`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | Webhook 地址，只接受 `https:`；明文 `http:` 只允许发往本机回环（`127.0.0.1` / `localhost` / `[::1]`），其余明文目标返回 `insecure_url` |
| `markdown` | 否 | `true` 时按平台能力换排版：飞书消息卡片、钉钉 / 企业微信 markdown、Slack `mrkdwn`；不改写标题与正文内容 |

密钥配在 `gitrader.json` 的 `plugins.secrets` 里（值是 `env:变量名` 句柄，真值放在运行内核的环境变量里），不要写在 `notify.channels[].params`：

```json
"plugins": { "secrets": { "connector.gitrader.notify-webhook": { "WEBHOOK_SECRET": "env:MY_WEBHOOK_SECRET" } } }
```

内核启动插件进程时把它作为环境变量 `WEBHOOK_SECRET` 注入，插件只从 `process.env.WEBHOOK_SECRET` 读。密钥不打印、不进 `reason`、不随返回值回传；错误消息里出现密钥原文或它的 base64 一律换成 `<redacted>`。

`params` 里**不要**放密钥：配置校验会把 `secret` / `password` / `privateKey` 一类字段判为 `SECRET_FIELD_REJECTED`（连 `env:` 句柄写在 `params.secret` 里也一样被拒），密钥只走 `plugins.secrets`。

## 工具名

内核契约（B0）里的名字是 `notify.send`，但协议的工具名正则是 `^[A-Za-z0-9_-]{1,64}$`，不允许点号。因此清单只声明 `notify_send`，`provides.channels[0]` 记 `platform: "webhook"` 与支持方言；插件运行时也只注册 `notify_send`，点号名由内核侧映射（清单与运行时能力一致）。

## 返回形状

```
{ "ok": true, "ref": "<平台消息 id，平台不给就不带>" }
{ "ok": false, "reason": "<短句，已脱敏>", "retryable": true | false }
```

`retryable`：408 / 429 / 5xx / 超时 / 网络错误为 `true`（内部最多重试 2 次，退避 250 ms → 500 ms，单次请求超时 8 s，且一次调用的重试 + 退避 + 请求总预算 ≤ 8 s，超出即返回 `{ ok:false, reason:"timeout", retryable:true }`）；厂商返回的业务错误码（飞书 `code != 0`、钉钉 / 企业微信 `errcode != 0`、Slack `ok:false`）与其它 4xx 为 `false`。

Webhook URL 的 query 与深层 path 本身就是凭据：错误 `reason` 里出现的 URL 只保留 `origin + 路径第一段`，query 一律去掉，整条 URL 也并入脱敏清单。

## 测试

```
# 仓库根
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/plugin-notify-webhook
node packages/plugin-notify-webhook/run-conformance.mjs      # GSP 一致性套件 G01–G08
node node_modules/typescript/bin/tsc -p packages/plugin-notify-webhook --noEmit
```

单测里 `fetch` / `clock` / `sleep` 全部注入，离线跑。`run-conformance.mjs` 与 stdio 冒烟用 `GITRADER_PLUGIN_FAKE_FETCH=1` 打开插件内置的假响应（固定返回 `{ ok: true, ref: "fake-webhook-1" }`），不出网、不需要密钥。

`webhook.mjs` 复制自 `packages/kernel/src/notify/webhook.ts`（方言识别、签名、请求构造、响应校验），企业微信方言、Markdown 形态与重试退避对照 `QuantDinger v5.6.5` 的 `backend_api_python/app/services/notifications/webhook.py` 补齐；以库为准，改库时同步这里。

## 幂等键

内核每次调用在 `params.idempotencyKey` 里带幂等键（同一通道同一条通知恒定），插件放进请求头 `Idempotency-Key`；多块消息每块加 `:序号` 后缀。
