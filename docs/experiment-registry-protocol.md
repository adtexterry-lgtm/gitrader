<!-- SPDX-License-Identifier: CPAL-1.0 -->
# 实验注册表协议 `gitrader-experiment/1`（r1.2 · 施工版）

> 状态：施工版（2026-10-14）。两轮对抗审稿（3 阻断 + 14 应修；复核 1 阻断级残留 + 新问题 R2–R12）后定稿，记录在内部目录 `reports/experiment-r1/`。本版把范围切成 **r1（本轮：到 `shadow → live_small`，只用纸面前向）** 与 **r1.2（实盘前向、出入金、资金费、PBO 输入、统计插件）**，见 §15。实现落点：`packages/protocol`（类型、阶梯表、证据包、问题码、一致性夹具）、`packages/kernel`（新建 `lab.ts`：注册表服务、运行表、算数、阶梯、签名、导出与验证、产物落盘、日快照）、`packages/engine-core`（代码内容哈希、证据包草稿、逐笔与权益必出产物）、`packages/mcp` / CLI。
> 一句话：**实验是一条只能往后加的记录：假设 → 回测证据包 → 留出 → 前向（纸面 / 影子 / 实盘）。回测数字永远标「假设性」；前向数字只由内核从它自己盖章的成交和盯市权益算出来，起点由内核定、归属到逐单，谁也改不了、补不了、挑不了；每一步晋级都要拿进入当前阶段之后产生的证据，跑不赢基准就写跑不赢。**

## 0. 与 M1 的关系：追加，不重写

M1 已有：`Experiment` 文档与 11 个阶段枚举、MCP `experiment` 工具（create / get / list / update / attach）、`backtest` 工具与 `BacktestSpec / BacktestResult`、账本 lab 类型、回放 / 回测产物永不混进前向账本的 `source` 规则、`EvidenceRef`、`LossAttribution`。

M1 的缺口（本协议要堵的，全部有代码位置）：
1. `experiment.update` 允许调用方直接写 `metrics` 与 `stage`；`create` 可以直接指定阶段。
2. `attach` 的运行记录整个由调用方给（含 `from` 与 `ledgerRange`）：补录、挑窗口、挑账户都能做。
3. `backtest.run` 由内核原样转发、不留记录：跑 200 组只挂最好的一组，试验数就是 1，留出区间「没碰过」。
4. 文档覆盖式保存、账本没有版本链；回测结果没有证据包、签名、PIT 边界、留出 / 样本外、LLM 知识截止；小回测逐笔与权益不落盘；`host.artifact.put` 是占位。
5. 前向统计没人算；成交归属只按账户。
6. 没有晋级阶梯、没有归属检查。

本协议只追加：字段、运行表、阶梯表、证据包、问题码、内核算数的规则；旧字段原样保留（写入口改由内核）。

## 1. 红线映射

| 红线 | 本协议怎么满足 | 章节 |
|---|---|---|
| 1 一切皆插件 | 核心只做「记录、算数、阶梯、签名、落盘」；统计检验与插件基准线是 r1.2 的插件位，r1 只把它们需要的输入记全 | §3.7 §15 |
| 2 用户拥有第一性 | 实验、运行表、证据包、产物全部在本机；导出是可验证的 JSON 包，不上传；策略只存内容哈希 | §6 §7 |
| 3 模型不碰钱 | 阶段只是标签，不开任何执行口；到实盘的两级转移只能人在工作台完成，MCP 不返回要 PIN 的码；`review` 只能回到来源阶段或更早 | §4 §9 |
| 4 前向才作数 | 仅追加 + 版本链入账（全文与 patch 原文）；`metrics / forward / stage / llm.involved` 调用方不可写；前向起点 = 内核附加时刻，统计只认内核盖章成交与日快照，逐单归属到执行者；试验数与留出判定以本机全部运行为准；晋级只认进入当前阶段之后产生的证据；同族同期的并行前向实验并列披露；回测永远 `hypothetical`；`vsBaseline` 为负照写 | §3 §4 §5 |
| 5 零承诺语言 | 没有「预期收益」字段；`conclusions` 走承诺用语词表；榜单 `provisional` 到窗口结束；导出页首固定免责句 | §5 §10 |

