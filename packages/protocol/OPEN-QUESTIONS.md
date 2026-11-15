<!-- SPDX-License-Identifier: Apache-2.0 -->
# 开放问题（契约 v0.1.1 落码中发现的疑点与缺口）

> 规矩：不改契约文件；这里只记疑问与建议，由主会话裁决。裁决后需要新字段的，先在 `CHANGELOG.md` 登记。

## 合伙人引擎（三维 AI 量化引擎）的已知需求

核对对象：契约 v0.1.1 §1（统一模型）、§2（GEP）、§5.3–5.4（授权书、提案）、§6（账本）。结论写法："已支持（字段 x）"或"缺口 + 建议"。建议都不是契约修改，只是供裁决的方案；凡涉及新字段一律走 CHANGELOG 登记。

### 1. 拐点限价挂单（限价单带触发 / 失效条件、挂单生命周期事件）

- 限价挂单本身：**已支持**（`OrderIntent.type = limit` + `price`；`tif` 含 `gtc` / `alo` / `gtd`；`postOnly`）。
- 触发后转限价：**已支持**（`type = stop_limit` / `take_limit` + `triggerPrice` + `triggerType`；场所能力 `orderTypes` 声明是否原生）。
- 时间失效：**已支持**（`expiresAt`，映射 HL `expiresAfter`；`tif = gtd`）。注意 `gtd` 与 `expiresAt` 的配合没写明（`gtd` 是否必须带 `expiresAt`），建议在契约里补一句。
- 挂单生命周期事件：**已支持**（GEP `order` 流：`order.created / submitted / accepted / untriggered / triggered / amended / cancelled / expired / filled`；账本 `order.*` 全套；`Order.status` 含 `untriggered`）。
- **缺口：价格型失效条件**（"价格先破 X 则作废该挂单"）。契约没有这类字段，也没有条件单引擎。
  - 建议：留在引擎侧实现——引擎盯行情，条件成立时调 `host.order.cancel`（模式 A 本就允许），撤单理由写进 `reason`，`origin.causation` 带 `instanceId`；Gitrader 内核不引入条件单概念，避免变成第二个策略运行时。若合伙人坚持要场所侧保护，只能靠场所原生的 `stop_*` 组合。

### 2. 一仓多出场（多个子仓位，各自止盈 / 止损 / 时间出场，成交可归到子仓位）

- 单个止盈 + 单个止损挂在父单上：**已支持**（`OrderIntent.tpsl{takeProfit, stopLoss, grouping: order|position}`；`Order.parentOrderId` / `tpslRole`；能力 `tpsl.parentPartialCancel`）。
- 成交追溯到发起它的订单与策略实例：**已支持**（`Fill.orderId` → `Order.parentOrderId`；`Origin.causation.instanceId / strategyId / signalId`）。
- **缺口一：场所侧的持仓是聚合的**。`Position` 以 `accountId + instrumentId` 为键（HL 永续只有 `oneWay`），契约里没有"子仓位"。
- **缺口二：OCO / 多级出场计划 / 时间出场**没有字段：`tpsl` 只有一个止盈一个止损；没有 `ocoGroupId`；时间出场（"持满 N 根平仓"）没有承载。
- **缺口三：成交归子仓位**没有键。
- 建议（按改动从小到大）：
  1. 子仓位作为**引擎侧的虚拟账**：引擎自己维护 `legId → 订单集合`，多出场用多笔 `reduceOnly` 订单实现（每个出场一笔），时间出场由引擎在时点下 `reduceOnly` 单。不改契约。
  2. 需要内核和审计也能看到归属时，向 `Origin.causation` **追加可选字段** `legId`（子仓位 id）和 `exitPlanId`，向 `OrderIntent` 追加可选 `ocoGroupId`（同组一笔成交其余自动撤，内核或场所原生实现）。纯追加，不动旧字段。
  3. 对账：`Position` 仍是场所真实持仓；子仓位只是账本里的归因视图，其和必须等于 `Position.size`（可作为 `reconciliation` 的一项）。

### 3. 策略生命周期状态上报（假设 → 回测 → 留出验证 → 影子 → 小额实盘 → 退役；每级证据门槛；自动降级事件）

