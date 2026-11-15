> 许可证：CPAL-1.0。

# plugin-notify-email · 邮件通知通道插件

一个声明了通知工具（清单里写作 `notify_send`；B0 契约的 `notify.send` 由内核侧映射，插件只暴露清单名）的纯 `.mjs` 插件：内核把每条通知当一次 `tool.call` 发进来，插件把它渲染成纯文本 + HTML 邮件，经用户配置的 SMTP 主机发出。不经构建，内核用 Node 子进程拉起（`cwd` = 本目录），只依赖 node 标准库。

- SMTP 与 MIME 逻辑是 `packages/notify-email/src/{smtp,mime,render,secret}.ts` 的 JS 副本（**以库为准**，`smtp.mjs` / `mime.mjs` / `render.mjs` / `secret.mjs` 文件头都标了来源）；插件不 import 任何工作区包。
- 认证信息只从环境变量 `SMTP_PASSWORD` 读（清单 `secrets: ["SMTP_PASSWORD"]`，由内核按用户配置注入）；不落盘、不打印、不回传，失败 `reason` 一律过脱敏（原文与 base64 形态都替换成 `<redacted>`）。
- 本地 relay：`params.user` 留空且没有口令时不做认证，直接投递；`params.user` 有值却没有口令时返回 `{ok:false, retryable:false}`，不发起半个会话。
- 内部网络超时总预算 8 s（内核默认 10 s）：整个 `send` 共用一份预算，每次读只拿剩余额度，超出即关连接并返回 `{ok:false, retryable:true, reason:'timeout'}`；4xx（421 / 450 …）与网络类错误 → `retryable:true`，5xx（550 / 535 …）→ `retryable:false`。

## 配置（`notify.channels[].params`）

```json
{
  "channel": "connector.gitrader.notify-email",
  "params": {
    "host": "smtp.example",
    "port": 465,
    "secure": true,
    "user": "bot@example",
    "from": "bot@example",
    "to": ["ops@example"],
    "subjectPrefix": "[Gitrader] "
  }
}
```

`port` 缺省 465（`secure: true`）或 587（明文起手，服务端宣告 STARTTLS 时升级）；`secure` 缺省按端口推断。口令不存在 `params` 里，用内核的密钥句柄（`env:` 引用）提供给 `SMTP_PASSWORD`。

## `net.hosts` 的说明

协议没有「任意主机」的写法（`net.hosts` 每项必须形如 `host` 或 `*.domain`，`"*"` 过不了校验），而 SMTP 主机来自用户配置。清单因此只静态声明 `localhost`（本地 relay 场景）；装到真实 SMTP 时需要在安装配置里补上该主机，或由内核在授予 `net.fetch` 时按 `params.host` 放行——这一条要主会话在协议层定，插件侧无法自行放宽。

## 离线测试

```bash
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/plugin-notify-email
node packages/plugin-notify-email/run-conformance.mjs   # packages/protocol/conformance/gsp，G01–G08
node node_modules/typescript/bin/tsc -p packages/plugin-notify-email --noEmit
```

假连接：`fake-smtp.mjs` 是 `packages/notify-email/test/smtp.test.ts` 里 fakeServer 的 JS 版，按命令回预设应答并记录命令序列；`GITRADER_PLUGIN_FAKE_FETCH=1` 时插件进程用它替代真实连接（一致性套件与 stdio 冒烟都走这条路），返回的消息 id 固定为 `fake-smtp-1`。单测里连接由 `handleNotify(input, { connect })` 注入，口令由 `{ password }` 注入，都不读真实环境。

## 已知边界

- 只做了 STARTTLS / 隐式 TLS 的会话流程与错误分类，**没有对真实 SMTP 服务器联网验证过**（本仓库的测试全部离线）。
- 不发附件、不签名（DKIM）、不做队列与重试——重试由内核按 `retryable` 决定。
- 主题前缀与正文不改写通知内容；超长正文不分块（邮件没有平台字数上限）。