## 2. 术语

- **实验**：一个假设 + 一个主题（策略或工作流的钉死版本 + 参数）+ 一串只能追加的记录。
- **主题键（subjectKey）**：策略 = 引擎加载时算出的**文件内容哈希**（经 `strategy.list` / `BacktestResult` 回报，不是自报版本号）；工作流 = 工作流**结构**（节点与边，不含参数与 id）的 JCS 哈希。派生实验与父实验同族。主题键只用于版本对账与展示分组，**不**用于留出与试验数的判定（它可以被另存一份绕开）。
- **运行表**：内核转发每一次 `backtest.run` / `replay.start` 时记的一行：执行者、标的集、窗口、规格摘要、结果摘要、收益序列产物（若有）。
- **留出碰过**：本机运行表里**任何一次**运行（不限主题）的标的集与该留出窗口在同一标的上有时间交集，即算碰过。
- **证据包**、**三级口径**、**前向**、**执行者**：同 r1.1（§3）。
- **试验数（trialCount）**：取两者较大者：同族不同规格摘要的回测数；同一执行者（钥匙或引擎实例）近 30 天在本机的全部回测数。

## 3. 对象定义（字段级）

对账级 `Decimal`；分析级统计可用 JSON number；时间整数毫秒；规范化 RFC 8785（`canonicalize`）。所有新增登记在 `packages/protocol/CHANGELOG.md`。

### 3.1 `Experiment` 追加字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | `number` | 单调递增 |
| `owner` | `{ actorType; mandateId?; userId? }` | 创建者；只有创建者（同一把钥匙）或人能改、能降级、能附加运行；其他只读 |
| `subjectKey` | `Sha256Digest \| null` | 内核从 `subject` 推出；引擎给不出内容哈希或纯 Agent 执行 → `null` |
| `executorKind` | `'engine' \| 'agent' \| null` | 第一个运行附加时定；决定可达的最高阶段（§4） |
| `frozen` | `{ hypothesis; subject; holdout }` | 首包附加后 `hypothesis` / `subject` / `holdoutWindow` 冻结 |
| `holdoutWindow` | `Window \| null` | 冻结的留出窗口（§3.5） |
| `holdoutRunId` | `string \| null` | 冻结后第一次触及留出窗口的运行；只有它能出留出包 |
| `packs` | `EvidencePackRef[]` | 只能追加：`{ packId, kind, tier, digest, at, runId? }` |
| `forward` | `ForwardStats \| null` | 内核算（§3.4） |
| `baseline` | `BaselineRef \| null` | §3.5 |
| `llm` | `{ involved: boolean; derivedFrom: 'creator' \| 'workflow' \| 'declared'; models: { id; trainingCutoff?: Ms; source: 'kernel-table' \| 'declared' }[] }` | `involved` 内核推导（创建 / 编辑者 `actorType = llm-agent`，或工作流含 LLM 节点）；调用方只能 `false → true`；模型身份由调用方申报、内核核实不了，`models` 为空且 `involved = true` → 污染按 `unknown`（= `possible`） |
| `stageEnteredAt` | `Ms` | 最近一次进入当前阶段的时刻 |
| `reviewFrom` | `ExperimentStage \| null` | 进入 `review` 时记下来源阶段；只能回到它或更早 |
| `conclusions` | `{ text; origin; at; version }[]` | 只能追加 |
| `lineage` | `{ parentExperimentId?; reason? }` | 派生关系 |

**写规则（内核强制）**：
- 调用方不可写：`metrics.*`、`forward`、`baseline`、`packs`、`runs`、`subjectKey`、`executorKind`、`llm.involved`（`false → true` 除外）、`llm.models[].trainingCutoff`（只能更晚）、`stageEnteredAt`、`reviewFrom`、`owner`、`version`、`holdoutWindow`（冻结后）、`holdoutRunId` → `EXPERIMENT_FIELD_READONLY`。`runs` 只能经 `attach` 追加，不能经 `update.patch` 提交。
- `stage`：不可 patch、`create` 时忽略（一律 `hypothesis`）；只能经 `stage` 动作。
- 冻结后改 `hypothesis` / `subject` / `holdoutWindow` → `EXPERIMENT_FIELD_FROZEN`；要改就开派生实验。
- `runs[] / data[] / packs[] / conclusions[] / notes[]` 只能追加 → `EXPERIMENT_APPEND_ONLY`。
- 非 `owner`、非人 → `EXPERIMENT_FORBIDDEN`。
- 每次写入：`version + 1`，账本 `experiment.updated{ fromVersion, toVersion, patch（原文）, docDigest }`；`experiment.created` 载荷放初始文档全文。