- 已有对应：`Experiment.stage = draft / backtest / paper / live_small / review / closed`（§1.4.12）；`Experiment.runs`、`biasChecks`、三级口径 `metrics`；授权书阶梯 L0–L4 与晋级门槛表（§5.3）；账本 `experiment.stage_changed`、`mandate.downgraded`、`mandate.expired`、`protector.triggered`；心跳超时自动降级（§5.6）。
- **缺口一：阶段枚举与合伙人流程不一一对应**——没有"留出验证（holdout）"，"影子（shadow）"在契约里是**账户模式**不是实验阶段，"退役"只能用 `closed` 近似。
- **缺口二：每级证据门槛只对授权书级别有定义**（§5.3 晋级表），实验阶段之间没有可机读的门槛字段。
- **缺口三：自动降级的"实验级"事件没有**：授权书降级有 `mandate.downgraded`，但实验被自动打回上一阶段没有专门类型。
- **缺口四：引擎上报策略实例状态**——GEP `strategy` 流只写了"实例启停与错误"，事件类型名没有枚举（本包按"第一段 = stream"校验，见下方"落码时自定的最小集"）。
- 建议：
  1. `Experiment.stage` 枚举**追加**取值 `holdout`、`shadow`、`retired`（枚举追加不破坏旧值；`closed` 保留）。
  2. 在 `Experiment` 追加可选 `gates`：`[{from, to, criteria, progress, passed}]`，形状复用 `Mandate.promotion.criteria / progress`，让门槛由内核计算、人面确认（沿用"晋级本身是人面专属"）。
  3. 自动降级用 `experiment.stage_changed`，`payload` 带 `direction: "demote"` 与触发规则，`origin.actor = system:…`，不新增账本类型。
  4. GEP `strategy` 流的事件类型建议定为 `strategy.started / stopped / error / stage_changed`，写进契约后一致性套件才能校验。

### 4. 分类模型的滚动训练事件（训练窗口、标签成熟边界、版本号；决策日志带模型版本）

- 已有：`kind = factor` 的 `provides.role = classifier`（本地分类 / 预测模型，只在本机运行）；`DecisionRecord.plugin{id, version, sha256}` 与 `input.digest`；`host.ledger.append` 可写 `signal / decision / note / log`。
- **缺口一：没有"训练事件"**——GEP 事件流里没有 `training` 类，账本类型里没有 `model.trained`。
- **缺口二：`DecisionRecord` 里的版本只是**插件**版本**。滚动训练时每次重训权重变了、插件包没变，决策无法追溯到具体模型版本。
- **缺口三：训练窗口、标签成熟边界**没有承载位置。
- 建议：
  1. `DecisionRecord` **追加**可选 `model: {id, version, sha256, trainWindow: {from, to}, labelMaturityMs}`（分类模型在快决策里被调用时填写）。
  2. 账本类型表**追加** `model.trained`（`payload`：模型 id / 版本 / 哈希、`trainWindow`、`labelMaturityMs`、样本数、验证指标），在追加前先用 `note` 条目（`host.ledger.append` 的 `note` 类型）暂代。
  3. 模型文件本身不进账本，只进哈希；事后标签回填沿用 `decision.resolved`（只追加，不改原条目）。
  4. "标签成熟边界"建议定义为：训练只用 `ts + labelMaturityMs ≤ trainWindow.to` 的样本——这是防前视的关键，应出现在 `biasChecks` 的说明里。

### 5. 黄金等非加密标的（合约乘数 / 点差 / 交易时段）

- 合约乘数：**已支持**（`Instrument.contractSize` + `venueSizeUnit`；名义额 = `size × price × contractSize`）。
- 资产类别与合成属性：**已支持**（`assetClass = metals / commodities / fx / stocks / indices …`；`underlying{description, synthetic}`；契约示例 `hyperliquid:xyz:GOLD`）。
- 精度 / 最小名义额 / 最大杠杆 / 保证金模式 / 费率：**已支持**（`price`、`size`、`minNotional`、`maxLeverage`、`marginModes`、`fees`）。
- 点差：**部分支持**——实时点差可由 `Book` / `Quote` 的买一卖一算出；**没有"典型点差 / 成本假设"字段**，回测的 `assumptions.slippageBps` 是全局单值，表达不了"黄金点差随时段变化"。
- **缺口：交易时段**。`Instrument.status` 只有 `trading / reduce_only / halted / delisted` 四值，没有时段日历、时区、休市窗口、夜盘薄流动性标记；HIP-3 的非加密标的在场所上虽 7×24 挂牌，但预言机在休市时段表现不同。
- 建议：给 `Instrument` **追加**可选 `sessions: {tz, windows: [{days, from, to, quality: "regular"|"thin"|"closed"}]}` 与 `typicalSpreadBps`（按时段可选）；在契约确认前，引擎可以用自己的日历，并在 `BacktestResult.assumptions` 里用 `x-` 键声明采用的时段与点差假设（`BacktestAssumptions` 本包已允许 `x-` 键）。

