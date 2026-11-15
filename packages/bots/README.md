> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/bots

四个机器人模板（网格 / 定投 / 马丁 / 趋势）的参数声明、下单意图生成器与纸面执行引擎。零第三方依赖，只 import `@gitrader/engine-core` 的公开 API（`Candle` 类型、`validateStrictParams`）与 `engine-core` 的合成行情（仅测试用）。**本包不下单、不联网、不读任何外部状态**：模板产出的是「意图」，撮合与记账都在本包的纸面引擎里。

参数声明形状照 engine-core 的策略约定：`{ key, label, type: 'number' | 'integer' | 'boolean' | 'select', default, min, max, step, options, help }`。参数校验先把整包交给 engine-core 的 `validateStrictParams`，再跑本包的跨字段与安全上限校验。**越界一律拒，不静默夹范围**——engine-core 的 `resolveParams` 会把 `maxAdds: 99` 夹成 20 继续跑，这里会直接报错，因为夹过的配置不是用户以为的那份配置。

## 四个模板

| 模板 | 核心参数 | 安全上限（写在参数校验里） |
|---|---|---|
| 网格 `grid` | `lowerPrice` / `upperPrice` / `gridCount`（格数）/ `gridMode`（arithmetic·geometric）/ `gridDirection`（long·short·neutral）/ `qtyPerGrid` / `boundaryAction`（pause·stop_loss·hold） | `maxExposureNotional`（必填，不传即拒）；单格名义额已超上限的配置在构造期就拒 |
| 定投 `dca` | `frequency`（every_bar·hourly·4h·daily·weekly）/ `notionalPerOrder` / `dipBuyEnabled` / `dipThresholdPct` / `takeProfitPct` / `stopLossPct` | `maxOrders`（累计买入次数）+ `maxExposureNotional`（两者均必填，不传即拒）；`notionalPerOrder × maxOrders > maxExposureNotional` 的配置直接拒 |
| 马丁 `martingale` | `direction` / `baseNotional` / `multiplier`（1.05–3）/ `addDropPct` / `takeProfitPct` / `stopLossPct` | **`maxAdds`（最大加仓次数）+ `maxTotalNotional`（最大总名义额）+ `maxExposureNotional`**（三者均必填，不传即拒）；首仓已超上限的配置直接拒；加仓触顶即停机，不改小数量 |
| 趋势 `trend` | `maPeriod` / `maType`（SMA·EMA）/ `confirmBars` / `positionPct` / `direction`（long·short·both）/ `trailingStopPct` / `stopLossPct` | `maxExposureNotional`（必填，不传即拒）；`confirmBars > maPeriod` 的配置直接拒 |

趋势模板的止损、移动止损、反向穿越出场都会停机，出场后不再进场。

超限的动作只有一种：**拒单 + 停机**。没有「截到上限继续下」的路径——截断会让账本与实际风险分家（批次 7 的教训）。停机后不再下单，但回测继续按收盘价盯市到数据末尾，`finalEquity` 含停机后的浮动盈亏；仓位原样留在运行结果里，由调用方决定下一步。

## 网格语义

- `gridCount` 是**格数**（cells），边界线 = 格数 + 1。与 QuantDinger `GridBotConfig.grid_count_unit='cells'` 及 `levels.py::generate_levels` 的口径一致（等差：`(upper-lower)/cells`；等比：`(upper/lower)^(1/cells)`）。
- 每格：开仓线被**本根 K 线穿越**（参考价 = 上一根收盘，首根用开盘）才建仓；平仓线到达即平。开仓线没被穿越就不建仓——否则价格停在区间中部会一次把下方所有格当成「已穿越」。
- 同一格不在同一根 K 线内完成来回：先平后开，且当根刚开出的格不允许当根平掉。所以宽幅 K 线的来回不被算成两笔利润。
- 越界处理：`pause` 停止新开格、已有格的平仓照走，价格回到区间内自动恢复；`stop_loss` 按当根收盘全部平仓后停机（与 QD 一致），空仓时只停机不下单；`hold` 只停止当根新开格，继续跑。
- 停止条件：越界处理 + `stopLossPct`（按持仓均价）+ `maxExposureNotional`。

## 什么行情下会亏（零承诺，逐条写明）

**所有模板都会亏，下面只列主要亏损形态；本包不含任何收益承诺，回测数字只用于验证实现，不构成任何预期。**

