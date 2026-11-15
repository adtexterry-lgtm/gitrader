> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/engine-core

**Gitrader Core** 是 GEP（Gitrader Engine Protocol）的参考引擎：策略运行时 + 回测 + 回放 + 工作流 JSON 运行器。
它是个**空引擎**：

- 不提供策略、不提供数据、不提供因子。策略是用户（或用户的 Agent）写的文件；行情来自内核的录制器或用户自带的文件。
- 只做模式 A：引擎不直连场所、不持有任何密钥；订单意图经 `host.order.place` 交给宿主，宿主过授权书 + 风控闸。
- Harness 只做准入和记录：引擎不替策略判断结果好坏，也不在运行时调用任何模型。

```
packages/engine-core/
  src/                  引擎本体（GEP 服务端、策略加载器、回测、回放、工作流运行器）
  strategy-template/    空白策略模板：完整接口，没有任何交易逻辑，注释写给 Agent 看
  examples/             教学示例（无业绩含义，默认不加载）：4 个策略 + 4 张工作流 JSON
  test/                 单测 + 夹具（最小均线策略只在 test/fixtures/，不属于产品目录）
  build.mjs             esbuild 打成单文件 dist/engine-core.mjs
```

## 启动

宿主为每次启动生成一次性令牌，经环境变量交给引擎（令牌放在 `gep.hello` 参数里，不放 URL）：

```
GITRADER_GEP_TOKEN=<token> node dist/engine-core.mjs --stdio --strategies <dir>
GITRADER_GEP_TOKEN=<token> node dist/engine-core.mjs --ws [port] --strategies <dir>   # 只监听 127.0.0.1，路径 /gep，子协议 gep.v0
```

`--strategies <dir>`（或环境变量 `GITRADER_STRATEGIES_DIR`）是策略文件夹，路径由内核按配置交给引擎，默认约定 `~/.gitrader/engines/gitrader-core/strategies/`。
不给就不加载任何策略。`ws` 模式启动后在 stdout 打印一行 `{"listening":"ws://127.0.0.1:<port>/gep","port":<port>}`；`stdio` 模式 stdout 只放协议帧，日志走 stderr。
`GITRADER_ENGINE_ARTIFACT_DIR`：大回测结果落盘位置（走 `host.artifact.put`）。

## 文件夹即安装

引擎监视策略文件夹：丢进一个文件 → 校验 → 热加载 → `strategy.list` 里可见；改文件 → 重新校验、热更新；删文件 → 卸载。无需重启。

- 文件类型：`.ts` `.mts` `.js` `.mjs`（ES module，`export default` 策略对象）。TS 只支持可擦除的写法（类型、接口、`as`、`satisfies`；不要 enum / namespace）。需要 Node ≥ 22.13。
- 以 `.` 或 `_` 开头的文件、`*.test.*`、`*.d.ts` 被忽略（`_draft.ts` 用来放草稿）。
- 一个文件一个策略，`id` 在文件夹内唯一。M2 再加 Python 旁车。
- **已在跑的实例钉住启动时的版本**：改文件不影响它；停掉重启才用新版本。
- 改坏了：报告里标红，但上一个好版本继续可用。

### 校验规则（写给 Agent 看的错误：规则名 + 哪里不对 + 怎么改）

校验在一个工作线程里真的把策略跑一遍（带超时，死循环拖不垮引擎）：600 根合成 1 分钟线 + 默认参数。

| 规则 | 检查什么 |
|---|---|
| `id` `name` `version` `desc` `tags` `params` `evaluate` | 结构：id 小写字母数字短横线 2–40 位；version 是 semver；desc 写规则、不写业绩 |
| `param-*` | 参数定义：键名 camelCase、默认值满足类型 / min / max / options；`size` 是引擎通用参数不能占用；像秘密的名字（`privateKey` `secret` `apiSecret` `mnemonic` `seed` `passphrase`）被拒 |
| `no-io` | 不许运行时 `import` / `require`、网络、`process`、`eval`、`Math.random()`、挂钟时间（注释里提到不算）。策略是 `(candles, params)` 的纯函数。这是给 Agent 的护栏，**不是沙箱**：策略文件是用户自己的代码，在引擎进程里运行（引擎没有密钥），不要把来路不明的文件丢进文件夹 |
| `output-*` `reason-missing` | `target[]` 每根一个有限数、在 [-1,1]；`reasons[]` 每根一个字符串，目标每次变化都要有一句理由；`overlays` ≤ 12 条线；`warmup` 非负整数 |
| `non-deterministic` | 同样输入调两次，输出必须一样 |
| `evaluate-throws` | 入参在校验时是冻结的：修改入参会抛错 |
| `empty-input` `short-input` `extreme-params` | 空序列、不足一个周期、所有数值参数取 min / max，都不许抛错 |
| `lookahead` | 用截断后的 K 线重算，已有的 `target[i]` 不得改变——偷看未来 K 线（`candles[i+1]`、全段均值 / 极值）会被抓住 |
| `slow` `timeout` | 600 根上 > 2 s、或整体 > 15 s |
| `duplicate-id` | 两个文件同一个 id |

