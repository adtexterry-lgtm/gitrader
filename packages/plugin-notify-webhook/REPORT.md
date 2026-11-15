# B4 · plugin-notify-webhook

## 改了什么

新建 `packages/plugin-notify-webhook/` 11 文件：`webhook.mjs`（复制 `packages/kernel/src/notify/webhook.ts`，补企业微信方言、markdown / 纯文本两形态、重试退避、脱敏）、`index.mjs`（notify.send 处理函数）、`gsp.mjs`（帧 / 批量 / 令牌 / 版本协商 / describe / health / shutdown / 5006 / 单行 1 MiB）、`gitrader-plugin.json`（五个平台主机）、`run-conformance.mjs`、README、LICENSE、package.json、tsconfig.json、`test/` 4 文件。

## 跑了什么

vitest 4 文件 38 例全过；run-conformance G01–G08 8 例全过；`tsc --noEmit` 0 错；hygiene 6 例全过；`check-public` 仅 assets/marketing 26 条基线。

## 没做什么

没接真实地址与真密钥，网络全用注入假 fetch 与 `GITRADER_PLUGIN_FAKE_FETCH=1`；没把 generic 主机写进清单（来自用户配置）。

## 需要主会话决定

1. 协议工具名正则不允许点号：B0 的 `notify.send` 无法声明，清单写 `notify_send`，运行时两个名字都收。
2. `net.fetch` 只许 connector / datasource / decision-model / engine：通知通道只能 `kind=connector`、`package=block`，id 因此是 `connector.gitrader.notify-webhook`。
3. `privacy.sends` 枚举无通知类，只能写 `[]`，发送内容写在 `risk.disclosure` 与 README。
