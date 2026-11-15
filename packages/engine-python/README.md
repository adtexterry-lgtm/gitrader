> 许可证：CPAL-1.0。

# @gitrader/engine-python

用 Python 写策略、经 GEP 被内核当引擎拉起。本包提供协议面（NDJSON 帧、`gep.hello` 令牌与版本协商、Problem 错误模型、
方法分发、`strategy.*` 与 `backtest.*` 能力组、引擎 → 宿主事件流），并从**策略目录**装载用户的 `.py` 策略：
用户在子进程里跑，带钩子超时与内存上限（见「沙箱与限制」）。

- Python ≥ 3.11，**零第三方依赖**（无 numpy / pandas）：只要标准库。
- 不联网、不读密钥文件；通道令牌只从环境变量 `GITRADER_GEP_TOKEN` 进，不落盘、不打印、不进事件。
- **没有任何下单路径**：模式 A 声明为 `true`（订单必须经宿主），本包不调用 `host.order.place`。未经真网验证。

## 跑

```sh
# 全部单元测试（离线，标准库 unittest）
python -m unittest discover -s packages/engine-python/tests     # 仓库根
python -m unittest packages/engine-python/tests/test_strategy_loader.py   # 只跑策略装载与限制
npm test                                                        # 本包目录（同一套）

# 协议一致性套件（套件自己起引擎子进程；可选组 strategy.* / backtest.* 必须过）
node packages/engine-python/run-conformance.mjs                 # 仓库根
```

`run-conformance.mjs` 用 `GEP_PYTHON`（缺省 `python`）找解释器，找不到退出码 3；套件跑完但 O1–O4 任一未过则退出码 4。
Windows 下 `python` 不在 PATH 时：装 Python 3.11+ 时勾选 “Add python.exe to PATH”，或用 `py -3` 并把 `GEP_PYTHON` 指到
`py`（`launch.json` 的 `command` 同步改成同一个解释器）；本仓库不自动安装任何东西。

## 怎么在 `gitrader.json` 启用为引擎

新建配置会登记一个默认禁用的 Python builtin：

```json
{ "id": "python-engine", "enabled": false, "builtin": true }
```

要启用它，把该项的 `enabled` 改为 `true`。已有配置不会被初始化流程覆盖；请手动把同一条目追加到 `engines` 数组，再按需启用。内核会先找随包入口，再找工作区的 `packages/engine-python/engine/main.py`；解释器默认是 `python`，可用 `GEP_PYTHON` 选择其他命令。

如需自行指定启动方式，可为该条目设置 `launch`，显式配置优先于 builtin 解析：

```json
{
  "id": "python-engine", "enabled": true, "builtin": true,
  "launch": { "command": "python", "args": ["<engine-entry>"], "env": { "PYTHONDONTWRITEBYTECODE": "1" } }
}
```

- **不要在 `env` 里写令牌**：内核给每个本地引擎注入一次性 `GITRADER_GEP_TOKEN`，令牌不落盘、不打印，也不进事件；配置里只写其他环境变量。
- 内核还会注入策略目录与产物目录。子进程只收到显式列出的环境变量、令牌及最小系统环境，不会继承宿主的全部环境。
- 通过 `gitrader engines list` 确认 GEP 状态为 `ready` 才表示握手完成。Supervisor 的 `ready` 可能只说明进程已启动。已有的发布版 CLI 不会因这份源码改动自动更新。
- 绑定纸面账户需要本人输入 PIN；绑定本身不授予额外权限。修改本包后可运行 `node packages/engine-python/run-conformance.mjs` 做协议一致性检查。

绑定之后内核经 MCP 的 `engines` 工具启停策略；当前实盘账户启动策略会被内核直接拒绝（本包也没有下单路径）。

## 文件

