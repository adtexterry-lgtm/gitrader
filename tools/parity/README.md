> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# tools/parity · 回测—纸面一致性测试台

**要量的是**：同一策略、同一份历史 K 线，回测与「纸面内核 + 历史回放」跑出来的订单序列、成交序列、最终权益差多少。
**结论先说**：本仓库的**内核纸面模式今天没有历史回放入口**，所以本台按工单的停机规则只交**差异表格式 + 回测一侧的真实产出**，并把「缺什么、建议加在哪」写成 `preflight.missing`（同时进 `reports/hermes/REPORT-7-Q4.md`）。

## 侦查结论（只读源码，不动内核）

| 事实 | 证据 |
|---|---|
| 纸面场所（`kernel-sim`）在 CLI 里由活行情源 + 内核系统时钟构造，没有任何参数能换成回放行情 / 模拟时钟 | `packages/cli/src/connectors.ts:181` |
| 内核与 CLI 都不构造 `ReplayMarket`、不调 `runReplay`（0 处） | `packages/kernel/src`、`packages/cli/src` |
| `gitrader.json` 没有回放 / 历史数据源配置键 | `packages/kernel/src/config.ts` |
| 协议方法表没有宿主驱动纸面回放的方法 | `packages/protocol/src/gep/methods.ts` |
| **库级回放能力是有的**：`ReplayMarket` + `runReplay` 按帧推进盘口、时钟由回放驱动 | `packages/venue-paper/src/replay.ts:18,70` |
| 引擎的 `replay.start` 复用回测同一个 `Simulator`，是「防前视偏差」的自证，不是独立纸面通道 | `packages/engine-core/src/runtime/replay.ts:94` |

这六条由 `lib/preflight.mjs` 每次运行时**重新统计**（不是硬编码结论），任一接线补齐后 `verdict` 会自动变成 `ok`。

## 用法

```bash
# 回测一侧（离线；数据用协议支持的 spec.data.source='files'）
node tools/parity/run-parity.mjs \
  --candles tools/parity/fixtures/klines-1h-240.json \
  --strategy ema-cross --instrument hyperliquid:BTC --interval 1h \
  --out tools/parity/out

# 有纸面运行记录时补上纸面一侧（~/.gitrader/paper-state.json 是内核落的盘）
node tools/parity/run-parity.mjs ... --paper-state ~/.gitrader/paper-state.json --account acct_...
```

产物：`out/preflight.json`、`out/backtest-run.json`、`out/paper-run.json`（有则出）、`out/parity-diff.json`、`out/parity-report.md`。
退出码：`0` 产出已写盘（含停机分支）、`1` 回测一侧失败、`2` 参数错误。

前置：引擎 dist 必须存在（`node packages/engine-core/build.mjs`，本台**不构建、不改源码**）；`--help` 看全部参数。

## 目录

```
tools/parity/
├── run-parity.mjs          主入口：预检 → 回测一侧 → （有纸面记录才）比对 → 落盘
├── lib/preflight.mjs       能力预检：六条接线逐条查，给 file:line 证据与缺项清单
├── lib/gep-stdio.mjs       GEP over stdio（NDJSON，1 MiB 帧上限）；宿主侧只实现握手与请求
├── lib/backtest-leg.mjs    回测一侧：GEP backtest.run + data.source=files，产出规范形
├── lib/artifact.mjs        两侧归一到 gitrader-parity-run/1（回测结果 / paper-state.json）
├── lib/diff.mjs            差异计算：订单 / 成交 / 权益 / 能力声明，四类容差
├── lib/report.mjs          差异表渲染：Markdown 九列 + JSON
├── FORMAT.md               格式契约（列定义、严重度规则、JSON 形态、停机分支长什么样）
├── fixtures/               合成 K 线（240 根 1h，无真实行情）
└── test/                   node --test（6 文件 32 例）
```

## 测试

```bash
node --test tools/parity/test/                    # 6 文件 32 例，全离线
node --test "tools/parity/test/*.test.mjs"        # 等价写法
node --test tools/parity/test/diff.test.mjs       # 单组
```

其中 **3 例起真引擎**（`backtest.test.mjs`：用 `fixtures/` 的合成 K 线跑 ema-cross，断言成交 > 0、两次跑逐笔一致、未知策略如实报错），另 2 例查 K 线文件摘要与默认路径；dist 不存在时这 3 例 skip 而不是假过。
假引擎 `test/fixtures/fake-engine.mjs` 只用来验 GEP 传输层这半边（握手 / 请求 / `host.*` 回 -32601 / 关停），**不与真引擎共用编码**，避免「自写参照自证」。

## 边界与红线

- **只新建** `tools/parity/`；不 import 任何包源码，只经 **公开接口**（GEP、`paper-state.json` 产物）说话；不改 kernel / protocol / cli / engine-core。
- 零第三方依赖，只用 Node 内置模块；不联网、不装包、不限速。
- 回测一侧的数据是**合成 K 线**：数字只用于比对机制，不代表任何收益。
- 本台不宣布「一致」：没有阻断行也只说 `partly-unverifiable`（因为回测侧没有订单对象），说「一致」需要订单序列两侧都有——那要等内核补齐纸面回放入口后由主会话决定。