### 3.2 `ExperimentRun`（前向运行记录）追加字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `runId` | `string` | 内核分配 |
| `attachedAt` | `Ms` | **内核**写入时刻 = 前向起点；调用方给的 `from` 忽略并记 `warn` |
| `executor` | `{ kind: 'engine'; engineId; instanceId; codeDigest: Sha256Digest \| null } \| { kind: 'agent'; mandateId }` | 必填。`agent` 的 `mandateId` 必须是**调用方自己的**钥匙；`engine` 实例必须是人绑定过的（`engine.bound`）；否则 `EXPERIMENT_FORBIDDEN` |
| `to` | `Ms \| null` | 由人或内核（降级、退役）写；不能设在过去 |
| `ledgerRange` | 内核推导 | |

前向成交逐单按 `order.intent` 的 origin（actor / mandateId / engineId / instanceId）匹配 run 的 `executor`；匹配不上的不计。

### 3.3 `EvidencePack`（证据包）

同 r1.1 §3.3 的结构，补三处：
- `runId` 必填（回测包指运行表行；前向包指 run）。
- `trialStats` 的来源是运行表；`returnsArtifact?: { artifactId; sha256 }`——引擎给出收益序列产物时记下（PBO 输入，r1 可选、r1.2 必填）。
- `at`（包创建时刻，内核写）进摘要；晋级比较用它。
- K 线摘要按标的记为 `data.candlesDigests: { instrumentId, digest }[]`，单标的也用数组；旧 `data.candlesDigest?` 保留并标 deprecated。数组中的标的唯一且与 `spec.instruments` 一一对应，周期取 `spec.interval`；每个 digest 只计算该标的、该周期的数据，规范化规则与测试向量见协议包 `conformance/experiment/README.md`。
- `BacktestResult.pack: EvidencePackDraft` 是引擎草稿，省略 `packId / experimentId / runId / at / trialCount / trialStats / provenance / attestation`，由内核收包时补齐。MCP `pack` 的入参另用 `ExperimentPackInput { runId; note? }`：仅引用已有运行及可选备注，统计、PIT、污染标记都由内核从记录推导，调用方自报一律拒绝。

规则不变：五项假设、`spec` / `specDigest`（内核 JCS）、`instrumentMeta`、`trades` / `equity` 产物必落盘、`gitrader-candles/1` 哈希约定、`llm.contaminated` 三态（`unknown` 按 `possible`）、`leakFreeFrom = max(trainingCutoff) + 余量`（待拍板 #6）。

### 3.4 `ForwardStats`（r1：纸面前向；口径写死）

```ts
interface ForwardStats {
  tier: 'forward_paper' | 'forward_live'; runIds: string[]; accountIds: AccountId[]
  window: { from: Ms; to: Ms }; ledgerRange: { fromSeq; toSeq }
  sample: { trades; fills; roundTrips; spanDays; activeDays; snapshotDays }
  valuationCcy: string
  realizedPnl: Decimal; unrealizedPnlEnd: Decimal; fees: Decimal; funding: Decimal   // r1 纸面：funding 恒 "0"
  returnRatio: number; maxDrawdownRatio: number; sharpe: number | null; sortino: number | null; winRatio: number | null
  periodsPerYear: number; includesUnrealized: true
  vsBaseline?: { baselineId; excessReturnRatio: number }
  provisional: boolean; computedAt: Ms; computedBy: 'kernel'; digest: Sha256Digest
}
```