| 文件 | 内容 |
|---|---|
| `engine/gep.py` | 帧解析、hello / 版本协商、Problem 表、秘密字段拒收、方法分发、策略实例、回测作业、事件推送 |
| `engine/main.py` | 入口（`python engine/main.py [--gep stdio]`），退出码 0 / 1（鉴权失败）/ 2（无令牌） |
| `engine/strategy_api.py`、`engine/sandbox.py`、`engine/indicators.py` | 兄弟标段（P1.2 / P1.4）：钩子与参数语义、沙箱白名单、指标库。P5.1 起 `gep.py` 经 `strategy_loader` 用它们装载策略 |
| `engine/strategy_loader.py` | 策略目录：发现 `.py`、装载、解析 `params`、参数 schema、加载报告、钩子探测 |
| `engine/limits.py` | 执行限制：每个钩子的墙钟上限、整次回测上限、内存上限、子进程监督与进程树 RSS |
| `engine/strategy_child.py` | 子进程作业（`load` / `evaluate` / `signals`）：用户代码只在这里跑；`signals` 是回测要的整段目标仓位序列 |
| `engine/backtest.py` | 与 `simulator.ts` 逐值对齐的撮合与记账（`backtest.run` 的作业就是喂它） |
| `tests/test_strategy_loader.py` | 策略装载与限制的单元测试（超时 / 内存 / 引擎存活） |
| `launch.json` | `gitrader.json` 的 `engines[].launch` 示例 |
| `run-conformance.mjs` | 跑协议套件并对 O1–O4 设门 |
| `tests/test_gep.py` | 协议面单元测试（`python -m unittest`） |
| `tests/test_backtest.py` | 模拟器语义 + 跨引擎一致性（读 `tests/fixtures/ts-backtest.json`，20 个用例 / 十个策略） |
| `tests/test_backtest_gep.py` | `backtest.run` 全参数接线（费率 / 滑点 / 资金费 / 强平 / 成交量上限 / 保护 / 手数）与策略目录回测 |
| `tests/fixtures/export-ts-backtest.mjs` | 一次性夹具导出脚本：用 engine-core 的 TS 模拟器跑同一份 K 线与参数（离线，`node` 直接跑） |
| `REPORT-P5.1.md` | 策略装载与限制这一标段的四段式报告（含取舍） |
| `REPORT-P5.2.md` | 回测接模拟器 + 一致性扩全参数这一标段的四段式报告 |

## 实现的方法清单（协议是唯一标准）

类型来源全部是 `packages/protocol/src/`（下称 P）与 `packages/protocol/schemas/`（下称 S）。

| 方法 | 入参来源 | 出参来源 | 状态 |
|---|---|---|---|
| `gep.hello` | P/gep/methods.ts:62 `GepHelloParams` | P/gep/methods.ts:70 `GepHelloResult` | 必测；令牌错 5003、版本无交集 5001、带 `resume` 5004（未声明 `events.resume`） |
| `engine.describe` | P/gep/methods.ts:133 | P/gep/describe.ts:56 `EngineDescribe` | 必测；声明 `strategy` / `strategy.hotUpdate` / `backtest` |
| `engine.bind` | P/gep/describe.ts:83 `Binding` | P/gep/describe.ts:92 `BindResult` | 必测；未知账户 1005，模式 B 拒（5002） |
| `engine.health` | P/gep/methods.ts:135 | P/gep/methods.ts:72 `EngineHealth` | 必测 |
| `engine.snapshot` | P/gep/methods.ts:136 | P/gep/methods.ts:73 `EngineSnapshot` | 必测 |
| `engine.halt` | P/gep/methods.ts:81 `HaltParams` | `{ack: true, appliedAt}` | 必测；三档 level |
| `engine.resume` | P/gep/methods.ts:82 `ResumeParams` | `{resumedAt}` | 必测；未知 takeover 拒 |
| `engine.shutdown` | P/gep/methods.ts:140 | `{ok: true}` | 必测；graceMs ≤200 ms 后退出码 0 |
| `events.subscribe` / `events.unsubscribe` | P/gep/methods.ts:141-142 | 同 | 必测 |
| `risk.policy.push` | P/gep/methods.ts:144 | `{acceptedVersions}` | 必测（引擎侧只记录，不下单） |
| `strategy.list` | P/gep/methods.ts:145 | `{strategies}` | 能力组 `strategy`；内置策略排第一，其后是策略目录里装载成功的 `.py` 文件（P/gep/methods.ts:48 `StrategyListEntry`） |
| `strategy.params` | P/gep/methods.ts:146 | `{schema, defaults}` | 能力组 `strategy`；按 `strategyId` 答（内置或目录里的策略）；schema 是 draft 2020-12 子集，defaults 落在 schema 内 |
| `strategy.start` | P/gep/methods.ts:101 `StrategyStartParams` | `{instanceId, status}` | 能力组 `strategy`；参数按该策略自己声明的 `params` 校验；目录里的策略要先跑通一次 `evaluate` 钩子（超限回 4002） |
| `strategy.stop` | P/gep/methods.ts:149 | `{status}` | 能力组 `strategy`；不平仓 |
| `strategy.update` | P/gep/methods.ts:150 | `{status, appliedAt}` | 能力组 `strategy.hotUpdate`；不重启实例（`startedAt` 不变） |
| `strategy.status` | P/gep/methods.ts:151 | `{instances: StrategyInstance[]}`（P/gep/methods.ts:43） | 能力组 `strategy` |
| `backtest.run` | P/gep/backtest.ts:13 `BacktestSpec` | `{jobId}` | 能力组 `backtest`；立即返回，作业在独立线程跑「策略 → 信号 → `backtest.py` 模拟器」；`subject.strategy.id` 可以是内置或策略目录里的任意一个 |
| `backtest.status` | P/gep/methods.ts:154 | `{state, progress}`（`BacktestState` P/gep/backtest.ts:82） | 能力组 `backtest`；progress 单调 0→1 |
| `backtest.result` | P/gep/methods.ts:155 | P/gep/backtest.ts:61 `BacktestResult`（stats P/gep/backtest.ts:37） | 能力组 `backtest`；未完成回 4004 |
| `backtest.cancel` | P/gep/methods.ts:156 | `{state}` | 能力组 `backtest` |
| `x-gitrader.strategy.files` | 扩展（P/gep/methods.ts:371） | `{dir, files, loaded, limits}`，形状同 engine-core（`runtime/engine.ts:499`） | 能力位 `x-gitrader.strategy-folder`；可选参数 `rescan`（忽略缓存重装）、`file`（只探测一个文件，带 `evaluate` 结果与超限证据） |
| `replay.*`、`order.*`、`account.snapshot`、`market.*` | — | — | **不实现**，按 `GEP_METHODS`（P/gep/methods.ts:277）的能力位门一律回 5002 |