### 6. 亏损分解（提前出场 / 延后出场 / 违规 / 过度交易 / 残差）

- 现状：账本是**事实记录**（成交、盈亏 `Fill.realizedPnl`），`Experiment.metrics` 三级口径是自由形状对象，`BacktestResult.trades[].reason` 记录出场原因。**没有任何归因结构**。
- 建议：
  1. **不进账本头部、不入哈希链作为事实**。归因是派生的分析结论，和 `risk.denied` 这类事实性条目不同；需要留痕时用 `note` / `annotation` 条目引用被分析的账本区间（`subject.ledgerRef`）。
  2. **放进实验结果格式**：`Experiment.metrics.{backtest|paper|live}.lossAttribution`——`metrics` 现在就是自由形状，不用改契约就能放；建议在契约里把形状登记为推荐扩展：
     `{ totalLoss, earlyExit, lateExit, violation, overtrading, residual, method, basis: {fromSeq, toSeq}, sumCheck }`，各项为十进制字符串（现金流符号），要求 `earlyExit + lateExit + violation + overtrading + residual = totalLoss`。
  3. 归因依赖"每笔往返交易能对回开仓与出场原因"，所以与第 2 项（子仓位 / 出场计划归属）是一件事：先有 `legId` / `exitPlanId` 和出场 `reason` 的结构化取值，归因才可算。
  4. "违规"一项需要 `risk.denied` / `risk.precheck` 的 `ruleHits` 与实际成交对账——账本已有这些头部字段，**可直接复用**。

> **状态（v0.1.3）**：本节第 1–5 项缺口中，子仓位归属键、实验阶段枚举、训练事件 / `modelVersion`、交易时段 / 点差、亏损分解均已按建议以可选字段追加（见 CHANGELOG v0.1.3 与已决 D6）；"价格型失效条件"仍留在引擎侧实现，不进契约。

### 结论（一句话）

契约 §1/§2 已覆盖第 1 项的大半、第 5 项的合约乘数 / 资产类别、第 3 项的授权书侧阶梯；真正的缺口集中在四处——**子仓位与多出场计划的归属键、实验阶段枚举（留出验证 / 影子 / 退役）与门槛字段、训练事件与 `DecisionRecord` 的模型版本、`Instrument` 的交易时段与点差**；亏损分解建议放进 `Experiment.metrics` 而不是账本。以上全部可以用"追加可选字段 / 追加枚举值"解决，不需要改动任何旧字段。

## 已决（主会话 / 维护者，2026-10-10，已落码）