- **网格**：单边趋势行情里最难受。价格一路下行时下方格子逐格买入、均价跟着下移，浮亏持续放大，直到 `stopLossPct` 或敞口上限停机；价格一路冲出上边界后不再有格子可平，剩余持仓只能等回撤或止损。震荡幅度小于格距时只吃手续费与点差。等差网格在低位区间的相对格距更宽，成交更少；等比网格在高位区间格距更宽，低位更密，下跌段的买入密度更高。
- **定投**：只能靠价格最终回到均价上方才可能收正。长期单边下跌时只是把亏损摊薄、把仓位做大，`maxOrders` 打满后停止加仓，浮亏仍在。`dipBuyEnabled` 在下跌中会更快打满次数上限。
- **马丁**：数学上最危险的一类。倍数越大、`maxAdds` 越大，越可能在一次深度单边行情里把仓位堆到上限后停机，此时浮亏接近最大总名义额对应的亏损。反向波动不到止盈线就继续加仓，是这类模板的固有风险；本包用 `maxAdds` / `maxTotalNotional` / `maxExposureNotional` 三个上限把它限制在可计算的最坏敞口内，但**限制敞口不等于限制亏损**。
- **趋势**：震荡市里被反复止损（来回穿越均线）。跳空与快速反转时移动止损的成交价会明显差于触发价（本包按限价触达撮合，不模拟滑点，真实成交可能更差）。参数（周期、确认根数）在样本内调好、在样本外失效，是最常见的亏损来源。

## 纸面引擎的已知偏差（没做的事）

- 按「限价触达即成交」撮合：不看盘口深度、不模拟部分成交、不模拟滑点与排队。真实成交价与成交量只会更差。
- 手续费按调用方给的 `feeRate` 线性收取，不含资金费、借币利息、交易所阶梯费。
- 账本是**单一净仓位**口径。中性网格同时存在多空格时，盈亏按净仓合并计算，和「分腿持仓」的真实账本不同。
- 不做资金费、强平、保证金率、下单频率限制。
- 模板只出意图；接风控闸门、接交易所、落库都在调用方（内核）。本包不注册进 CLI，也不进内核。

## 状态读取的硬规矩

任何「状态读不到 / 读出来自相矛盾」的分支只抛 `BotStateError`，不返回猜测值、不继续跑：K 线非有限或时间不递增、网格格状态与级别不一致、格已满而仓位为零、长仓账本被要求做空、数量非正。空仓时调用「全部平仓」也是错误而不是空操作。这是批次 8 那条最高级别教训（读失败触发动钱动作）在本包的落法：本包不下单，但也绝不在状态不明时继续算。

## 用法

```ts
import { TEMPLATES, createBot, runBot } from '@gitrader/bots'

const bot = createBot('grid', { lowerPrice: 90_000, upperPrice: 110_000, gridCount: 10, qtyPerGrid: 0.001, maxExposureNotional: 500 }) // 安全上限必填，不传即拒
const run = runBot(bot, candles, { feeRate: 0.00045 })
run.fills      // 纸面成交
run.halted     // { code, detail } | null —— 停机原因
run.snapshot   // 仓位 / 均价 / 已实现 / 手续费 / 敞口 / 模板私有状态
```

- `TEMPLATES[id].params` 直接可给界面渲染参数表单。
- `runBot` 会先校验 K 线数据，再逐根跑；`halted` 不为空表示模板主动停机，`run` 里仍保留停机时的仓位。停机后不再下单，但回测继续按收盘价盯市到数据末尾，`finalEquity` 含停机后的浮动盈亏。

## 设计参照（Apache-2.0）

QuantDinger 仓库（`LICENSE` = Apache License 2.0，本地参考副本 @`7d96910`），只借口径与设计，不抄码：

| 本包 | 参照 |
|---|---|
| 网格线生成 / 格数口径 | `backend_api_python/app/services/grid/levels.py::generate_levels`（等差 / 等比、`cells` 与边界线关系） |
| 网格越界三档 | `.../grid/config.py::GridBotConfig.boundary_action`、`.../grid/engine.py::handle_boundary`（`pause` / `stop_loss` / `hold`） |
| 成交后记账顺序（先本地账本、再回报） | `.../grid/fill_handler.py::apply_grid_fill_to_local_state` |
| 账本与场所对账「宁可报错也不猜」 | `.../grid/ledger_reconcile.py::should_clear_phantom_ledger`（交易所平仓才清账本，不凭本地视图清） |
| 参数键与区间（四个模板） | `.../services/strategy_bot_recommend.py`（`grid` / `dca` / `martingale` / `trend` 的键名与范围）、`.../services/strategy_evolution/parameter_space.py::_DCA_SPECS` |
| 级联行情保护思路（先停手） | `.../services/bot_scripts/grid_runtime.py::update_waterfall_state` |
