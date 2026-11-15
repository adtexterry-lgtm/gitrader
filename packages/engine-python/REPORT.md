# REPORT · P1.1 Python 引擎骨架

## 改了什么

新建 `packages/engine-python/`：`engine/gep.py`（NDJSON 帧与数组批量、`gep.hello` 令牌与 `0.1` 版本协商、Problem 码表、
秘密字段拒收、方法分发、策略实例、回测作业与事件推送）、`engine/main.py`（入口，退出码 0 / 1 鉴权失败 / 2 无令牌）、
`launch.json`（`engines[].launch` 示例）、`run-conformance.mjs`（跑协议套件并对 O1–O4 设门）、`tests/test_gep.py`、
`package.json`、`README.md`、`LICENSE`（包卫生要求，从根 LICENSE 原样复制）。声明能力组 `strategy` / `strategy.hotUpdate` /
`backtest`；未声明的 `replay.*`、`order.*`、`account.snapshot`、`market.*` 一律 5002。无任何下单路径。

## 跑了什么

- `python -m unittest packages/engine-python/tests/test_gep.py` → **39 例全过**（离线、进程内假宿主，0.043 s）。
- `node packages/engine-python/run-conformance.mjs` → **pass 18 / skip 19 / fail 0**（vitest 26 passed / 53 skipped / 5 todo，71.6 s），
  O1–O4 全 pass；参考引擎同类跑法是 10/16/0，`strategy.*` 与 `backtest.*` 已从跳过变为通过。
- `node node_modules/vitest/vitest.mjs run --config ../../vitest.config.ts --root packages/protocol test/hygiene.test.ts` →
  **6/6 全过**（首跑因并行线 `packages/connector-bitget-trade` 缺 README 失败，该文件补齐后全绿；本包另按同套规则核验 28 文件 0 问题：
  许可证字段、LICENSE 字节相同、README 首行、SPDX 头、禁词、无邮箱 / 内网地址）。

## 没做什么

不写 `strategy_api.py` / `sandbox.py` / `indicators.py` / `backtest.py` / `examples/`（兄弟标段文件）；不接场所、不下单、
不跑纸面；不实现 `events.resume`（带 `resume` 回 5004，宿主用 `engine.snapshot` 对齐）；不读 `data.source = engine/files`
（回 4005）；不算资金费与强平（结果 `warnings` 写明，`assumptions.funding/liquidation = false`）。

## 需要主会话决定

1. `git add` 前注意本包无 `__pycache__` 规则：根 `.gitignore` 没有 Python 缓存条目（根文件不在本标段可改范围），提交前勿把 `*.pyc` 加进去。
2. `gep.py` 与 P1.2 的 `strategy_api.py` 还没接线：P1.1 只有一个内置策略 `sma-cross`（参数 `size/fastPeriod/slowPeriod/warmupBars`），
   是否由 P1.3 把 `strategy.*` 改成经 `strategy_api` 加载、回测改调 `backtest.py`，请定。
3. `launch.json` 的 `command` 写的是 `python`；用户机若 `python` 不在 PATH，需主会话定是否改成 `py -3` 或让内核支持解释器探测。
4. `assumptions.fees = "venue"` 时宿主并未把场所费率表交给引擎，本包按 **0 费** 计并在 `warnings` 里写明；若内核能下发费率，
   改成真实费率（现为诚实占位，非真实费率）。

## 方法清单（协议为唯一标准；完整表见 README.md）

| 方法 | 入参 / 出参来源 | 备注 |
|---|---|---|
| `gep.hello` | methods.ts:62 / :70 | 5003 / 5001 / 5004 |
| `engine.describe` / `bind` / `health` / `snapshot` | methods.ts:133-136，describe.ts:83/:92 | 未知账户 1005 |
| `engine.halt` / `resume` / `shutdown` | methods.ts:81 / :82 / :140 | 三档 level；resume 只接已知 takeover |
| `events.subscribe` / `unsubscribe` / `risk.policy.push` | methods.ts:141-144 | 引擎侧只记录 |
| `strategy.list` / `params` / `start` | methods.ts:145-147，:101 | 能力组 `strategy` |
| `strategy.stop` / `update` / `status` | methods.ts:149-151，:43 | `update` 要 `strategy.hotUpdate`，不重启实例 |
| `backtest.run` / `status` / `result` / `cancel` | methods.ts:153-156，backtest.ts:13/:37/:61/:82 | 立即返回 jobId；progress 单调；未完成 4004 |

固定常量：`0.1` / 单行 1 MiB（version.ts:20）/ Problem 码表（model/problem.ts:70）/ 能力位名单（describe.ts:7）/
事件信封与流表（events.ts:13,41,75）/ 假设五项（schemas/model.BacktestAssumptions.json:1、backtest.ts:86）。