- **数据源**：账本里 `attestation ∈ { kernel-observed, venue-confirmed }` 的 `fill`（r1.2 加 `funding / liquidation` 与出入金条目）与内核写的 `position.snapshot`（日快照）；逐单按 origin 匹配 run；`recordedAt` 早于 `attachedAt` 的不计；`engine-reported` 不计。
- **过滤断点**：同组仓位的开平之间若夹入不归属该运行的切片，该完整往返不计；其他合格切片的 PnL、费用与成交计数照常计算，从后续可归属的 `0 → 0` 周期恢复，不因该过滤断点拒绝整份统计。
- **日快照**：内核每个 UTC 日边界（00:00）为每个有前向运行的账户写一份盯市权益快照（`position.snapshot`，`kernel-observed`，含未实现盈亏）；另在每次阶段转移时写一份。**不**在每次成交后写。内核离线的日子没有快照：这些日子**不计入**收益序列（不顺延、不造零收益日），`snapshotDays` 如实记；`spanDays` 仍按日历算。
- **收益**：按有快照的日子算日收益，TWR 链式相乘；r1 纸面账户无出入金（r1.2 的实盘出入金走新账本条目，见 §15）。分母 = 运行起点权益（多账户为各起点权益之和）。
- **回撤**：日权益曲线最大峰谷比。
- **年化**：`periodsPerYear` 由场所声明（Hyperliquid 365）；夏普 = 日收益均值 / 样本标准差（ddof = 1）× √365，不扣无风险利率；索提诺下行偏差以全样本为分母；`snapshotDays < 10` → `sharpe / sortino = null`。
- **胜率**：按完整往返（仓位 0 → 0）扣手续费（r1.2 含资金费）后净盈亏 > 0 的占比；往返数 0 → `null`。
- **多账户**：PnL 相加，权益曲线按日对齐相加，币种统一为 `valuationCcy`；纸面与实盘永不合并。
- **provisional**：窗口未结束一律 `true`。晋级流程：人发起晋级 → 内核以**当前时刻**截断窗口、生成 `provisional = false` 的前向包（`at = 现在`）→ 包的 `digest` 进 PIN 在场证明的签名载荷 → 转移入账引用它。

### 3.5 留出窗口与基准线

- **冻结**：第一份回测包附加时，调用方给留出窗口；内核按「留出碰过」的定义（§2，本机全部运行、标的 × 时间窗）检查，通过即冻结 `holdoutWindow`，同时冻结 `subject`、`assumptions`、`seed`（留出评估必须用同一套）。
- **一次性评估**：冻结后，本机**第一次**标的集与留出窗口有交集的运行成为 `holdoutRunId`；只有它的结果能作为留出包附加；之后任何触及留出窗口的运行照常记入运行表，但不能再出留出包；想重来 = 开派生实验并换一个没碰过的窗口。
- **基准线**：`baseline = { baselineId; kind: 'buy_and_hold' | 'cash'; instruments: { instrumentId; weight }[]; window; prices: { instrumentId; startMark; endMark }[] }`；多标的等权（待拍板 #5）；价格取内核在窗口起止记录的场所标记价；起始资金 = 运行起点权益；成本同策略。只在同窗口同基准内比较。

### 3.6 版本对账

- `pinMismatch`：run 的 `executor.codeDigest` 与回测包的 `subjectKey` 比较：相等 `false`，不等 `true`，任一侧缺失或 Agent 执行 `unknown`；`true / unknown` 禁止 `live_small → live`（r1.2）。
- GEP 的策略清单条目与 `BacktestResult` 追加 `sha256`（文件内容哈希），由引擎加载器计算（E 包）。

### 3.7 运行表（内核）

内核转发 `backtest.run` 与 `replay.start` 时记一行：`{ runId, kind: 'backtest' | 'replay', experimentId?, executor（调用方钥匙 / 引擎实例）, subjectKey, specDigest（内核 JCS）, instruments[], window, partitions?, startedAt, status, resultDigest?, stats?: { sharpe, nObs }, returnsArtifact?, packId? }`。结果回来时补齐。没有 `experimentId` 的也记。运行表进导出。

## 4. 阶梯

