> 许可证：CPAL-1.0。

# @gitrader/notify-email

通知通道的邮件客户端库：SMTP 会话（`SmtpClient`）+ RFC 5322 / MIME 报文构造（`buildMime`）+ 通知模板（`renderMail`）。
只用 node 标准库（`node:net` / `node:tls` / `node:crypto`），不含内核接线。

- 连接由调用方注入（`SmtpOptions.connect`），缺省用 `node:net`（明文，遇 STARTTLS 就地升级）/ `node:tls`（465 隐式 TLS）。
- SMTP 密码只从构造参数进：库不读环境变量、不落盘、不打印；错误消息统一经 `redactSecret`，且不回显认证命令原文。
- 超时（`timeoutMs`，缺省 15000ms）与时钟（`clock`）都可注入，测试离线跑。
- `buildMime` 负责头与正文（UTF-8 主题走 RFC 2047、行尾 CRLF、有 html 时 multipart/alternative）；dot-stuffing 由 `send` 在 DATA 阶段做。

## 在测试里注入假连接

```ts
import { SmtpClient } from '@gitrader/notify-email'

const client = new SmtpClient({
  host: 'localhost',
  port: 587,
  secure: false,
  user: 'bot',
  password: 'test-password',
  from: 'bot@localhost',
  connect: async () => ({
    write: (line: string) => commands.push(line),
    readLine: async () => replies.shift() ?? '250 ok',
    upgradeTls: async () => { upgrades += 1 },
    close: () => { closed = true },
  }),
})

const { accepted, messageId } = await client.send({
  to: ['one@localhost', 'two@localhost'],
  subject: '资金费率告警',
  text: '正文',
})
```

## 会话顺序

`EHLO` →（未加密且服务端报 `STARTTLS`：`STARTTLS` + TLS 升级 + 再 `EHLO`）→ 有 `user` 时 `AUTH PLAIN`（只给 `LOGIN` 时走 `AUTH LOGIN`）→ `MAIL FROM` → `RCPT TO`×n → `DATA` → `QUIT`。
4xx / 5xx 抛 `Error`，消息含应答码与应答文本；读应答超时抛含 `timeout` 的 `Error`。任一收件人被拒（应答非 250 / 251）即整体中止、不投递。

## 提示模板

```ts
import { renderMail } from '@gitrader/notify-email'

const { text, html } = renderMail({ title: '资金费率告警', lines: ['BTC 费率 0.3%'], ts: Date.now(), level: 'warn' })
```

版式与 `@gitrader/notify-telegram` 的 `renderNotice` 一致：首行 `[INFO] / [WARN] / [CRIT]` + 标题，逐条一行，末行 ISO 时间；无品牌文案、无表情符号。