固定常量：GEP 版本 `0.1` / 单行上限 1 MiB（P/gep/version.ts:20）/ Problem 码表（P/model/problem.ts:70）/
能力位名单（P/gep/describe.ts:7）/ 事件信封与流表（P/gep/events.ts:13,41,75）/ 回测假设五项
（S/model.BacktestAssumptions.json:1，检查函数 P/gep/backtest.ts:86）。

## 声明了什么（engine.describe.capabilities）

`execution.modeA: true`、`execution.modeB: false`、`market.useHost: true`、`market.own: false`、
`strategy: true`、`strategy.hotUpdate: true`、`backtest: true`、`backtest.fillModels: ["next-bar-open"]`、
`replay: false`、`events.resume: false`、`risk.cooperative: false`、`halt.levels: [halt_new, cancel_all, flatten_all]`、
`builder.attach: false`、`decision.log: false`、
以及厂商扩展位 `x-gitrader.strategy-folder: true`（`^x-` 前缀是协议 schema 允许的扩展键）。

## 回测语义（如实）

回测作业把策略求出的「目标仓位序列」逐根喂给 `engine/backtest.py`——它是
`packages/engine-core/src/strategy/simulator.ts` 的逐行移植（与 TS 侧共用同一批一致性夹具，偏差 0）：

- 单根 K 线决策只用已收盘的 `i-1` 及更早，成交在 `i` 的开盘价（next-bar-open），滑点按方向不利加；
  一根 K 线一个权益点（`equity.length == 回测根数`，含第 0 根），与 `simulator.ts` 同序。
- 仓位大小 = 目标 × 成交时权益 × 杠杆 / 价格（`size` 参数只用于纸面/实例路径，回测不用它）。
- 数据只从宿主取（`host.market.history`，`spec.data.source = "host"`）；`engine` / `files` 两种来源回 4005
  `DATA_UNAVAILABLE`，结果不伪造。
- `assumptions` 写**实际采用值**：`fees`（`venue` 时问 `host.instruments`，拿不到才回落默认 taker `0.00045`
  并写 warning）、`slippageBps`、`fillModel`、`funding`、`liquidation` 五项必填，另加实际生效的
  `maxVolumeShare` / `liquidationPenaltyRatio` / `x-maintenanceMarginRatio` / `x-protection` / `x-lotStep`。
- `funding` / `liquidation` 现在是**真的算**：资金费点从 `host.market.fundingHistory` 取（拿不到就是 `false` +
  warning，绝不回写真值）；强平按最不利盘中价对维持保证金判定，只做单根判定、没有跨根保证金路径（写在 warning 里）。
- `assumptions.fillModel` 只接受 `next-bar-open`（`engine.describe` 只声明它），其它值回 `-32602`。
- `spec.instruments` 必须恰好一个；请求根数超过窗口上限时只用最近 5000 根并在 `warnings` 里写明。
- 窗口短于一天时 `stats.annualizedRatio` 报 `0` 并在 `warnings` 里说明（把不到一天的收益年化会得到非有限数，
  JSON 里只能变 `null`；TS 侧此时得到 `Infinity`）。`spanDays` 照实写窗口长度。