警告（不拦）：`never-trades`（校验夹具上目标恒为 0）。

怎么读结果：

- 引擎原生 GEP 扩展方法 `x-gitrader.strategy.files`（内核当前尚未放行 `x-gitrader.*`，S5 待办）→ `{dir, files:[{file, status:'loaded'|'error'|'removed', id, version, errors:[{rule,message,hint}], warnings}], loaded:[id…]}`；
- 订阅 `strategy` 流，会收到 `strategy.loaded` / `strategy.load_failed` / `strategy.unloaded`（带同样的 errors）；
- `engine.health` 的 `metrics.strategiesLoaded` / `strategyFileErrors`。

## 让你的 Agent 写第一条策略

先说清楚分工：**大模型只写代码，不做实时交易判断。** 策略是一个纯函数，写好以后就是确定性的算术；运行时没有模型在"看盘"。下单权限、风控限额、授权书都在内核里，策略文件碰不到。

1. **从模板复制。** `strategy-template/strategy.ts` → `~/.gitrader/engines/gitrader-core/strategies/<你的-id>.ts`。模板顶部有一整块写给 Agent 的说明：接口、规则、什么不能做。
2. **填规则。** 改 `id` / `name` / `version` / `desc` / `params`，实现 `evaluate(candles, params)`：每根已收盘 K 线返回一个目标仓位（-1 空、0 空仓、+1 多），目标每次变化写一句理由。`target[i]` 只能用 `candles[0..i]`。引擎会在一秒内校验并热加载；有错查看引擎日志或 `engine.health` 指标后修改；`x-gitrader.strategy.files` 尚不能经内核调用，S5 待办。
3. **回测。** `backtest.run`，`subject.strategy = {id, version, params}`，数据用下面两种来源之一。读结果里的 `assumptions`（手续费、滑点、成交模型，以及资金费 / 强平的实际开关：`funding` 请求 `true` 且装到资金费点时才按点结算，装不到时回写 `false` 并给 `warnings`；`liquidation` 请求 `true` 时按维持保证金比例用最坏盘中价检查）、`biasChecks.lookahead`（前视偏差自检）、`trialCount`（同一策略试过多少份不同规格，用来给漂亮的回测结果打折）。
4. **纸面。** `strategy.start` 到一个**纸面账户**（授权书 L1）。实例的每个信号带 `origin` 与理由，订单经宿主风控闸；在"Agent 活动"检阅块里看。
5. **实盘。** 当前经内核启动实盘策略会直接拒绝；S5 待补 `propose.control` 及人面批准，不把协议规划当作现成功能。

给 Agent 的几条硬规矩：不要在 `desc` 里承诺收益；不要在 `evaluate` 里调用模型或网络；不要为了让回测好看去调参到刚好过关（`trialCount` 会记录）；参数用 `strategy.update` 热改，不要反复重写文件。

## 回测与数据

**引擎不内置任何历史数据集。** 回测输入只有两个来源（`spec.data.source`）：

- `host`：调用 `host.market.history` 分页取数（每页 ≤ 5000 根，长窗口翻页；窗口上限见 `runtime/limits.ts` 的 QD 天数表，1h 为 26280 根）。内核本地优先：录制库里已收盘的格点齐了就不碰场所，有缺口只补缺的那段。
- `files`：用户自带文件，`spec.data.files = [{path, sha256, format: "csv" | "json"}]`，**sha256 必须对得上**，对不上整个任务失败（`4005`），不会悄悄用错数据。

文件的最小格式（只认这些列 / 字段，`t` 为 K 线开盘时间的 Unix 毫秒，升序；坏行跳过）：

```
CSV（可有表头行）          t,o,h,l,c,v          v 可省略
JSON（三种写法任选）       [{"t":…,"o":…,"h":…,"l":…,"c":…,"v":…}, …]
                          [[t,o,h,l,c,v], …]
                          {"candles":[…]}
```

`data.source: "engine"` 返回 `5002`（引擎没有自带行情，`market.own = false`）。一次回测一个标的、最多 100 万根（52 万根 = 一年的 1 分钟线）。