主线：`hypothesis → backtest → holdout → shadow → live_small → live`；别名：`draft = hypothesis`，`paper = shadow`；`review` 审阅态（只能回到主线 `reviewFrom` 或更早）；`retired` 是主线外终态，只允许保持或重开到 `hypothesis`；`closed` 终态。既有阶段枚举顺序不变，`stageOrder(retired) = -1`。

| 从 → 到 | 最低证据（内核判定；缺则 `EXPERIMENT_TRANSITION_DENIED`，message 列缺项） | 谁 |
|---|---|---|
| `hypothesis → backtest` | `subjectKey ≠ null`；`assumptions` 五项齐全 | 创建者 / 人 |
| `hypothesis → shadow`（直达） | 仅当 `subjectKey = null`（纯 Agent 执行或引擎给不出哈希）或 §4.1 的 LLM 情形；附加一个 `paper` 账户的 run | 创建者 / 人 |
| `backtest → holdout` | 运行表有本实验的回测行且 `trades ≥ 10`（待拍板 #10）；`biasChecks.lookahead = pass`；`holdoutWindow` 已冻结且 `holdoutRunId` 已产生留出包；数据 `pointInTime = true`；`llm.contaminated = 'no'` | 创建者 / 人 |
| `holdout → shadow` | 本轮留出包与对应回测包存在；留出包 `at ≥` 本轮进入 `backtest`（实验室）的时刻且 `at ≥` 对应回测包 `at`，仍须 `at ≤ now`、运行表匹配；附加一个 `paper` 账户的 run（`executor` 必填） | 创建者 / 人 |
| `shadow → live_small` | 前向包 `forward_paper`，`provisional = false`，窗口起点 = `max(attachedAt, stageEnteredAt)`，`spanDays ≥ A`、`roundTrips ≥ B`、`activeDays ≥ C`（待拍板 #2）；`vsBaseline` 已算；执行者的授权书与当前风控策略有效；同族同期并行的前向实验在待办里并列披露 | **人（工作台 + PIN）** |
| `live_small → live` | r1.2 | **人** |
| 任一 → `review` | 无；记 `reviewFrom` | 创建者 / 人 |
| `review → X` | `reviewFrom` 必须是主线阶段且 `X ≤ reviewFrom`；实盘门槛按该来源判定，`reviewFrom = retired` 不能回主线 | 创建者 / 人 |
| 任一 → `retired` | 无；不受 `reviewFrom` 限制 | 创建者 / 人 |
| 非终态 → `closed` | 无 | 创建者 / 人 |
| `retired → hypothesis` / `retired` | 重开或保持；其他目标拒绝 | 创建者 / 人 |
| 主线间降级（到更早阶段） | 无；`stageEnteredAt` 更新；到实盘仍须人面与 PIN | 创建者 / 人 |

### 4.1 LLM 参与的实验

`llm.involved = true`：回测只作假设性展示、不计入任何门槛（知识库 V10）。两条出路使用同一集合：已关联且 `stageEnteredAt ≤ at ≤ now` 的本轮回测包。`backtest → holdout` 仅当该集合非空且全部 `contaminated = 'no'`（其他证据门槛仍适用）；集合为空或含 `possible / unknown` 时允许 `backtest → shadow` 直达。旧污染包不阻挡本轮合格包，前向样本仍须独立满足门槛。导出与界面标「回测含模型知识窗口，仅供参考」。

### 4.2 转移的机械规则

- 跳级拒绝；别名按映射判定。
- **证据时间**：进入留出时，回测与留出包 `at ≥ stageEnteredAt(backtest)`，留出包还须 `at ≥` 对照回测包 `at`。进入影子时复用这一次性留出包，不要求它晚于进入 holdout；内核从阶段历史提供 `ExperimentTransitionEvidence.backtestEnteredAt`，缺失则拒绝。前向包的窗口起点取 `max(attachedAt, stageEnteredAt)`，窗口终点由内核在判定时刻截断。降级后再升级不能复用降级前的包。
- 纯 Agent 执行（`executorKind = agent`）或 `subjectKey = null` 的实验最高到 `live_small`；`live` 要求 `pinMismatch = false`（r1.2）。
- 到实盘的两级在 MCP 里一律返回 `EXPERIMENT_TRANSITION_DENIED`（reason：只能由人在工作台完成）并写请求附注、出工作台待办；待办里并列显示同一执行者 / 同族当前所有前向实验及其统计；**不**返回 `ATTESTATION_REQUIRED`。
- 每次转移入账 `experiment.stage_changed{ from, to, evidencePackIds, by, pinMismatch, attestation? }`；人到实盘的转移带强在场证明，证明载荷含前向包 `digest`。
- 转移只改标签，不改任何账户、授权书或风控状态。

