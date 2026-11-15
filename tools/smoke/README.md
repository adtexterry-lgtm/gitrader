> 许可证：CPAL-1.0。

# tools/smoke — 纸面模式端到端冒烟

一条命令证明「内核起得来 → 纸面交易可用 → 回测跑通 → 报告导出 → 账本有记录」。给发布前门禁和 CI 用：**全离线、不弹窗、不碰你自己的 `~/.gitrader`**。

```bash
node tools/smoke/journey.mjs            # 7 步旅程，输出步骤 / 耗时 / 结果表；任一步失败退出码 1
node --test tools/smoke/test/           # 辅助函数单测（不跑真旅程）
node tools/smoke/journey.mjs --keep --verbose   # 保留临时目录并打印每一步的细节
```

## 前提

- Node ≥ 22.13（仓库根已跑过 `npm run build -w gitrader`（产出 `packages/cli/dist/bin.js`）与 `npm run build -w @gitrader/engine-core`（产出 `packages/engine-core/dist/engine-core.mjs`））。
- 只用仓库已有的 `esbuild`（devDependency）把两个 TS 入口打成临时 ESM；不装任何新依赖、不联网。
- 不需要交易所密钥、不需要浏览器。

## 旅程（`journey.mjs`）

| 步 | 做什么 | 断言 |
|---|---|---|
| 1 | `mkdtemp` 临时 `GITRADER_HOME`；`init --no-pin`，再用 `GITRADER_PIN_STDIN` 非交互设 PIN | `gitrader.json` 有、`keys/pin.json` 由无到有 |
| 2 | 起 serve 子进程（随机空闲端口，记 PID），轮询 `/api/ready` | 60 s 内 HTTP 200（带 service.json 令牌） |
| 3 | `gitrader status --json` | `running:true`、有纸面账户、账本条数可读 |
| 4 | PIN 换工作台会话令牌 → `account.list` / `market.quote` → `order.place` 限价买入 | 订单成交（`filled`，20 s 内） |
| 5 | 建 Agent 钥匙 → 合成 1m K 线文件 → `agent.backtest run/result`（示例策略 `ema-cross`） | 60 s 内出 `stats` / `equity` |
| 6 | 回测结果喂 `@gitrader/report` 的 `run()` | 写出 Markdown + HTML，Markdown 含固定免责声明 |
| 7 | `gitrader ledger verify --json` + `ledger.query` | 校验通过，且含 `order.intent` / `fill` / `backtest.completed` |

清理：先向自己起的子进程 stdin 写 `stop` 请它优雅停机，8 s 不退才按**自己记录的 PID** 结束；临时目录默认删除（`--keep` 保留）。

## 离线是怎么做到的

`lib/host.ts` 走的还是 `runServe()`（和 `gitrader serve` 同一条路：真内核、真 HTTP、真 service.json 令牌），只把连接器装配换成 `PaperVenue` + 进程内固定盘口（`hyperliquid:BTC`，bid 79999 / ask 80001 / last 80000，时间戳取当前时刻）。所以没有网络、没有交易所、没有浏览器，行情也不是录制的夹具。回测的 K 线是脚本自己合成的 600 根 1m 柱（`data.source: 'files'`），只验证管道，不代表任何行情。

## 已知限制（如实写）

- 盘口是固定值：不测滑点、盘口深度变化、行情中断、陈旧价保护触发后的拒绝路径。
- 合成 K 线只用于证明回测管道通；`stats` 数字没有业绩含义。
- 需要随包引擎能被内核解析到（`GITRADER_ENGINE_CORE_BUNDLE`，脚本已指向仓库产物）；引擎起不来时第 5 步会如实失败，不降级绕过。
- PIN 用脚本内的固定测试值，只存在于临时 home，与用户真实 PIN 无关。
- Windows 上 `process.kill(pid)` 是强制结束；只在优雅停机超时后才用。
- 报告 HTML 只校验生成成功与体积，不做渲染 / 像素校验。
