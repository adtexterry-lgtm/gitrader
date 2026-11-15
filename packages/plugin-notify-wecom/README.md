> 许可证：CPAL-1.0。

# @gitrader/plugin-notify-wecom

企业微信通知通道插件：纯 `.mjs`，不经构建，由内核用 Node 子进程拉起（GSP stdio），把内核通知发到企业微信群机器人。

## 清单要点（`gitrader-plugin.json`）

- `tools[].name = "notify_send"`（内核通知出口按这个名字找通道）；`input` 只有 `notice` 必填，`params` 可选。
  输入输出形状见 `docs/notifications.md` 与 B0 契约。
- `permissions: ["net.fetch"]` + `net.hosts: ["qyapi.weixin.qq.com"]`：只出网到企业微信官方入口。
- `secrets: ["WECOM_WEBHOOK_URL"]`：内核按用户配置解析后**作为环境变量**注入，插件只从 `process.env` 读，
  不打印、不回传。地址必须是 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`，其它域名 / 路径 /
  `http` 一律拒绝（`retryable=false`）——这道校验挡住「把 key 发到别人主机」。
- `privacy.hosted: false`；`privacy.sends` 只能是协议枚举的四类（watchlist / positions / addresses / orders），
  通知正文不属于其中任何一项，因此为 `[]`——实际发送内容写在 `risk.disclosure` 里。
- 内部网络超时 8 s（`DEFAULT_TIMEOUT_MS`，含重试共用一份预算）；可重试失败最多再试一次
  （45009 / -1 / 429 / 5xx / 超时 / 网络错误）；93000 与其它非 0 errcode 不重试。

## 正文规则（两条硬规则的通道侧落地）

1. **自由文本不进正文**：只渲染 `notice.title` / `notice.lines` / `notice.ts` / `notice.level` 四个字段；
   `notice` 里的 `reason`、`memo` 之类字段不读。`params` 里出现 `content` / `text` / `body` / `footer` /
   `prefix` / `suffix` / `template` / `title` / `lines` 时直接拒绝（不是悄悄忽略），免得调用方以为塞进去了。
2. **短密钥不参与回显**：webhook key 建议用 ≥8 字符的随机串。

去重与限流由内核负责（`notify.rateLimit`），通道每次调用都如实发送。

## 文件

| 文件 | 作用 |
|---|---|
| `gsp.mjs` | GSP stdio 循环：hello / 版本协商 / describe / health / tool.call / shutdown，秘密字段 5006，退出码 |
| `index.mjs` | `notify_send` 处理函数：读环境变量 → 校验地址 → 渲染 → 字节分块 → 发送 → B0 形状 |
| `wecom.mjs` | webhook 客户端（地址校验与归一化、errcode 分支、超时、脱敏） |
| `format.mjs` | markdown / text 渲染、UTF-8 字节计量、按字节分块 |

`wecom.mjs` / `format.mjs` 是 `packages/notify-wecom/src/*.ts` 的 JS 版副本（插件不能 import
工作区包），改逻辑先改库。

## 本地跑

```
node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/plugin-notify-wecom
node packages/plugin-notify-wecom/run-conformance.mjs      # G01–G08
node node_modules/typescript/bin/tsc -p packages/plugin-notify-wecom --noEmit
```

`GITRADER_PLUGIN_FAKE_FETCH=1` 时插件用内置假响应（`{"errcode":0,"errmsg":"ok"}`），不发任何网络请求；
冒烟测试与协议一致性套件都靠它离线跑。真实发送需要 `WECOM_WEBHOOK_URL`（群机器人地址，含 key）。

## 工具名与输出

清单里 `tools[].name` 是协议合法名 `notify_send`（`^[A-Za-z0-9_-]{1,64}$` 不接受点号）；B0 契约里的
`notify.send` 由内核侧映射，插件只暴露清单名。

成功返回 `{"ok": true}`——企业微信的成功响应里没有消息 id，所以**不给 `ref`**（B0 里 `ref` 是可选字段）。
失败返回 `{"ok": false, "reason": ..., "retryable": ...}`，`reason` 已脱敏。

- `params.apiBase`（可选，自托管 / 离线测试）：只取 origin 的 `https://` 地址（不带路径、查询串、凭据）；给了它，请求发到这个 origin，路径仍取自环境变量里的原 URL，官方主机检查改为只认它。不给则走官方地址 `https://qyapi.weixin.qq.com`。明文 `http://` 回环（`127.0.0.1` / `localhost` / `[::1]`）只在测试开关（调用 handler 时 `deps.allowInsecureLoopback`）下放行，随包运行的插件进程里不会开。
- 每次调用内核在 `params.idempotencyKey` 里带幂等键，插件放进请求头 `Idempotency-Key`（多块消息每块加 `:序号` 后缀）；官方端点会忽略这个头，自建代理可用它去重。
