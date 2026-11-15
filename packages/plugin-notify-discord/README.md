> 许可证：CPAL-1.0。

# @gitrader/plugin-notify-discord

Discord 通知通道插件：纯 `.mjs`，不经构建，由内核用 Node 子进程拉起（GSP stdio），把内核通知发到 Discord 频道。与 `packages/notify-discord`（库）成对。

## 清单要点（`gitrader-plugin.json`）

- `tools[].name = "notify_send"`（内核通知出口按这个名字找通道）；`input` / `output` 见 B0 契约：输入 `{ notice, params }`，输出 `{ ok: true, ref? }` 或 `{ ok: false, reason, retryable }`。
- `secrets: ["DISCORD_WEBHOOK_URL"]`：webhook URL 本身就是密钥，内核按用户配置解析后**作为环境变量**注入；插件只从 `process.env` 读，不打印、不回传，`reason` 里也不会出现。
- `permissions: ["net.fetch"]` + `net.hosts: ["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]`：只出网到 Discord。
- `params` 只放非密钥参数：目前只有可选的 `threadId`（snowflake 十进制串，发到子区）。参数里出现密钥字段会被 GSP 以 `5006 SECRET_FIELD_REJECTED` 拒收。
- `privacy.hosted: false`；`privacy.sends` 是协议枚举（watchlist / positions / addresses / orders），通知文本不在其中，所以为 `[]`——实际发送内容写在 `risk.disclosure`。

## 行为

- 正文用固定模板渲染：`**[WARN]** 标题` + 逐行原文 + `<t:秒:f>` 时间戳；动态字符走 Markdown 子集转义；不加品牌文案、不改写事实。
- 超过 2000 字符按行分块、顺序发送（官方 content 上限），任何一块失败即停止。
- `allowed_mentions.parse` 恒为 `[]`：正文里出现 `@everyone` / 角色 / 用户提及都不会真的 @。
- 请求带 `wait=true`，用返回的 message id 当 `ref`。
- 429 按官方 `retry_after`（秒）等待后重试一次；等待超过 5 s 或会突破 8 s 总预算就不等，返回 `retryable: true`。401 / 404 / 400 不重试（令牌错、webhook 不存在、表单错，重发不会变）。

## 文件

| 文件 | 作用 |
|---|---|
| `gsp.mjs` | GSP stdio 循环：hello / 版本协商 / describe / health / tool.call / shutdown，秘密字段 5006，退出码 |
| `index.mjs` | `notify_send` 处理函数：读 `DISCORD_WEBHOOK_URL` → 渲染 → 分块 → 发送 → B0 形状 |
| `discord.mjs` | URL 校验 / 请求构造 / 响应判定 / 客户端（注入 fetch、超时、429 重试）、`redactSecrets` |
| `format.mjs` | Markdown 子集转义、2000 字符分块、固定模板 `renderNotice` |

`discord.mjs` / `format.mjs` 是 `packages/notify-discord/src/*.ts` 的 JS 版副本（插件不能 import 工作区包），改逻辑先改库。

## 本地跑

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/plugin-notify-discord
node node_modules/typescript/bin/tsc -p packages/plugin-notify-discord --noEmit
node packages/plugin-notify-discord/run-conformance.mjs
```

`GITRADER_PLUGIN_FAKE_FETCH=1` 时插件用内置假响应（`id = 4242`），不发任何网络请求；冒烟测试与协议一致性套件都靠它离线跑。
测试里的假服务器（`test/fake-server.ts`）按官方规则独立实现，不 import 插件或库的代码。

## 已验与未验

验过的：请求形状、200/204/429/4xx/5xx 判定、2000 分块、提及抑制、密钥不出现在任何应答里、GSP G01–G08。
没验的：没有对真实 Discord 端点发过请求；webhook 的实际创建与频道权限未覆盖；Markdown 渲染效果未在真客户端逐步核对。

- `params.apiBase`（可选，自托管 / 离线测试）：只取 origin 的 `https://` 地址（不带路径、查询串、凭据）；给了它，请求发到这个 origin，路径仍取自环境变量里的原 URL，官方主机检查改为只认它。不给则走官方地址 `https://discord.com`。明文 `http://` 回环（`127.0.0.1` / `localhost` / `[::1]`）只在测试开关（调用 handler 时 `deps.allowInsecureLoopback`）下放行，随包运行的插件进程里不会开。
- 每次调用内核在 `params.idempotencyKey` 里带幂等键，插件放进请求头 `Idempotency-Key`（多块消息每块加 `:序号` 后缀）；官方端点会忽略这个头，自建代理可用它去重。
