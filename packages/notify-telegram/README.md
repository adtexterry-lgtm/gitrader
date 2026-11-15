> License: CPAL-1.0 (see the repository root LICENSE).

# @gitrader/notify-telegram

通知通道插件的客户端库：MarkdownV2 渲染 + Telegram `sendMessage` 发送。不含内核接线（S5 做）。

- token 只从调用方传入（`TelegramClientOptions.token`）：库不读环境变量、不落盘、不打印。
- 错误消息经 `redactToken` 处理，不含 token。
- 文本超过 4096 字符时按行自动分块，顺序发送。

## 在测试里注入 fetch

```ts
const client = new TelegramClient({
  token: '123:test-token',
  fetchImpl: async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { 'content-type': 'application/json' },
    }),
})
await client.sendMessage(1, 'hello')
```

`clock` 同样可注入（缺省 `Date.now()`）；`minIntervalMs` 控制同一 chat 的最小发送间隔。