| # | 决定 | 落点 |
|---|---|---|
| D1 | **引擎不限语言、不限跑在哪**：GEP 三种传输（本地 stdio、本地 ws、远程 wss 必须令牌或 mTLS）；启动配置语言无关 `{command, args, env, cwd}` 或 `{url, auth}`；uv 只是 Python 的可选便利；GSP 同样语言无关；类型与 schema 里没有任何必填的 python 字样 | v0.1.2 #1–#4；`src/gep/launch.ts`、`gep:EngineLaunch` |
| D2 | **大模型不做交易判断（底线）**：`Origin.actorType` ∈ human / engine / llm-agent / system（必填）；`RiskPolicy` 与 `Mandate` 的 `denyLlmLiveEntries` 缺省 true；LLM 来源的实盘开仓一律拒绝，减仓 / 撤单 / 提案不受限，人可有意关闭；账本保留 `actorType`；MCP 下单类工具描述写明受此策略约束 | v0.1.2 #5–#8；`src/agent/llm-policy.ts` |
| D3 | **Gitrader 完全开源、完全免费，Apache-2.0**；DCO；不再有分层许可 | v0.1.2 许可证一节 |
| D4 | **`seed` 撞名**：值为 number 的 `seed`（BacktestSpec 随机种子）放行，值为字符串的 `seed` 仍按助记词种子 5006 拒收（原第 1 条疑点，已决） | `findSecretFields()` |
| D5 | **`denyLlmLiveEntries` 与"限额自动"**：LLM 型钥匙（`actorType = llm-agent`）的"限额自动"档 = 纸面自动 + 实盘仅减仓与撤单自动，实盘**开仓**仍走"需确认"；只有用户在人面 + PIN 下显式关闭 `denyLlmLiveEntries`，LLM 钥匙的限额自动才包含实盘开仓；引擎型执行者（`actorType = engine`）不受该开关影响，由授权书额度约束（原第 16 条疑点，已决） | `llm-policy.ts`、`RiskPolicy` / `Mandate` / `AGENT_PERMISSION_TIERS` 注释 |
| D6 | **合伙人引擎四个缺口按建议以可选字段追加**（子仓位归属键、实验阶段枚举、`modelVersion` 与训练事件、交易时段与点差；亏损分解放 `Experiment.metrics`） | v0.1.3 |
| D7 | **HALTED 允许撤单与仅减仓平仓单**（契约原写"只撤单与查询"，勘误；增加敞口的单仍禁止） | v0.1.4 #2；`TRADING_STATE_ALLOWS` |
| D8 | **心跳超时维持契约语义**（授权书降级 + `halt_new` 进 REDUCING）；场所级 `scheduleCancel` 作为实盘挂单期间常驻看门狗，由内核定期续期，不依赖 HALTED | v0.1.4 #3 |
| D9 | 速率类限额 `maxDailyOrders` / `maxCancelsPerMinute` / `duplicateIntentWindowSec` 以可选字段追加 | v0.1.4 #1 |
| D10 | v0.1.5 七项定稿：market 事件形状、`strategy.start.sizing`、`host.order.place.origin` 提示、`x-gitrader.*` 扩展方法 + 新增 `host.proposal.create`（`act.propose` 走它）、`files[].format` 加 `json`、`seed` 例外收窄到 `spec.seed`、事件确认统一 `host.events.ack` | CHANGELOG v0.1.5 |
| D11 | v0.1.6：`BlockManifest.vendor` = `{name, url?}`、`license` = SPDX 字符串、`fixtures` = 数组；浏览器安全子路径 `/constants` 与 `/types`；`risk.state.usage`、`account.summary.dayStartEquity` | CHANGELOG v0.1.6 |
| D12 | v0.1.7：连接器账户快照可选字段 `asOf` / `stale` / `source`（`ws \| rest \| replay \| fixture`） | CHANGELOG v0.1.7 |
| D13 | v0.1.8：连接器可选能力 `bookSnapshot` / `refreshBook` + 能力位 `VenueCapabilities.bookSnapshot` | CHANGELOG v0.1.8 |

## 作废

以下条目随 D3 作废（契约文档同步时应一并删除）：

- ~~契约 §0.3 的"所属层 / 许可"三层表与文件头模板里的 `Gitrader-Layer`、"产品本体层"旧许可标识~~
- ~~§7.5"旧许可的 SPDX 标识串待核"、"Nautilus 桥代码归哪一层（建议 Apache）"、"同步服务端许可"~~
- ~~DCO / CLA 分层（改为全仓 DCO）~~
- ~~"许可边界"CI 检查（协议与 SDK 层的依赖图里不得出现旧分层许可或专有包）~~——仓库只有一个许可证，该检查已无对象；本包只保留"协议包不依赖其他 @gitrader 包"的架构检查
- ~~定义 v2.1 §十二 / §十三 的三层许可与旧版许可措辞~~（"商业层"若仍存在，指不在本仓库的托管 / 协作服务，不再是许可证层）

## 落码时自定的最小集（契约没给，A 按最小必要集定义；确认或推翻后请告诉我）

见 `CHANGELOG.md` 末尾"相对契约文字新增的字段 / 结构"表。

## 契约自身的疑点与矛盾（请主会话裁决）

