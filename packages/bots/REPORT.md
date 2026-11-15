# REPORT · T3 `packages/bots`（四机器人模板）

## 一、做了什么
新建 `packages/bots`：11 个源文件、8 个测试文件 86 例、README、LICENSE、本报告。四模板（网格 / 定投 / 马丁 / 趋势）+ 纸面执行引擎；参数声明照 engine-core 策略约定，只 import engine-core 公开 API（`Candle` 类型、`validateStrictParams`、测试用 `synthCandles`），未改 engine-core 任何文件。零第三方依赖，不下单、不联网、不读外部状态。

## 二、怎么做的
借 QD 的口径不抄码（Apache-2.0，参照清单见 README）：格数 = 边界线 − 1（`levels.py`）、越界三档 `pause/stop_loss/hold`（`engine.py::handle_boundary`）、先记账后回报的顺序（`fill_handler.py`）、对账宁报错不猜（`ledger_reconcile.py`）、四模板参数键与区间（`parameter_space.py`、`strategy_bot_recommend.py`）。安全上限进参数校验不只进文档：全模板 `maxExposureNotional`；马丁 `maxAdds` + `maxTotalNotional`；DCA `maxOrders`。超限只有「拒单 + 停机」，没有截断路径。G16 落法：K 线非有限、时间不递增、格状态与级别不符、长仓账本被要求做空、空仓调平仓，一律抛 `BotStateError`，不返回猜测值继续跑。

## 三、验证（实跑）
`vitest` 86/86、`tsc` 0、`check-public` 0、`audit-headers` 0。反证三次：把马丁 `maxAdds` 判断改坏 → 4 红（「恰好 3 笔」用例在列）；把引擎敞口闸改成放行 → 2 红；删掉网格越界 `stop_loss` 分支 → 2 红；每次恢复后回到 86/86。逐条命令与输出摘录见下表。

## 四、没做什么 / 留给主会话
不接内核 / 风控闸门 / CLI；不模拟部分成交、滑点、资金费；中性网格用单一净仓位账本（与分腿账本不同，README 已写明）；`package.json` 新增 workspace 依赖 `@gitrader/engine-core`，lock 登记归主会话；用户文档页属 T9。观察（非本标段）：`protocol` 卫生现 5/6，剩一例 `ENOENT packages/notify-wecom/README.md`，来自 T5 并行施工。

## 自查表 v2