假设（`spec.assumptions` → 结果里 `assumptions` 原样写实际采用值）：`fillModel` 只有 `next-bar-open`（信号出在第 i 根收盘，第 i+1 根开盘价成交，含滑点与吃单手续费）；`fees: "venue"` 取宿主给的费率，取不到用默认 0.045% 并写进 `warnings`；`funding` 请求 `true` 且装到资金费点（宿主 `host.market.fundingHistory`，或 `spec.data.files[]` 里 `kind: "funding"` 的文件，只保留 `[from, to)` 内的点）时按点逐根结算，多头在 `rate > 0` 时付钱，结算记入结果的 `funding[]`（`{t, rate, notional, paid}`，`paid` 正为支出），不进 `trades`；装不到点（宿主没有该方法、文件缺失、区间内没有点）时 `assumptions.funding` 回写 `false` 并写进 `warnings`，不报错。`liquidation` 请求 `true` 时按维持保证金比例（`account.maintenanceMarginRatio`，缺省 `0.5 / leverage`）用最坏盘中价检查，强平成交在 `trades` 里记 `reason: "liquidation"`；单根成交量上限 `maxVolumeShare`（0–1，缺省不限）与强平罚金 `liquidationPenaltyRatio`（缺省 0）可选。结果 `stats` 多出 `fundingPaid`（正为净支出）、`feesPaid`、`liquidations`（强平笔数）、`unfilledShare`（因成交量上限未成交的名义占比）。

结果超过 1 MB 走 `host.artifact.put`（`equity` / `trades` 两个文件，内联数组留空）；宿主没有该方法（`-32601` / `5002`）时退回内联交付（`equity` 降采样、`trades` 截断）并写 `warnings`，其他错误整单 `4003`。

## GEP 面

实现的方法：`gep.hello` `engine.describe` `engine.bind` `engine.health` `engine.snapshot` `engine.halt` `engine.resume` `engine.shutdown` `events.subscribe` `events.unsubscribe` `events.ack` `risk.policy.push` `strategy.*`（list / params / start / stop / update / status）`backtest.*` `replay.*`。
没声明的可选方法（`order.*` `account.snapshot` `market.*`，模式 B / 自带行情）返回 `5002`；不存在的方法 `-32601`；秘密字段名（`privateKey` `secret` `apiSecret` `mnemonic` `seed` `passphrase`）一律 `5006`，值不回显、不记录（唯一例外：`backtest.run` / `replay.start` 的 `spec.seed` 是整数种子）。

| 能力位 | |
|---|---|
| `execution.modeA` | true；`execution.modeB` false |
| `market.useHost` | true；`market.own` false |
| `strategy` `strategy.hotUpdate` `backtest` `replay` `events.resume` | true |
| `halt.levels` | `halt_new` `cancel_all` `flatten_all` |
| `builder.attach` | false（builder 由宿主统一附加；意图里没有 builder 字段） |
| `decision.log` | false（引擎内没有快决策模型） |
| `x-gitrader.workflow` | 工作流 JSON 运行器（见下） |
| `x-gitrader.strategy-folder` | 文件夹即安装 |

行为约定（都是为了让宿主能放心）：

- **会话**：`gep.hello` 不带 `resume` = 全新会话，上一会话留下的实例 / 绑定 / 接管 / 风控推送全部清掉；带 `resume` 且补得齐 = 续传；补不齐回 `5004`，连接仍可用，用 `engine.snapshot` 对齐（此时不清状态）。
- **事件**：每个会话一条全局单调 `seq`；保留窗 ≥ max(10,000 条, 15 分钟)；无损流永不丢，缓冲到硬上限（20 万条）才丢最老的并发 `gep.overflow`；未确认 > 5,000 条时可合并流只留最新并带 `conflated`，日志流丢弃并带计数。`events.ack` 与 `host.events.ack` 都当作宿主的确认。
- **心跳**：每 ≤ 5 s 发 `gep.heartbeat`；连续 3 个周期没收到宿主心跳 → 判定失联，不再发任何开仓类请求（减仓单照发），心跳恢复自动解除。
- **接管**：`engine.halt` 立即生效并在 200 ms 内 `ack`。`halt_new`：停开仓；`cancel_all` / `flatten_all`：引擎什么单都不再发（撤单与平仓由宿主做）。**只有 `engine.resume`（按 takeoverId）能解除**，解除后已在跑的实例按最新行情重新对一次仓位。
- **风控推送**：`risk.policy.push` 只会让引擎少做点——单笔名义封顶、杠杆封顶、滑点封顶、标的 / 场所白名单、持仓占比、持仓个数、每分钟下单数。旧版本不接受。真正的强制风控在宿主。
- **下单**：`clientOrderId` = hash(实例, 标的, 决策输入 K 线指纹, 动作, 方向, 数量)——同一份输入同一个决策同一个单号（幂等）。被风控拒（`2xxx`）后同向请求退避 5 分钟，不拆单规避；`1002` 不原样重发；`3006` 先 `host.order.status` 查再说。每个订单带 `origin.tool`（`strategy:<id>` / `node:<类型>`）与 `causation.instanceId`；`actor` 由宿主覆盖。
- **行情**：宿主推 `market` 流事件，`type = market.candle`，`data = {interval, candle:{t,o,h,l,c,v}, closed?}`（或 `market.candles` + `candles[]`）。引擎的行情是按 `t` 为键的一组 K 线，事件是更新；出现新的一根、或已收盘的 K 线被修订，就在最新一根已收盘 K 线上重新求信号。没收到 push 时按 `max(60 s, 周期/10)` 轮询 `host.market.history`。