## 5. 显示与榜单口径

同 r1.1 §5；另加：同族同期的并行前向实验必须并列显示（不许只给人看最好的那个）。

## 6. 导出、验证与数据 PIT

- `gitrader lab export / verify`：同 r1.1 §6（版本链全文重放、包摘要与签名、前向重算、`subjectKey` 与 `pinMismatch` 核对）。
- **数据 PIT**：内核自己录制的场所 K 线（`data.source = 'host'`）声明 `pointInTime = true`；文件与第三方数据源未声明时为 `'unknown'`；`false / unknown` 的包不能用于 `backtest → holdout`，导出标「数据未证明 PIT」。

## 7. 产物存储

同 r1.1 §7：`lab/artifacts/<experimentId>/<packId>/…`；`host.artifact.put` 真落盘；`trades` / `equity` 一律落盘；只追加；单包上限待拍板 #4。

## 8. 账本

不新增类型（r1）。载荷约定同 r1.1 §8；`position.snapshot` 只在 UTC 日边界与阶段转移时写。r1.2 为实盘出入金**新增**一种条目（见 §15），届时登记。

## 9. 码表与工具

问题码（REJECTED 段）：`EXPERIMENT_FIELD_READONLY = 1011`、`EXPERIMENT_FIELD_FROZEN = 1012`、`EXPERIMENT_TRANSITION_DENIED = 1013`、`EXPERIMENT_EVIDENCE_INCOMPLETE = 1014`、`EXPERIMENT_APPEND_ONLY = 1015`、`EXPERIMENT_FORBIDDEN = 1016`。不可重试。

MCP `experiment` 工具动作追加：`stage`、`pack`、`export`；`attach.run` 必须带 `executor`；`update.patch` 禁止只读字段；`create` 忽略 `stage`。

`checkTransition` 先核归属：`missing = ['owner']` 单独映射 1016，不混入证据缺项；其他转移/证据拒绝映射 1013，`stage.closed / stage.same` 按既有终态/追加规则映射 1015。`stage.retired` 与 `reviewFrom` 为 1013；不新增问题码。

`LossAttribution`：r1 字段保留、只读、为空；r1.2 内核从账本算。

## 10. 测试与口径

一致性夹具 `conformance/experiment/cases/*.json`：阶梯每条转移 × 允许 / 拒绝（含 `review` 回退参照、直达 `shadow` 的两种条件、降级后旧包不能升级、回测包按 `at` 比较）；`create` 带 stage 被忽略；只读 / 冻结 / 追加 / 归属四类拒绝；运行表：同规格重跑不增、不同规格 +1、`replay.start` 也记、执行者 30 天计数作下限；留出：标的 × 时间窗有交集即碰过、冻结后第一次触及的运行才能出包；`llm` 推导与三态；`attachedAt` 由内核定；成交归属按 origin；补录不计；`executor` 填别人的钥匙被拒；并行前向实验并列披露。前向统计夹具：给定成交 + 日快照（含离线缺日）→ 手算的 TWR / 回撤 / 夏普 / 胜率。导出后 `verify` 必须 `identical`。

## 11. 好坏示例

**好：晋级到 `holdout`**：运行表显示同族 7 次不同规格 + 该钥匙 30 天内 12 次回测 → `trialCount = 12`；留出窗口与本机任何运行在 BTC 上无交集，冻结；冻结后第一次触及留出窗口的运行出包，`trades = 23`、`lookahead = pass`、`pointInTime = true`、`llm.involved = false` → `backtest → holdout`。

**坏：另存一份策略清零**：复制文件加一行注释 → 新 `subjectKey`，但留出判定按本机全部运行、试验数按执行者 30 天计数 → 都不清零。