| # | 检查项 | 判定命令 / 证据 | 结果 |
|---|---|---|---|
| S1 | 对照参照独立来源 | 参照为 QuantDinger（Apache-2.0 本地副本 @`7d96910`）：`grid/levels.py`、`grid/config.py`、`grid/engine.py`、`grid/fill_handler.py`、`grid/ledger_reconcile.py`、`bot_scripts/grid_runtime.py`、`services/parameter_space.py`、`services/strategy_bot_recommend.py`；清单在 README「设计参照」。实现为本包自写，未拷码 | 过 |
| S2 | 端点 / 字段语义以官方为准 | 本包不碰端点；参数键与区间逐个对 QD 源文件核对（如 `multiplier` 1.1–3.0、`gridCount` 5–100、`confirmBars` 1–5），区间在声明里可读 | 过 |
| S3 | 假服务器按参照规则写 | 不适用：无网络、无假服务器 | 不适用 |
| S4 | 碰钱脚本拦实盘护栏 | 不适用：本包不下单、无网络调用。`grep -rn "fetch\|http\|WebSocket" packages/bots/src` 无命中 | 不适用 |
| S5 | 遇安全闸门停报不绕 | 安全上限直接写在参数校验与引擎闸：`src/safety.ts`（`checkExposure` / `checkMartingaleLimits`）、`src/engine.ts`（拒单 + 停机）。反证 1/2 见下表 S15 | 过 |
| S6 | 沙箱逃逸反例 | 不适用：无沙箱、无动态执行 | 不适用 |
| S7 | 子进程治理 | 不适用：无子进程。收工检查：反证用的备份与脚本已删（`ls $TMPDIR/refute*` 无输出）；`ls packages/bots` 只有包文件 | 不适用 |
| S8 | 注释声称与实现一致 | 逐条核对：`src/*.ts` 头注释声明的行为均有对应用例（`test/grid.test.ts` 越界三档、`test/engine.test.ts` 数据可信性、`test/counterexample.test.ts` 账本矛盾）。`grep -rn void packages/bots/src` 无命中 | 过 |
| S9 | 验收扫描覆盖新文件 | `node scripts/check-public.mjs` → `ok 公开仓库卫生检查通过`（但其清单取 `git ls-files`，2232 个文件，新包未入库不在内，故补等价单扫）：`grep -rcE "Comfy\|Wallet ?Connect\|保守\|激进\|稳赚\|跑赢" packages/bots/src packages/bots/test packages/bots/README.md` 全 0；本机路径与邮箱正则同扫无命中 | 过（附手工单扫） |
| S10 | 待办前查现状 | 开工时 `ls packages` 里没有 bots（无重复实现）；未碰 git，未 commit / checkout。`git status --short packages/bots` → `?? packages/bots/`（纯新增） | 过 |
| S11 | 无临时文件 / 无无意义改动 | `git status --short packages/bots` → `?? packages/bots/`（只有本包，未改他人文件）；`ls packages/bots` → LICENSE / README.md / REPORT.md / package.json / src / test / tsconfig.json（另有一个空 node_modules，与其他包一致） | 过 |
| S12 | REPORT 四段 + 数字真实 | 本文件；测试数、红数均来自下表命令实际输出 | 过 |
| S13 | 修复任务逐条对照 | 不适用：非修复任务 | 不适用 |
| S14 | 状态机 / 撮合边界穷举 | 边界用例：同根 K 线不做来回（`grid.test.ts` wide bar）、开仓线必须被穿越、越界三档各一例、停机不平仓（`engine.test.ts`）、马丁到顶精确条数、账本翻向报错 | 过 |
| S15 | 读失败 / 状态不明不触发动钱动作 | `src/errors.ts::BotStateError` 8 种 kind；`src/ledger.ts::assertConsistent`、`src/grid.ts::assertState`、`src/engine.ts::assertCandles` 全抛错。用例：`test/counterexample.test.ts`（长仓账本做空、qty=0、NaN 价）、`test/engine.test.ts`（时间不递增、价 0、high<low）。反证：改坏三处 → 4/2/2 红 | 过 |
| S16 | 每条「过」附命令 + 输出 | 见下「实跑证据」 | 过 |

## 实跑证据

```
$ cd packages/bots && node ../../node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root .
 Test Files  8 passed (8)
      Tests  86 passed (86)

$ cd <repo> && node node_modules/typescript/bin/tsc -p packages/bots --noEmit
（无输出，exit 0）

$ node scripts/check-public.mjs
scanning 2232 files via git ls-files
ok    公开仓库卫生检查通过

$ node tools/release/audit-headers.mjs
ok    首行 SPDX 审计通过（1408 文件，21 条历史例外已登记）
```

反证（改坏 → 红 → 恢复；备份在临时目录，恢复后再跑）：

```
=== 反证 1：src/safety.ts `addsSoFar + 1 > maxAdds` → `if (false)`
 FAIL  counterexample.test.ts > martingale cap … > stops at exactly maxAdds adds
 FAIL  engine.test.ts > leaves the position open on halt instead of inventing a close
 FAIL  martingale.test.ts > stops at maxAdds and leaves the position untouched
 FAIL  martingale.test.ts > mirrors the ladder for a short martingale
      Tests  4 failed | 82 passed (86)
--- 恢复后 ---
      Tests  86 passed (86)

=== 反证 2：src/engine.ts 敞口闸去掉 `break`（放行超限单）
 FAIL  counterexample.test.ts > the exposure guard refuses, it never shrinks
 FAIL  engine.test.ts > refuses the order that would breach the cap, and refuses it whole
      Tests  2 failed | 84 passed (86)
--- 恢复后 ---
      Tests  86 passed (86)

=== 反证 3：src/grid.ts 删掉越界 `stop_loss` 分支
 FAIL  counterexample.test.ts > out-of-bounds stop_loss produces no order at all
 FAIL  grid.test.ts > stop_loss: halts on the first out-of-bounds close and emits no order
      Tests  2 failed | 84 passed (86)
--- 恢复后 ---
      Tests  86 passed (86)
```

## 已验证 / 未验证（逐项）