**实例级通用参数 `size`**（所有策略实例都接受，`strategy.params` 的 schema 里单独列出）：单笔订单数量上限（基础资产单位，十进制字符串），只会让下单量变小，可用 `strategy.update` 热改。

### 工作流 JSON（`gitrader-workflow/2`）

引擎**不带工作流库**，只给空白骨架 `x-gitrader.workflow.blank`。扩展方法（契约 §2.9：厂商扩展用 `x-gitrader.` 前缀）：

| 方法 | |
|---|---|
| `x-gitrader.workflow.nodes` | 节点库（数据 / 指标 / 条件 / 模型 / 风控 / 动作 / 输出）与端口类型 |
| `x-gitrader.workflow.validate` | 先过 JSON Schema，再查语义（无环、端口类型兼容、必填输入已连、`$名字` 参数能解析、含实时节点的图不能回测） |
| `x-gitrader.workflow.run` | 起一个实时实例（`{workflow, target, accountId, instrumentId, interval, params, mandateId}`），之后用 `strategy.stop` 停 |
| `x-gitrader.workflow.values` | 运行时值：每个节点在最后一根已收盘 K 线上的输出，以及节点错误 |
| `backtest.run` | `subject.workflow = {id, version, json}` |

终点节点（`act.*` `out.*`）只产出意图；`act.order` / `act.propose` 的单都经 `host.order.place`，由运行者的授权书决定是直接下还是转提案。节点出错时本轮所有终点都不动作（失败即停）；`model.decision` 没有决策提供方时直接报错。教学示例见 `examples/workflows/`。

## 一致性测试与基准

```
# 先打包
node packages/engine-core/build.mjs

# 对 engine-core 跑 GEP 一致性套件（必测 T01–T26、模式 A、可选 O1–O8）。套件在 packages/protocol/conformance/
# stdio：每个用例一个新进程（套件起子进程），完整隔离
cd packages/protocol
GEP_LAUNCH='{"command":"node","args":["<abs>/packages/engine-core/dist/engine-core.mjs","--stdio"],"env":{"GITRADER_STRATEGIES_DIR":"<装了一个策略文件的目录>"}}' \
GEP_REPORT_PATH=<abs>/gep-conformance-report.json \
npx vitest run --config ../../vitest.config.ts --root . --fileParallelism=false conformance/
# ws：引擎要事先起好，端点由 GEP_ENDPOINT 指定；套件的 T25 会让引擎退出，所以每个测试文件前重启一次
GEP_ENDPOINT=ws://127.0.0.1:<port>/gep GEP_TOKEN=<token> npx vitest run … conformance/required.test.ts
```

引擎不带策略，一致性测试需要一个会下单的策略：把 `test/fixtures/strategies/ema-cross.ts`（测试夹具，仅用于此）复制进 `GITRADER_STRATEGIES_DIR` 指向的目录。`scripts/conformance.mjs` 把上面全部自动化（stdio 全套 + ws 逐文件重启），结果写到 `test-out/`。

基准：`node bench/engine/run.mjs`（回测吞吐、52 万根回测、决策延迟 p50 / p95），输出 JSON 到 `bench/engine/results/`。口径见脚本头注释；全部是合成数据，收益数字没有意义。

## 开发

```
cd packages/engine-core
npx vitest run --config ../../vitest.config.ts --root .   # 单测
npx tsc -p . --noEmit                                      # 类型
node build.mjs                                             # dist/engine-core.mjs（不入库）
```

TODO(protocol)（需要主会话 / 协议包裁决，引擎已按下述约定实现）：`market` 流事件的 `data` 形状；`strategy.start` 的仓位设置（`sizing`）与 `host.order.place` 的 `origin` 追加字段；GEP 没有工作流方法（走 `x-gitrader.*`）；没有 `host.proposal.create`（`act.propose` 目前与 `act.order` 同路）；`BacktestSpec.data.files[].format` 需要加 `json`；`seed` 既是回测种子又在 S1 秘密字段名里。