- 同一 spec + 同一数据两次运行的 `BacktestResult`（去掉 `jobId`）逐字节一致；结果里没有墙上时钟。

### `backtest.run` 的全部参数

七个模拟器旋钮里有四个有协议字段，另外三个（保护规则、手数归一）`BacktestSpec` 没有字段，
走厂商扩展对象 `spec["x-simulation"]`（协议给 `x-` 键留了位置，见 `model.BacktestAssumptions` 的 `[x-${string}]`）：

| 旋钮 | 从哪来 | 缺省 | 说明 |
|---|---|---|---|
| 费率 | `assumptions.fees`：`{maker,taker}` 十进制字符串或 `"venue"` | `venue` → 问 `host.instruments`，拿不到用 `0.00045` + warning | 每笔成交按吃单费计（全是市价单） |
| 滑点 | `assumptions.slippageBps`（0–500） | `0` | 按方向不利加在开盘价上 |
| 资金费 | `assumptions.funding: true` + `host.market.fundingHistory` | `false` | 只结算 `(上一根 t, 本根 t]` 里的点；空仓不结算 |
| 强平 | `assumptions.liquidation: true` | `false` | 最坏盘中价 vs `|pos|·worst·mmr` |
| 维持保证金比例 | `account.maintenanceMarginRatio`（分数） | `0.5 / leverage` | 回写成 `x-maintenanceMarginRatio` |
| 强平罚金 | `assumptions.liquidationPenaltyRatio` | `0` | 强平后额外扣 `penalty·mm` |
| 成交量上限 | `assumptions.maxVolumeShare`（0–1） | 不限 | 超出部分不成交、不补，`stats.unfilledShare` 报占比 |
| 保护规则 | `x-simulation.protection`：`stopLossPct` / `takeProfitPct` / `trailing{activationPct,trailPct}` / `maxHoldBars` | 不做保护 | 保护先于策略：同根触发就平仓并忽略本根目标 |
| 手数归一 | `x-simulation.lotStep` / `x-simulation.minLot` | 不归一 | 向零取整；归一后为 0 视为不成交 |

`x-simulation` 只接受这三个键，值不合法（`lotStep <= 0`、`minLot < 0`、`protection` 不是对象、未知键）回 `-32602`。
结果里 `stats` 是 `simulator.ts` 的 `SimStats` 全量 17 个键（含 `sortino` / `protectionExits` / `unfilledShare`），
`funding[]` 只在有结算时出现。

## 策略目录（文件即安装）

内核给每个本地引擎注入 `GITRADER_STRATEGIES_DIR`（`packages/kernel/src/engines.ts:167-174`），本引擎读它：

- 只读目录**下一层**的 `*.py`，不进子目录；文件名以 `_` 或 `.` 开头的跳过（`_helpers.py` 是草稿，不是策略）。
- 一个文件 = 一个策略：模块级 `STRATEGY` dict（`id` / `name` / `version` / `desc` / `tags` / `params` / `evaluate`），
  与 TS 侧 `export default strategy` 同义；`params` 里每项是 `{key,label,type,default,min,max,step,options,help}`。
- 两个文件声明同一个 `id` → 按文件名字典序，后一个报 `duplicate-id`。
- 单次扫描最多 `MAX_STRATEGY_FILES = 200` 个文件，多出的报错而不是悄悄丢掉。
- 装载结果按 `(mtime_ns, size)` 缓存：目录没变时 `strategy.list` 只做几次 `stat`，不再起子进程。

目录里的策略能列（`strategy.list`）、能描述（`strategy.params`）、能起实例（`strategy.start`）、**能被回测**
（`backtest.run` 的 `subject.strategy.id` 填它的 id；求值在子进程里做，整段信号一次算完再交给模拟器）。
十份示例在 `examples/`（与 `packages/engine-core/examples/strategies/` 同名同参数），可以直接指过去看看：

```sh
GITRADER_STRATEGIES_DIR=packages/engine-python/examples GITRADER_GEP_TOKEN=<token> python engine/main.py
```

## 沙箱与限制（策略是用户代码）

策略文件在**独立子进程**里装载与求值，永远不在引擎进程内执行（`engine/strategy_child.py`）：