| 声明 | 覆盖了什么 | 没覆盖什么 |
|---|---|---|
| 四模板参数校验拒越界 | 未知键、min/max、整数、枚举、布尔类型、NaN/Infinity、跨字段（格距与敞口、次数 × 单笔、首仓与总名义额、confirmBars ≤ maPeriod） | 交易所真实精度 / 最小下单量 / 合约面值 |
| 安全上限生效 | 敞口拒单（不截断）、马丁加仓次数与总名义额、DCA 下单次数；三个反证 | 与真实风控闸门串联（本包不接闸门） |
| 纸面回测 | 手工 K 线精确断言 + engine-core 合成行情 300 根（种子 11）四模板各跑一遍、可重放 | 真实历史数据、部分成交、滑点、资金费 |
| 网格语义与 QD 对齐 | 格数 = 线数 − 1、等差 / 等比、越界三档、先平后开、同根不来回 | QD 的自适应边界、瀑布保护（`grid_runtime.py` 只借思路，未移植） |

## 本轮修复（收口 r1）

1. **停机后继续盯市** — `src/engine.ts:56-99`：`halt` 后跳过 `onBar` 与撮合，仍逐根 `equity.push`（`:97`），每根恰好一个点；`maxExposure` 按每根收盘更新（`:98-99`）；`finalEquity` / `snapshot` 用末根收盘（`:106-108`）。断言：`test/engine.test.ts:74` `keeps marking a DCA position to market after the max-orders halt`、`:98` `keeps marking a martingale position to market after the max-adds halt`（`equity.length === candles.length`、fills 3/2、halted 原因码、`finalEquity = initialCash + realized - fees + (lastClose - avgEntry) × position`，DCA 另核 ≈9833.1）。
2. **网格 `stop_loss` 越界平仓** — `src/grid.ts:105-109`：越界且 `position !== 0` 时返回 `closeAllIntent(this.ledger, price, 'grid-boundary-stop')`，并设 `halt.code = 'grid-boundary'`；空仓仍 `[]`。`boundaryAction` 的 `help` 与 `README.md:25` 改为「按当根收盘全部平仓后停机（与 QD 一致）」。断言：`test/grid.test.ts:94` `stop_loss closes the open position at the boundary close before halting`（恰好 1 笔 sell qty 1 @99、position 0、halted grid-boundary）；原空仓两例标题改为「while flat」。
3. **安全上限显式必填** — `src/safety.ts:22` 新增 `requireSafetyProvided`；四个构造函数都在 `requireParams` 前调用（`grid.ts:71` / `dca.ts:56` / `martingale.ts:43` / `trend.ts:43`）。安全键 `help` 末尾加「必填」；`README.md:13-16` 四行写「必填，不传即拒」。断言：`test/params.test.ts:98` `rejects each missing safety cap even when every other parameter is present`、`:115` `rejects createBot without params because safety caps have no default`（四模板 × 每个 `SAFETY_KEYS` 键，`error.key` 精确匹配）。
4. **同根多格敞口累计** — `src/grid.ts:138-147`：开格循环用 `pending`（初值 `ledger.position`，每推一条开仓意图 `pending += signed`）做 `checkExposure`。断言：`test/grid.test.ts:143` `counts every same-bar open intent against the cap and halts itself`（一根连穿 3 条线、上限只够 2 格 → 2 条 buy 意图 + halted max-exposure）。
5. **README** — `README.md:18` 趋势止损 / 移动止损 / 反穿出场后停机且不再进场；`:20`、`:64` 停机后继续盯市；`:56` 示例注明安全上限必填。

反证（改坏 → 红 → 恢复）：

- 第 1 条：`src/engine.ts` 盯市循环加回 `if (halt) break` → `engine.test.ts` 两条新用例红（2 failed / 90 passed）；恢复后 92/92。
- 第 2 条：`src/grid.ts` 去掉 `closeAllIntent` 返回 → `grid.test.ts` 新增平仓用例红（1 failed / 91 passed）；恢复后 92/92。
- 第 3 条：注释掉四处 `requireSafetyProvided` 调用 → `params.test.ts` 两条新用例红（2 failed / 90 passed）；恢复后 92/92。

验收实跑（仓库根）：

```
$ node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/bots
 Test Files  8 passed (8)
      Tests  92 passed (92)
$ node node_modules/typescript/bin/tsc -p packages/bots --noEmit
（无输出，exit 0）
```