**坏：挑窗口 / 挑账户**：`attach{ run: { from: 30 天前 } }` → `from` 忽略，`attachedAt = 现在`；并行开 5 个纸面实验只送最好的去批 → 待办里 5 个并列显示。

**坏：降级洗证据**：`live_small → shadow → live_small` 用降级前的包 → 拒（窗口起点 `max(attachedAt, stageEnteredAt)` 之后样本不足）。

**坏：绕过两道 PIN**：`shadow → review → live` → 拒（`review` 只能回到 `reviewFrom = shadow` 或更早）。

**坏：冻结后反复试留出**：冻结后跑 50 次触及留出窗口的回测再挂最好的 → 只有第一次的 `holdoutRunId` 能出留出包。

**坏：MCP 要 PIN / 改数字 / 别人的实验**：同 r1.1。

## 12. 待拍板清单

| # | 事项 | 建议 |
|---|---|---|
| 1 | 新插件 kind `statistics` | r1.2；r1 记全输入 |
| 2 | `shadow → live_small` 门槛 A / B / C | 30 天、30 个往返、10 个有成交日 |
| 3 | `live_small → live` 门槛（r1.2） | 30 天、50 个**往返**、10 个有成交日；授权书 L3→L4 的「50 笔」按成交计，口径不同，届时一并改成往返 |
| 4 | 单包产物上限 | 50 MB |
| 5 | 多标的 `buy_and_hold` 权重 | 等权 |
| 6 | `leakFreeFrom` 余量 | 90 天 |
| 7 | DSR / PBO 是否进门槛 | r1 不进 |
| 8 | 保护器自动降级 | r1 不做 |
| 9 | 已知模型知识截止表放哪、谁更新 | 协议包常量，发布更新；自报只能更晚 |
| 10 | `backtest → holdout` 最低回测成交数 | 10 笔 |
| 11 | 日快照时刻 UTC 00:00；离线缺日不补 | 照此 |
| 12 | 纯 Agent 执行的实验最高到 `live_small` | 照此 |
| 13 | 实盘出入金走新账本条目（r1.2 登记） | 照此 |

已由既有规则决定：`unknown` 截止按 `possible`；胜率按完整往返扣费后；回撤含未实现盈亏；`review` 非终态且只能回到来源阶段。

## 13. 与其他协议的接口

同 r1.1 §13；另：引擎协议 `strategy.list` 与 `BacktestResult` 追加 `sha256`；`replay.start` 进运行表；风控闸门 K1 正在改的 `trading.ts` 本协议**不碰**（日快照由 `lab.ts` 定时写）。

## 14. 版本与合并顺序

协议包版本由主会话统一分配，排在风控闸门 P 包（0.1.11）与 r2.1 清单规则（0.1.12）之后。共改文件（`model/problem.ts`、`mcp/tools.ts`、`scripts/schemas-model.mjs`、`kernel/src/api/agent.ts`、`gep-host.ts`、连接器账户视图、`CHANGELOG`）按派活单顺序串行合并；内核逻辑全部在新文件 `lab.ts`，`agent.ts` 只改转调。

## 15. 范围切分

**r1（本轮）**：到 `shadow → live_small`，只用纸面前向。含：三处堵口（内核定起点、`create` 固定、运行表含 `replay.start`）；只读 / 冻结 / 追加 / 归属规则；版本链入账；证据包（`spec` / `specDigest` / 产物必落盘 / `trialStats` / `instrumentMeta` / K 线哈希约定 / `at`）；纸面前向统计（日快照、TWR、回撤、夏普、往返胜率、多账户）；留出冻结与一次性评估（标的 × 时间窗）；LLM 推导与三态；阶梯（含 `review` 参照、直达 `shadow`、证据时间规则、并列披露）；主题键与 `pinMismatch` 三态；导出与验证；产物落盘；两处既有测试（`agent-api.test.ts` 的 stage patch 用例）按新语义改写并在施工单点名。

**r1.2**：实盘前向（出入金新账本条目、资金费与强平条目写入点、`live_small → live`）；`statistics` kind 与 PBO 输入（收益序列产物必填）；插件基准线；`LossAttribution` 内核计算；保护器自动降级；榜单功能。
