# 标段 B2 · packages/plugin-notify-telegram

**改了什么**

新建 `packages/plugin-notify-telegram/`（纯 `.mjs`，无构建）：`gitrader-plugin.json`（kind `connector`、`net.fetch` + `net.hosts ["api.telegram.org"]`、`secrets ["TELEGRAM_BOT_TOKEN"]`、`tools[]` 声明 `notify.send` 并按 B0 写 input / output Schema）、`gsp.mjs`（GSP stdio：hello 令牌、0.1.x 版本协商、describe / health / tool.call / shutdown、秘密字段 5006、退出码）、`index.mjs`（处理函数：令牌只读环境变量、`params.chatId` 必填、`renderNotice` → 4096 分块 → `sendMessage`、8 s 超时、错误脱敏）、`telegram.mjs` / `format.mjs`（复制自 `packages/notify-telegram/src/{telegram,format}.ts`，文件头注明来源与 QD 行号）、`run-conformance.mjs`、`README.md`、`LICENSE`、`package.json`、`tsconfig.json`、`test/` 四个测试文件。

**跑了什么**

- `vitest --root packages/plugin-notify-telegram`：4 文件 18 例全过（清单、处理函数、脱敏、stdio 冒烟）。
- `tsc -p packages/plugin-notify-telegram --noEmit`：退出码 0。
- protocol `test/hygiene.test.ts`：1 文件 6 例全过。
- `node packages/plugin-notify-telegram/run-conformance.mjs`：6 passed / 2 failed（G03、G05）；加 `--alias`（临时副本只换工具名）8 passed，即 G01–G08 全过。

**没做什么**

没联网、没调真 Telegram、没读任何密钥；没动 `packages/protocol|kernel|cli|mcp|connector-hyperliquid|engine-core/src` 与 `docs/`；没 git、没 install、没加第三方依赖。

**需要主会话决定**

1. `packages/protocol/src/plugin/manifest.ts:144` 的 `PLUGIN_TOOL_NAME_RE`（`^[A-Za-z0-9_-]{1,64}$`）不收点号，而通道契约的工具名就是 `notify.send`。清单按契约保留该名，于是 `validatePluginManifest` 在 `/tools/0/name` 报一条 `pattern` 问题，套件 G03 / G05 因此失败，内核侧 `rec.ok` 也会是 false。建议改成 `/^[A-Za-z0-9_.-]{1,64}$/`：改完默认跑法 8/8，本包清单无需改动；插件运行时已同时接受 `notify.send` 与 `notify_send`。
2. `privacy.sends` 枚举只有 watchlist / positions / addresses / orders，装不下「通知文本 + chatId」，现取 `[]`，实际发送内容写在 `risk.disclosure`。

## 主会话批复（2026-10-21 凌晨）
工具名已统一 `notify_send`（Claude opus-5 拍板：契约改字优于等外部设计方放宽协议正则）。conformance 8/8 全绿。B0 契约与内核出口的 `notify.send` 改字由主会话登记执行。