| 限制 | 缺省 | 环境变量 | 超限时 |
|---|---|---|---|
| 单个钩子（装载一次 / 一次 `evaluate`）墙钟上限 | `2 s` | `GITRADER_ENGINE_HOOK_TIMEOUT_S` | 杀掉子进程，`strategy.start` 回 `4002 STRATEGY_ERROR`，加载报告写 `limit: "hook_timeout"` |
| 回测里一次「整段信号」调用（文件策略跑一遍 `evaluate`）| `max(2 s, 15 × 钩子上限)`（缺省 30 s），再被整次回测上限截断 | 同上 + `GITRADER_ENGINE_BACKTEST_TIMEOUT_S` | 杀掉子进程，作业 `failed`，`backtest.result` 回 `4002 STRATEGY_ERROR` |
| 整次回测墙钟上限 | `900 s` | `GITRADER_ENGINE_BACKTEST_TIMEOUT_S` | 回测循环协作退出，作业 `failed`，`backtest.result` 回 `4002`（不编造结果） |
| 内存上限（整个子进程，含解释器） | `256 MiB` | `GITRADER_ENGINE_MEMORY_MB` | 父进程轮询到就杀，报告写 `limit: "memory"` |
| RSS 采样间隔 | `20 ms` | `GITRADER_ENGINE_POLL_INTERVAL_S` | — |

沙箱静态校验（`engine/sandbox.py`，策略档）在子进程里先跑一遍：禁止任何 `import`（白名单 `math` / `statistics` / `decimal` /
`collections` 只给脚本档）、禁止 `os` / `sys` / `subprocess` / `socket` / `open` / `eval` / `exec` / `__import__` 与 dunder、
帧与闭包访问器、`str.format` / `format_map`（格式字段会隐式取属性）与写着逃逸用 dunder 名字的字符串字面量；受限 builtins 里没有 `print`（策略不能往 GEP 的 stdout 协议流写东西）。

**取舍（Windows，写在这里是因为它是真限制）**：`resource.setrlimit` 在 Windows 上不存在，所以内存上限不是内核配额，而是
「子进程 + 父进程轮询」：

- Windows 的 RSS 走 `GetProcessMemoryInfo`（`ctypes`，标准库即可，不需要 psutil），POSIX 走 `/proc/<pid>/statm`；
- 采样是**观察**不是拦截：两次采样之间分配又释放的峰值可能漏掉，所以子进程另报 `tracemalloc` 的 Python 堆峰值，两者取大；
  零页分配（没写过的 `bytearray`）可能不进工作集，这条就靠 `tracemalloc` 兜；
- 采样对象是**整棵进程树**：venv / uv 的 `python.exe` 常常只是启动器，`Popen` 拿到的 pid 只有几 MB，真正干活的是它的子进程
  （本机实测：`-c` 子进程自身 228 MB，启动器 5.9 MB）；
- 真要硬隔离得靠操作系统（Windows Job 对象 / cgroup），不在本包范围。
- 回测上限是**协作式**的（循环每根 K 线问一次），"最多跑这么久"，不是"一定在这么久内返回"；能硬杀的只有钩子那条子进程路径。
- 子进程只拿到最小环境（PATH / SystemRoot / SystemDrive / TEMP 等），`GITRADER_*` 与名字像密钥的变量一律不转发；缺 `SystemDrive` 时从 `SystemRoot` 推出，否则 Windows 会在工作目录下建出字面量 `%SystemDrive%` 目录。

超限不是崩溃：子进程被杀，引擎继续答 `engine.health` / `engine.describe`，同一次会话可以继续 `strategy.start` 别的策略。

## 没做什么

- 不下单、不接场所、不跑纸面/实盘；`order.*` 与 `market.*` 一律 5002。
- 不实现 `events.resume`（无事件保留窗，`gep.hello` 带 `resume` 回 5004，宿主用 `engine.snapshot` 对齐）。
- 不读 CSV / parquet 数据文件：`spec.data.source` 只支持 `host`（`files` / `engine` 回 4005）。资金费点也只在宿主给的时候才结算。
- 回测只做单标的、单策略（`subject.workflow` 不实现）；不做工作流回测。
- 强平只在单根 K 线上判定，没有跨根保证金路径、不做部分强平；没有延迟（`latencyMs` 恒 0）与盘中路径模拟。
- `strategy.*` 的方法名以 `packages/protocol/src/gep/methods.ts` 为准：协议里**没有** `strategy.describe` / `strategy.load`
  两个方法，所以本引擎不新造它们——「描述」由 `strategy.params`（按 `strategyId`）承担，「装载报告」由扩展方法
  `x-gitrader.strategy.files` 承担（methods.ts:371）。
- 实例只记状态、不逐根求值、不发信号（本包没有下单路径）；`indicators.py` 的指标尚未接到引擎面。