1. ~~**S1 的 `seed` 与 `BacktestSpec.seed` 撞名**（已决 D4）~~ **S1 的 `seed` 与 `BacktestSpec.seed` 撞名**：§2.10 S1 要求名为 `seed` 的字段一律 5006 拒收，而 §2.4 的 BacktestSpec 自带必填 `seed`（随机种子）。已按"值是 number 的 `seed` 放行（它是 RNG 种子），值是字符串的拒收"处理。建议契约把 S1 的字段名改成 `seedPhrase` / `mnemonic` 并明说。
2. **MCP 描述长度口径冲突**：§5.7 写"英文 ≤300 字符"，派活单要求"中文、每条 ≤60 字"。已按派活单。
3. ~~**插件 `id` 前缀与 `kind` 不一致**（已决 r2：`ID_PREFIX_OF_KIND`，唯一例外 `decision-model` 的前缀写 `decision`；`checkPluginManifestIssues` 报 `ID_PREFIX_MISMATCH`）~~ **插件 `id` 前缀与 `kind` 不一致**：§3.1 写 `<kind>.<vendor>.<name>`，但示例用 `decision.typesafe.jev` 而 `kind` 是 `decision-model`。schema 只校验字符集与至少三段，前缀由语义检查校验。
4. **id 前缀表不全**：§1.2 前缀表没有 `inst`（策略实例，示例 `inst_01JAB9`）、`cfg`（端点配置，示例 `cfg_local_decider`）、`bi`（块实例）、`ws`（工作区）。`inst` 已进 `Common`；`cfg` / `bi` / `ws` 按普通字符串处理。示例里有缩写 id，id 正则放行 3–26 位，没有强制 ULID。
5. **`RuleHit.limit / actual` 要求十进制字符串，但有些规则不是数值**（白名单、`TRADING_STATE`、`LLM_LIVE_ENTRY`）。暂定：布尔 / 计数类用 `"0"` / `"1"`，`unit` 写 `entries` / `flag`；建议契约明说。
6. **`OrderIntent.maxSlippageBps` "市价类必"与"缺省取风控策略的值"矛盾**。schema 不要求线上必填（缺省由内核补）；预检后的规范化意图应当总是带它。
7. **`tif: gtd` 与 `expiresAt` 的关系没写明**（`gtd` 是否必须带 `expiresAt`）。schema 不强制。
8. **版本号口径**：§0.4 写 GEP 0.1.0，派活单写"GEP v0.1.1"。已区分：`CONTRACT_VERSION = 0.1.1`、`GEP_SPEC_VERSION = 0.1.0`、协商 `0.1`、本包 `0.1.2`。
9. **回测结果数值类型**：契约只写"比例改为分数"，没说 number 还是十进制字符串。已按"分析级数据允许 number"处理（统计量、权益曲线、回测成交），回测**输入**里的金额（`account.initialBalance`）用十进制字符串。需要确认。
10. **"K 线内顺序"假设项没有字段名**：O3 要求"费、滑点、K 线内顺序、资金费、强平"五项齐全，`BacktestSpec.assumptions` 里只有 `fees / slippageBps / fillModel / funding / liquidation / latencyMs`。已把 `fillModel`（如 `next-bar-open`）当作"K 线内顺序"。
11. ~~**`host.events.ack` 是请求还是通知**（已决 D10：通知，两个方向统一用它，`events.ack` 为弃用别名）~~ **`host.events.ack` 是请求还是通知**：§2.4 把它和 `host.events.subscribe` 写在同一行，结果列只有 `subscriptionId`。已按通知处理。
12. **`gep.hello` 带 `resume` 失败（5004）后，连接是否仍可用**：§2.2 说"补不齐回 5004，宿主调用 `engine.snapshot` 全量对齐"，没说 hello 失败后会话是否保留。假引擎与 T11 按"连接保留、可调用 snapshot"实现。
13. **模式 B 的一致性用例（B1–B5）无法落地**：需要引擎连接套件提供的确定性假场所，契约没规定假场所地址 / 凭据怎么交给引擎。B1–B5 登记为 todo。
14. **回放（O5）与大载荷（O8）没有可判定的交付方式**：回放的"成交序列"经哪个流或方法交付、什么规格触发 >1 MB 结果，契约都没写。登记为跳过。
15. **`mandate:` 来源的 `actorType`**：授权书自动批准的动作映射为 `system`（规则自动执行），`workflow:` 映射为 `engine`。若 维护者 认为工作流里的快决策模型应算 `llm-agent`，需要改映射。
16. ~~**D2 对"限额自动"档的实际影响**（已决 D5）~~ **D2 对"限额自动"档的实际影响**：对 `llm-agent` 的钥匙，L3 / L4（界面"限额自动"）在 `denyLlmLiveEntries` 默认开启时，`order.place` 的实盘开仓会被拒——相当于 LLM 钥匙在默认设置下最高只能"需确认"（提案）。界面上"限额自动"这一档要么明确提示"需先关闭 LLM 实盘开仓限制"，要么只对 `engine` 来源开放。需要产品裁决。
17. **`Origin.actorType` 必填会让 v0.1.1 的契约示例不再通过 schema**：测试夹具加载时按 `actor` 前缀补齐；契约文档同步时示例应补上该字段。
18. **安装依赖偏差**：按派活单只应装 typescript / vitest / esbuild / ajv / ajv-formats；另装了 `@types/node@22`（纯类型，所有包的 tsc 都需要）。`ws` 没装，所以套件自测里没有 WebSocket 服务端，WebSocket 传输只写了客户端（由 engine-core 的接入测试覆盖）。
19. **远程 wss 的 mTLS**：套件用 Node 全局 WebSocket，不能带客户端证书；mTLS 只在启动配置层校验。
