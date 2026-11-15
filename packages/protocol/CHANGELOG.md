<!-- SPDX-License-Identifier: Apache-2.0 -->
## r7 WP-I · 两个只读视图 · 2026-11-08

- 新增人面只读查询 `engine.catalog`（`EngineCatalogView`：各就绪引擎已加载的策略与表单用参数，x-hidden 参数不出现；不可用引擎同 `EngineStrategyFailureView`）与 `portfolio.analysis`（`PortfolioAnalysisResult`：实盘 / 纸面一个口径的场所 / 策略 / 标的汇总，十进制字符串；估不了值时 `{ unavailable: true, details }`）。均不写账本，已有 op 不变。

## bots-wiring · 机器人模板接入 · 2026-10-30

- `StrategyListEntry`: 追加可选字段 `params`（参数声明数组或 JSON Schema），供机器人模板带出必填安全上限。

## B3-08B · Reconciliation advisory notices · 2026-10-22

Add `ReconcileNoticeData` for allowlisted local reconciliation notifications. The existing finding severity values are reused. `CONFIRMATION_EFFECTS_PENDING` is the fixed finding code used when a confirmed fill's follow-up work remains unresolved; this is a finding code, not a new protocol error code.

## B3-05B - Security state health types - 2026-10-22

Add `SecurityStateFile`, `SecurityStateFileStatus`, and `SecurityStateHealth` as typed snapshots for local security-state availability. The status reports only file kind and state (`missing`, `ok`, or `corrupt`); it carries no file contents or identity material. No schema change is required for these TypeScript-only diagnostic types.

## B3-02C1 · current session lifecycle · 2026-10-22

`SessionExchangeResult` optionally returns the issued `sessionId` and integer-millisecond `expiresAt`. Add the `session.logout` UI command, authenticated by the current session with session presence and no PIN; logout revokes only that session. Existing callers may omit the new exchange fields.
# 协议包变更记录

> **规矩：任何新字段、新枚举值、新错误码，先在此登记一条，再通知主会话；各包不许私加。已有字段只追加，不改名、不改语义。**
> 版本口径：契约文档 v0.1.1（`CONTRACT_VERSION`）；GEP 规范 0.1.0（`GEP_SPEC_VERSION`，协商只看 `0.1`）；本包 `PROTOCOL_PACKAGE_VERSION`。

## fix-r5 · 修复轮 5（引擎存活 / 回测终态 / 一致性套件）· 2026-10-29

- 一致性套件新增必测项 **T27**（引擎主动心跳）：绑定后引擎须按 `heartbeatMs` 自己发 `gep.heartbeat`，任意两条间隔 ≤ 3 个周期。新增必测项改变了「接上」的定义——不发心跳的引擎从此不再是合规引擎（Python 引擎本轮补齐）。假引擎加故障开关 `noEngineHeartbeat` 供套件自检。

## fix-r4 · 修复轮 4（风控留痕 / 追责 / 新手卡点）· 2026-10-28

- 临时放宽（ADR-33）：界面与 CLI 的「放宽限额」默认走既有 `risk.temporaryRelax`（1 / 4 / 12 / 24 小时，默认 4），永久修改只在二次确认（界面）或 `--permanent`（CLI）后走 `risk.relax`。`risk.temporaryRelax` 的 `fields` 只收 `RiskLimits` 已知键（否则 `INVALID_PARAMS`），并与现有覆盖层合并（同键以新值为准，合并后不得低于基线）；`risk.tighten` 同时从覆盖层删掉被收紧的键（账本 payload 追加 `clearedRelax`）。插件「永不可授予」清单追加 `risk.temporaryRelax`（共 10 项）。
- 账本导出 /2（ADR-34）：manifest 追加 `schema:'gitrader-ledger-export/2'`、`chainHead:{seq,hash}`、`complete`、`signature:{keyId,alg:'ed25519',sig}`（安装签名身份对 `'gitrader-ledger-export/2:' + digestOf(去掉 signature 的 manifest)` 签名）；导出前链头晚于最后检查点则先写一枚检查点；签名不可用拒绝导出。`verifyExport` 追加可选 `opts.trustedKey / opts.ledger`，结果追加 `warnings? / signer? / db?`。/1 旧件不再报「完好」。`ledger.export` 入参追加 `inline?: boolean`，回包追加 `billName` 与 `files?:{bill, manifest}`；导出目录追加 `账单.csv`（只含成交、本地时间），目录名改本地时间 `gitrader-ledger-YYYYMMDD-HHmmss`；trade-log 时间列改本地时间。
- 撤单归属（ADR-35）：子单（止损 / 止盈）的 `order.cancelled / order.expired` 的 `origin` 记触发主体（人；随人动作的系统撤 = `system:kernel` 且 requestId / causation 指向人；场所自发 = `venue:<id>`），不再沿用父单的 Agent。`accepted / triggered` 不变。
- `agentkey.revoke` presence 改 `pin`（ADR-36）。
- 新增 op `service.shutdown`（auth human，command，不要 PIN，写一条 `annotation.payload.setting='service_shutdown'`）（ADR-37）。
- `pin.set` 入参追加 `confirmWeak?: boolean`；弱 PIN 未确认时回参数错，`message` 以 `WEAK_PIN:` 开头（ADR-38，不新增问题码）。
- 内核 `status` 回包追加 `scopedStates: Array<{scope, state, reason?, since?}>`（全部非 ACTIVE 作用域）；`tradingState` 语义不变。
- 规则命中（ADR-39）：`SIZE_PRECISION`（action `limit`）补 `message: 'size rounded to instrument step: <from> -> <to>'`；`NEEDS_APPROVAL` 补 `message`，explanation 仍含 `expected=…`；预检估算在 1 倍买单等强平价 ≤ 0 时不输出 `liquidationPrice`；`problem-text` 对 ruleId 以 `#duplicateIntent` 结尾的 `COOLDOWN` 给「刚提交过一笔相同的单，N 秒内不重复提交」。不新增问题码、不改 ruleset 版本。
- `market.candles` 10 s 无结果回 `DATA_UNAVAILABLE`（`market.candles timed out after 10000 ms`）；Hyperliquid 取 K 线带 10 s 中止信号。
- MCP 工具描述（propose / order / takeover）追加：金额须先经用户确认、转述以返回字段为准（cancel_all 默认保留止损）；`packages/mcp/BUDGET.md` 重生成。

## fix-r3 · 打磨轮（Agent 引导 / 显示一致 / 内核缺口）· 2026-10-26

- MCP 名称引导（ADR-22）：新文件 `mcp/usage.ts` 导出 `MCP_TOOL_ALIASES`（工具名常见误写 → 正名）、`MCP_ACTION_ALIASES`（每个工具的动作常见误写 → 正名；目标只限只读动作）、`MCP_ACTION_USAGE`（每个工具每个动作一行 `--args` 示例）、`resolveMcpTool()`、`resolveMcpAction()`、`suggestMcpNames()`、`mcpUsageLine()`。`MCP_TOOLS` 本身（名字、动作、入参 schema、预算）不变。内核 `agent.<工具>`：动作别名在服务端解析后按正名执行；未知动作仍是 `INVALID_PARAMS`，消息保留 `(valid: …)` 并追加 `Did you mean: <正名> → <一行用法>`。MCP 未知工具消息追加最接近的工具名。
- 行情未就绪（ADR-23）：标的目录还没加载完时，预览 / 下单 / 提案不再报 `INSTRUMENT_UNKNOWN`，改报 `VENUE_UNAVAILABLE`（`retryable:true`、`retryAfterMs:3000`、`venue:{id, message:'instrument list is still loading'}`、`message` 以 `market data not ready:` 开头）；`problem-text` 按该前缀给「行情尚未就绪，3 秒后重试」。目录已加载而查无此标的仍是 `INSTRUMENT_UNKNOWN`。不新增问题码。
- `risk.stats` 入参可选追加 `{ sinceTs?: number }`；返回 `byActor[*]` 可选追加 `proposals?: number`（`proposal.created` 计数）；提案阶段被闸门拒的也计入 `denied`（ADR-25）。
- 行情断流（ADR-28）：`Position` 可选追加 `markTs?: number`（标记价对应的最近一次真实报价时间）；Agent `market quote` 无数据时返回 `{ quote:null, reason:'no_feed', hint }`（原为裸 `null`）。
- `OperationRateLimitConfig` 可选追加 `session?: { capacity?, refillPerSecond? }`：浏览器会话（人）单独的令牌桶，默认容量 1000、每秒回 300（ADR-29）。
- 引擎与记录视图（ADR-30）：`engine.list` 每项可选追加 `bindings?: { accountId, mode, mandateId? }[]`、`lastHeartbeatAt?: number`；`engine.bind` 若会去掉一个现有的实盘账户绑定，须显式带 `replaceLive:true`，否则 `INVALID_PARAMS`；`records.query` 返回可选追加 `total?: number`（同筛选条件下的总条数）。
- 纸面强平成交入账（ADR-24）：纸面场所强平的成交写账本 `fill`（载荷已有 `liquidation:true`），并补一条系统来源（`system:paper-liquidation`）、`clientOrderId` 以 `liq-` 开头的订单记录；账本 `annotation.payload.kind` 追加 `paper.liquidation`。实盘不变。
- 过载保护（ADR-27）：只对 Agent / 引擎主体：非豁免调用有全局在途上限（配置 `server.maxInflightReadOps`，默认 32），事件循环延迟 p99 超过 `server.loopDelayShedMs`（默认 200）时卸载只读调用；超出回 `BUSY`（4004，`retryAfterMs:250`）。下单 / 撤单 / 自保 / 急停 / 批准永不卸载；人面会话与服务令牌不受影响。
- `records.query` 入参可选追加 `actor?: string`（按执行方精确筛，如 `agent:<keyId>`）；`ledger.export` 回包追加 `dir`（导出落盘目录的绝对路径，只在本机界面显示）。
- `TakeoverRecord` 可选追加 `cancelPending?: number`（ADR-26）：`cancelled` 取撤单确认后的最终值；等确认超过 3 秒的数量记在 `cancelPending`，最终结果见账本 `cancel_all.confirmed`。
- `plugin.list` 每项可选追加 `license`（清单原样）；`plugin.grant` 新增 / 放宽权限缺 PIN 时回 `ATTESTATION_REQUIRED`（只收窄或启用不要 PIN；裁决 10）。
- `OperationRateLimitConfig.session` 未配置时，若顶层配了 `capacity` / `refillPerSecond`，会话桶沿用顶层值（兼容已有收紧配置）。

## fix-r2 · 混沌修复轮（崩溃一致性 / 状态完整性 / 限频）· 2026-10-25

- `Problem` 可选追加 `clientOrderIds?: string[]`：下单类调用结果未知时回传本次用到的 clientOrderId。口径写死：`retryable:true` 只表示「请求没发出 / 没被处理，可原样重试」；发出后结果不明一律 `VENUE_OUTCOME_UNKNOWN`（3006，`retryable:false`）并带 `clientOrderIds`。MCP `order preview` 结果回显 `clientOrderId`。
- `VenueOpenOrder` 可选追加 `parentVenueOrderId?: string`（子单所属父单的场所单号；纸面场所填写，其他连接器可不填）。
- `SecurityStateFile` 追加取值 `'paper-state'`（纸面状态文件；只出现在 `status.stateFiles` / `/api/health.stateFiles`，不计入安全状态的 `ok`）。`STATE_FILE_CORRUPT` 复用，不新增问题码。
- 内核 `status` 与 `/api/health` 追加 `ledgerVerify: { ok, mode:'full'|'tail', checkedFrom, checkedTo, at, failure?: { seq, reason } }`；`/api/health` 追加 `paperState: { state:'ok'|'fresh'|'missing'|'corrupt', reason?, dirty }`。
- 下单回执（`order.place` / `agent.order place` / `position.close` 的 `PlaceResult`）可选追加 `warnings?: string[]`；当前唯一取值 `state_not_persisted`（纸面状态未落盘，内核在后台重试）。
- 账本 `annotation.payload.kind` 追加：`order.child_adopted`、`order.child_replaced`、`position.unprotected`（载荷：parentOrderId、tpslRole、venueOrderId / clientOrderId、原因）；`paper.state_persisted`、`paper.rebuilt`；`ledger.restarted_empty`；`precheck.summary`（actor、windowStart、windowEnd、count、ruleHits、samplePrecheckIds）与 `precheck.daily`（actor、day、individual、summarized、ruleHits）；`rate.limited`（principal、operation、count、windowStart）。
- 账本 `order.rejected` 载荷 `stage` 追加取值 `'recovery'`（启动收敛：纸面单从未到达场所，`problem.message` 以 `INTERRUPTED_BEFORE_VENUE:` 开头，问题码仍 `VENUE_REJECTED`）；撤单收敛的 `order.cancelled` 载荷带 `reason:'never_reached_venue'`。
- 纸面资金费事件写账本 `funding`（载荷：instrumentId、amount（收到为正）、rate、intervalMs、positionSize）。
- `RATE_BUDGET` 问题码不变，`message` 前缀区分 `operation rate limit …`（Agent / 会话调用频率）与 `venue weight budget …`（场所权重）；指标追加 `gitrader_op_rate_limited_total{principal}`。
- `TakeoverRecord` 可选追加 `skipped?: { instrumentId, reason:'not_authorized' }[]`（受限钥匙自保跳过的非本钥匙仓位）。
- 意图规范化：只保留 `OrderIntent` 已知键，未知键丢弃并在 `normalization.warnings` 写明；调用方时间键（`ts`/`timestamp`/`createdAt`/`clientTs`/`sentAt`）早于内核时钟 60 s 以上或晚 5 s 以上 → `INVALID_PARAMS`。

## fix-r1 · 沙箱修复轮（P0 包）· 2026-10-25

- `RULE_CODES` 末尾追加 `TPSL_INVALID`（附带止损 / 止盈价位或用法不合规：止损在盈利侧、止盈在亏损侧、触发价非正、Agent 用 `grouping:'position'`）与 `STOP_REQUIRED`（`requireStopOnAgentOpen` 生效时 Agent 开仓未带止损）；`RULE_PROBLEM_DEFAULTS` 二者都映射 `RULE_DENIED`。旧码顺序不变。
- `PrecheckEstimates` 可选追加 `maxLoss?: Decimal`：带合规止损的开仓 = 数量 × 合约面值 × |参考价 − 止损触发价| + 手续费估算；只作展示，不参与放行。
- `OrderIntent.tpsl.*.triggerPrice` 与主价格同受精度规则（契约 §1.3）：`rounding:'passive'` 时止损腿按父单方向、止盈腿按相反方向取整（永远离参考价更远）；`reject` 时不在刻度上报 `PRECISION`。字段形状不变。
- 内核 `instruments.search` / `market.instruments` 结果可选追加 `dex?: string`（非主市场的市场组名，主市场不带）；`instruments.search` 只返回 `status:'trading'` 的标的。Hyperliquid 非默认 dex 的 `displaySymbol` 改为 `<dex>:<BASE>-PERP`（主市场仍 `<BASE>-PERP`）。
- MCP：导出 `ORDER_INTENT_REQUIRED`、`ORDER_INTENT_GUIDE`；`order.intent` 入参 schema 列出必填字段（`required`），`propose.intents` 描述列出必填字段与止损要求（守住 §5.7 嵌套上限）；`discover tool_help`（propose / order）结果追加 `guide` 文本。MCP 工具结果里键名以 `At`/`Ts`/`ts` 结尾、值为毫秒整数（≥ 1e12）的字段旁追加 `<键名>Iso`（ISO 8601 字符串），原字段不变。
- `RiskPolicy` 可选追加 `requireStopOnAgentOpen?: boolean`（缺省 = 不要求）：为 true 时 Agent 开仓未带 `tpsl.stopLoss` 被闸门以 `STOP_REQUIRED` 拒绝；由 true 改为 false / 缺省视为放宽（配置文件里写 false 被忽略，须人面 PIN）。新建数据目录时 CLI 把它写为 true。
- 新增 `model/problem-text`：`humanizeProblem(problem, {surface})` 与 `humanizeRuleHit(hit)`，问题码 / 规则码的中文文案表（覆盖全部 `PROBLEM_CODES` 与 `RULE_CODES`，另为 `STATE_FILE_CORRUPT` 预留一条）；`AUTH_FAILED` / `INVALID_PARAMS` 按原文关键字细分子码；`surface:'agent'` 的 `next` 保留英文原文。只是展示层，不改任何问题码与字段。
- 账本不新增事件类型：`gitrader pin reset` 记为 `annotation`（`payload.action:'pin.reset'`，载荷只有备份目录名与吊销数量）；配置风控段按摘要应用（P1-3）记为 `annotation`（`payload.kind:'policy.config_applied'`，含摘要、收紧字段、忽略字段）。
- 提案视图（内核 `proposal.list` / `proposal.get`）追加 `approvalNeedsPin: boolean`（判断出错按 true）；工作台据此只在需要 PIN 时显示锁。
- 内核 op 追加 `ui.prefs.get` / `ui.prefs.set`（session；界面偏好存数据目录的内核库，≤ 16 KB，不写账本）。
- 提案拒绝（`proposal.reject`）与批准对称写 `attestation`（digest 覆盖 proposalId、decision、note），`note` 截到 500 字；字段形状不变。
- `risk.stats` 结果追加 `byActor`（按 origin.actor：denied / review / 各规则码次数）与 `byRule`；原 `denied` / `review` / `deduplicatedBy` 不变。
- `agentkey.revoke` 返回值追加 `withdrawn`（自动作废的待批票号）、`openPositions`、`openOrders`（名下遗留，只统计不处理）；原钥匙字段仍在顶层。吊销后再用该授权书的报错消息写「这把钥匙已被撤销」，问题码仍 `MANDATE_EXPIRED`。
- 接管账本载荷 `takeover.applied` / `takeover.completed` 追加 `keptProtective`（撤单级接管保留的保护单张数）。
- 内核 op：`agentkey.create` 可选入参 `tokenFile?: boolean`，为 true 时令牌只写入 `<home>/agent-tokens/<名字>.token`、返回 `tokenFilePath` 且不返回 `token`；新增 `agentkey.request`（service / session 发起，先按档位校验）、`agentkey.request.list` / `.status`（只读，永不含令牌）、`.approve`（session + PIN）、`.reject`（session）；请求只存内存、10 分钟过期、同时最多 3 个；内核事件 `agentkey.request.changed`。

## B3-R1-P · reconciliation review and resolution protocol · 2026-10-23

Add optional persisted reconciliation review items, resolution input and receipt/result types. Review items retain their source finding, suggestion, fill, confirmation, and resolution evidence; existing account-view fields and confirmation effects state remain unchanged. Add schemas and validators for the four resolution/review interfaces.

## B3-06A1 · additive paper replay protocol · 2026-10-22

追加纸面回放配置、只读夹具/帧/状态类型及 `paper.replay.start/status/stop` 宿主方法；配置与市场/账本数值字段沿用字符串十进制和毫秒整数。此项仅定义可序列化协议与 JSON Schema，不实现数据加载、引擎运行或回放行为。

## B2-08C0 · IBKR本地股票标的配置 · 2026-10-22

`ConfigVenueView` 可选追加 `symbols?: string[]`，仅 `ibkr` 场所可携带；作为本机股票代码原样保存和投影。本项不表示行情已接通。

## B3-05A · 损坏安全状态文件错误 · 2026-10-22

追加协议问题码 `STATE_FILE_CORRUPT`（5010，`PROTOCOL`，不可重试），用于本机 PIN、密钥库、设备密钥与安装密钥状态文件损坏或读后被删除的固定失败响应。不改变现有问题码；既有通用 `Problem` schema 已允许整数 `code` 与非空 `name`，无需专用 schema 条件。

## B2-08A · 本机会话账户签名类型 · 2026-10-22

仅为本机 IBKR 实盘账户追加 `SignerType` 枚举值 `gateway-session`，表示下行连接器使用本机已解锁会话；不代表 API key 或钱包签名。其它账户与既有签名类型语义不变。

## B2-03 · 工作台只读响应类型 · 2026-10-22

本单只登记 TypeScript 消费者契约，不新增运行时行为、字段校验器、schema 或版本号。

| # | 位置 | 新增契约 |
|---:|---|---|
| 1 | `src/ui/views.ts`、`src/ui/index.ts` | 导出账户资产、权益历史、记录查询、策略实例聚合、实验列表/详情/回测结果、场所目录及安全配置投影类型。金额使用 `Decimal`，时间使用 `Ms`；记录资金费返回真实 `LedgerEntry`。 |
| 2 | `src/ui/views.ts` | `EngineStrategiesView` 为逐引擎成功行或 `{ engineId, unavailable: true, problem }` 失败行的联合；分页 cursor 为不透明值，limit 上限 500；权益区间半开，分钟数据可降采样，gaps 不插值。 |
| 3 | `src/ui/views.ts` | Notify、venues、accounts 使用单独安全投影；凭据值仅表示环境变量句柄，不是密钥。提供数组替换对应配置段，省略的段保持不变。 |

## B2-05 · 本地权益历史时间语义 · 2026-10-22

权益历史点的 `t` 表示本内核取得完整新鲜账户快照后的本地观察时刻，不表示权益变化发生时刻，也不替换连接器来源时间。`sourceTs`、由总线语义派生的 `asOf` 及可选 `confirmedAt` 仅作为内部来源追溯信息；字段与既有连接器时间语义不变。稳定账户的 `ts` / `asOf` 可较旧；存在时以 `confirmedAt` 判定新鲜度，缺失时遵循 `stale` 标记，不以来源时间年龄拒绝。

## v0.1.14 · 2026-10-21

依据：实盘接线 r1 A1。仅追加可选标的定位字段，不改变既有调用语义。

| 序号 | 位置 | 追加内容 |
|---:|---|---|
| 1 | `src/connector/connector.ts` | `VenueConnector.fills` 增加可选 `opts.instrumentId?: InstrumentId`；`orderStatus` 的 key 增加可选 `instrumentId?: InstrumentId`，供重启后的成交回补与查单定位标的。 |
| 2 | `package.json`、`src/gep/version.ts`、`README.md` | 协议包版本同步为 `0.1.14`；根 lock 元数据由后续离线依赖同步阶段单独更新。 |
| 3 | `src/model/problem.ts`、`src/model/risk.ts`、`src/connector/market.ts`、风险闸门 schema | 追加 B1 风控规则码、规则到既有问题码的默认映射、`GateInput.assemblyAdjustments` 与订单更新事件字段；既有字段与旧输入形状保持兼容。 |
| 4 | `src/model/risk.ts`、风险闸门一致性校验与 schema | `GateAdjustment.field` 追加 `markPrice`，并追加可选 `kind: 'warning'`，用于记录经规则命中核验的旧标记价警告；旧调整字段语义保持不变。 |
| 5 | `src/model/risk.ts`、风险闸门 schema | `GateInput` 追加可选 `cancelPriceChecks?: Array<{ instrumentId: InstrumentId; mark?: { price: Decimal; ts: Ms; source: 'venue_mark' } }>`，用于按取消标的记录 agent 价格见证；旧输入形状保持有效。 |
| 6 | `src/model/risk.ts`、风险闸门 schema | `cancelPriceChecks` 元素追加可选 `quote?: string`，用于注明已知价格的报价单位；缺少标的元数据时保留字面 `quote`，不推断币种。 |

## v0.1.13 · 2026-10-21

依据：P3 回测扩展与执行面追加。字段均可选追加，既有夹具、字段语义与枚举相对顺序不变。

| # | 位置 | 追加 / 变更 |
|---|---|---|
| 1 | `src/model/instrument.ts`、根入口 | 新增并导出 `FundingRatePoint { instrumentId: InstrumentId; t: Ms; rate: Decimal; premium?: Decimal }`；费率与溢价为规范十进制字符串，时间为整数毫秒。 |
| 2 | `src/gep/methods.ts` | 新增可选宿主方法 `host.market.fundingHistory`：入参 `instrumentId`、`from`、`to?`，出参 `points: FundingRatePoint[]`、`complete: boolean`；自动进入 `HOST_METHOD_NAMES`。引擎遇到 `METHOD_NOT_FOUND` 应降级为 `assumptions.funding=false` 并给 warning；本包不实现宿主或引擎行为。 |
| 3 | `src/gep/backtest.ts` | `BacktestSpec.data.files[]` 追加 `kind?: 'candles' \| 'funding'`，缺省 candles；`account.maintenanceMarginRatio?: number` 为非负分数，缺省 `0.5 / leverage`。 |
| 4 | `src/model/signal.ts` | `BacktestAssumptions.maxVolumeShare?: number` 为 0–1，缺省不限；`liquidationPenaltyRatio?: number` 为非负分数，缺省 0。`missingBacktestAssumptions` 仍只检查原五项。 |
| 5 | `src/gep/backtest.ts` | `BacktestStats` 追加分析级数值 `fundingPaid?`（正为净支出）、`feesPaid?`、`liquidations?`（非负整数）、`unfilledShare?`（0–1，因成交量限制未成交的名义占比）。 |
| 6 | `src/gep/backtest.ts` | `BacktestResult.funding?: { t: Ms; rate: number; notional: number; paid: number }[]`，`paid` 正为支出；`BacktestTrade.reason` 登记约定值 `liquidation`。资金费不进入 trades，单独记入 funding。 |
| 7 | `src/model/order.ts` | `OrderIntent.trailing?: { callbackRatio: Decimal; activationPrice?: Decimal; activationRatio?: Decimal }`；仅对 `trailing_stop` 有意义，callbackRatio 为大于零的比例字符串，activationPrice 优先于 activationRatio。`Order.trailing?` 为只读镜像；未携带该字段的旧订单仍有效。 |
| 8 | `src/ledger/entry.ts` | 既有 `order.amended` 不重复登记，补 `OrderAmendedPayload`：`orderId`、`before` / `after`，各含可选 `price`、`size`、`triggerPrice`；price / triggerPrice 可为 null，数值为 Decimal。追加 `order.status_unknown` 及 `OrderStatusUnknownPayload { venue; rawStatus; orderId }`。 |
| 9 | `src/ledger/entry.ts` | 追加 `plugin.health_changed` 及 `PluginHealthChangedPayload { pluginId; from; to; reason? }`；状态为开放字符串。旧 `engine.health_changed` 保留；历史账本不改写。载荷按既有独立类型 / schema 约定提供，账本 payload 仍允许整体脱敏。 |
| 10 | `src/model/instrument.ts` | `Candle.vwap?: number`：成交量加权均价，仅场所提供时填写，供分析级因子使用。 |
| 11 | `scripts/schemas-model.mjs`、`scripts/schemas-gep.mjs`、`schemas/**` | 同步上述字段、三个独立账本载荷、资金费率点与宿主方法入参 / 出参 schema，账本类型枚举同源生成；追加最少 schema 正反例，保留原夹具。 |
| 12 | 版本与连接器类型 | 协议包、`PROTOCOL_PACKAGE_VERSION`、README 与根 lock 的协议版本行同步为 `0.1.13`。连接器 market 的本地资金费率类型改从协议导入 / 转导出，保持原连接器根入口导出路径。 |

## v0.1.12 · 2026-10-20

依据：P2 实验注册表、GEP 与 MCP 扩展契约。

| # | 位置 | 追加 / 变更 |
|---|---|---|
| 1 | `src/model/signal.ts` | `Experiment` 可选追加 `version`、`owner`、`subjectKey`、`executorKind`、`frozen.hypothesis` / `frozen.subject` / `frozen.holdout`、`holdoutWindow`、`holdoutRunId`、`packs`、`forward`、`baseline`、`llm`、`stageEnteredAt`、`reviewFrom`、`conclusions`、`lineage`、`notes`。`ExperimentRun` 可选追加 `runId`、`attachedAt`、`executor`；`to` 保持必填并拓宽为 `Ms | null`。旧 `EXPERIMENT_STAGES` 顺序和值不变。 |
| 2 | `src/model/experiment.ts` | 新增 `Window`、`ExperimentExecutor`、`ExperimentOwner`、`ExperimentLlm`、`BaselineRef`、`ForwardStats`、`PackArtifact`、`ReturnsArtifactRef`、`EvidencePackRef`、`EvidencePackBase`、`BacktestEvidencePack`、`ForwardEvidencePack`、`EvidencePack`、`EvidencePackDraft`、`LabRun`；新增 `EXPERIMENT_STAGE_ORDER`、`EXPERIMENT_STAGE_ALIASES`、`TRIAL_WINDOW_DAYS`、`CANDLES_DIGEST_METHOD`、`LLM_LEAK_MARGIN_DAYS`、`KNOWN_MODEL_TRAINING_CUTOFFS`、`EXPERIMENT_READONLY_FIELDS`、`EXPERIMENT_APPEND_ONLY_FIELDS`、`EVIDENCE_PACK_KINDS`、`EVIDENCE_TIERS`、`LLM_CONTAMINATION_STATES`。 |
| 3 | `src/model/problem.ts` | 新增 REJECTED 且不可重试的问题码：1011 `EXPERIMENT_FIELD_READONLY`、1012 `EXPERIMENT_FIELD_FROZEN`、1013 `EXPERIMENT_TRANSITION_DENIED`、1014 `EXPERIMENT_EVIDENCE_INCOMPLETE`、1015 `EXPERIMENT_APPEND_ONLY`、1016 `EXPERIMENT_FORBIDDEN`。 |
| 4 | `src/gep/backtest.ts` | `BacktestResult` 可选追加 `pack: EvidencePackDraft` 与 `strategySha256: Sha256Digest`；证据包数据登记 K 线摘要及 `CANDLES_DIGEST_METHOD`。 |
| 5 | `src/gep/methods.ts` | `StrategyListEntry` 可选追加 `sha256: Sha256Digest`。 |
| 6 | `src/mcp/tools.ts` | 登记 MCP stage、pack、export 与 attach executor。 |
| 7 | schema 生成器与 `schemas/**`、`conformance/experiment/**` | 登记生成 schema 与实验夹具。 |
| 8 | 兼容规则 | 旧 API 可选追加；实验不会自动取得交易权限。 |
| 9 | `src/model/experiment.ts` | 新增 `ExperimentTransitionEvidence`：`actor.actorType`、`actor.mandateId`、`actor.userId`、`actor.via`、`packs`、`labRuns`、`accounts`、`authorizationValid`、`riskPolicyValid`、`parallelExperimentsDisclosed`、`presence.verified`、`presence.forwardPackDigest`。 |
| 10 | `src/model/experiment.ts` | 新增 `ForwardRunInput`（`runId`、`accountId`、`executor`、`attachedAt`、`to`）、`ForwardFillSlice`（`sliceId`、`fillId`、`orderId`、`runId`、`accountId`、`instrumentId`、`positionKey`、`seq`、`ts`、`recordedAt`、`attestation`、`origin`、`positionBefore`、`positionAfter`、`realizedPnl`、`fee`、`valuationCcy`）、`ForwardSnapshot`（`seq`、`accountId`、`at`、`recordedAt`、`attestation`、`kind`、`equity`、`unrealizedPnl`、`valuationCcy`）、`ForwardStatsInput`（`tier`、`window`、`stageEnteredAt`、`runs`、`initialEquity`〔`accountId`、`at`、`equity`、`unrealizedPnl`〕、`fills`、`snapshots`、`valuationCcy`、`periodsPerYear`、`finalized`、`computedAt`、`baseline`〔`baselineId`、`window`、`returnRatio`〕）。 |
| 11 | `scripts/schemas-model.mjs` | 新增 `ExperimentPatch`、`ExperimentCreatePatch`、`ExperimentAttach`、`ExperimentToolInput` schema；登记动作 `stage`、`pack`、`export`，顶层参数 `to`、`pack`、`holdoutWindow`，以及各动作的必需字段与 patch / attach 类型约束。 |
| 12 | `scripts/schemas-model.mjs` | 新增 `Window`、`ExperimentExecutor`、`ExperimentOwner`、`ExperimentLlm`、`EvidencePackRef`、`EvidencePackBase`、`BacktestEvidencePack`、`ForwardEvidencePack`、`EvidencePack`、`EvidencePackDraft`、`ForwardStats`、`BaselineRef`、`LabRun`、`ExperimentTransitionEvidence`、`ForwardRunInput`、`ForwardFillSlice`、`ForwardSnapshot`、`ForwardStatsInput`、`ExperimentRun`、`ExperimentPatch`、`ExperimentCreatePatch`、`ExperimentAttach`、`ExperimentToolInput` schema；统计与证据包嵌套层级、草稿字段省略按 D 登记。 |
| 13 | `scripts/schemas-gep.mjs` | `BacktestResult.pack`、`BacktestResult.strategySha256` 与 `Methods.strategy.list` 条目 `sha256` 可选。 |
| 14 | `src/gep/version.ts`、`package.json` | protocol package version 更新为 `0.1.12`；仅对应根 lock 中 `packages/protocol.version` 同步。 |
| 15 | `scripts/schemas-model.mjs` | readonly 根名、Experiment MCP 动作与 1011–1016 实验问题码条件从 `K` 同源派生；不限制既有/未知问题码。 |
| 16 | `scripts/schemas-model.mjs`、`conformance/experiment/**` | 新增 `ExperimentConformanceCase` 与 `ForwardConformanceCase` schema，供独立实验状态机和前向计算契约夹具加载；夹具期望不代表运行结果。 |
| 17 | `conformance/experiment/`、`test/experiment-p.test.ts` | 新增脱敏夹具 loader、33 个实验状态/未来内核契约样例与 4 个手算前向样例；仅新增两条 schema/夹具 `it`，覆盖声明结构，不执行纯函数或内核行为。 |
| 18 | `src/ledger/entry.ts` | 恢复载荷导出可整体脱敏的提醒，并保留实验载荷说明；仅注释。 |
| 19 | `src/experiment/` | 登记七个导出函数：`checkTransition`、`stageOrder`、`resolveAlias`、`isReadonlyPatch`、`isAppendOnlyViolation`、`computeForwardStats`、`candlesDigest`。P2 修订将 retired 作为主线外终态；留出与 LLM 分路使用一致的本轮证据；owner 拒绝单独映射 1016；过滤造成的仓位断点不计完整往返。 |
| 20 | `src/model/experiment.ts`、schema、设计稿 | `ExperimentTransitionEvidence.backtestEnteredAt?: Ms` 由内核从阶段历史提供，用于 holdout→shadow 的本轮实验室证据下限。`BacktestEvidencePack.data.candlesDigests` 为 `{ instrumentId, digest }[]`，单标的也用数组；原 `candlesDigest?` 保留并标 deprecated。 |
| 21 | `src/model/experiment.ts`、MCP schema | `EvidencePackDraft` 为引擎草稿，另省略 `packId / experimentId / runId`；新增 `ExperimentPackInput { runId; note? }`，MCP pack 仅引用运行，禁止调用方提交统计、PIT、污染标记。`runs` 加入只读根，移出 `ExperimentPatch`，仅经 attach 追加。 |
| 22 | `conformance/experiment/**`、`test/experiment-p.test.ts` | 替代第 17 项的仅加载限制：保留原测试，执行全部纯函数夹具；transition 可追加 `then` 转移步骤；新增 schema 拒绝/接受夹具及按标的 candles-digest 向量。前向夹具改用非对称收益，补过滤切片断点；内核契约仍只验证结构。 |

## v0.1.11 · 2026-10-14

依据：风控闸门协议 r1（`docs/risk-gate-protocol.md`），共同契约 17 项。此处逐项记录协议接口及本轮实际落点；未完成项仍按其所有权与阻塞状态处理。

| # | 位置 | 追加 / 变更 |
|---|---|---|
| 1 | `model/risk.ts` | 新增闸门 schema、动作 / 发起人 / 阶段 / 判决与保护器预检动作常量及类型；阶段含 `PROTECTOR:skipped`；辅助常量 `PRECHECK_VERDICTS`、`PROTECTOR_MODES` 同源；第二轮登记 `GATE_TARGET_KINDS`、`GATE_PATHS`、`GATE_KILL_SOURCES`、`GATE_IRREVERSIBILITIES`、`GATE_ADJUSTMENT_FIELDS` 并由其派生对应类型。 |
| 2 | `model/risk.ts` | 新增 `GateTarget` 五种目标形状及 `NormalizedIntentLike`。 |
| 3 | `model/risk.ts` | 新增 `ReservedView`、`GateInput`、`GateSnapshot`，`GateInput.originActorType` 必填并取既有 `Origin['actorType']`；补齐 `GateAccountView` 的可选 `confirmedAt?`；`PrecheckStats`、`StateReason` 沿用内核既有定义。 |
| 4 | `model/risk.ts` | 新增 `RiskPolicy.limitMode?`、`killSwitch?`、`failClosed.staleAccountMs?` 与 `Protector.mode?` / `source?`；r1.2 的 `killSwitch.tripAfter`、`limits.maxOrderNotionalByInstrument` 只登记名字，不实现。 |
| 5 | `model/problem.ts` | 新增五个规则码、`RuleHit.action: 'limit'`、问题码 2010 / 2011 及 `RULE_PROBLEM_DEFAULTS`；`RULE_HIT_ACTIONS` 为 schema 单源；旧八项映射从内核原表迁入协议。 |
| 6 | `model/order.ts` | 新增 `OrderIntent.allowAdjust?`，可选值为 `size`、`leverage`、`maxSlippageBps`；`ORDER_ADJUST_FIELDS` 与既有 `Side` 的 `ORDER_SIDES` 为 schema 单源。 |
| 7 | `connector/account.ts`、`model/risk.ts` | 新增账户视图字段 `availableDeductsOpenOrders?`、`openOrders?`、`stopLossOrderIds?`、`rules?`、`confirmedAt?`；`asOf?` 保持最后推送语义，有 `confirmedAt` 时按 `now - confirmedAt` 判定阈值，缺失时只检查 `stale`，不按 `asOf` 年龄拒绝。 |
| 8 | `connector/market.ts` | 新增 `MarkPrice`（`price`、`ts`）及可选 `source?`，值为 `venue_mark` / `last` / `mid`；此前协议文件无此类型。 |
| 9 | `connector/trade.ts` | 新增 `TradeContext.gate?`，含 `precheckId`、`ticketId`、`expiresAt`。 |
| 10 | `model/instrument.ts`、`connector/account.ts` | 登记场所规则静态能力 `{ maxOpenOrders?: { cap }; marketPriceBandBps?; minOrderNotional? }` 与账户动态规则视图；账户侧 `VenueRules` 已新增。 |
| 11 | `plugin/manifest.ts` | 新增 `PluginManifest.protector?` 与 `PROTECTOR_RULES_INVALID`；清单仅允许 `protector` kind 声明，`rules` 仅允许内置规则类型且不得自带 `source`（由内核并入时写入）。 |
| 12 | `model/decimal.ts` | 新增 `formatDecimal`（`normalizeDecimal` 的别名）、`GATE_DIV_SCALE = 18`、`GATE_RATIO_SCALE = 8`。 |
| 13 | `ledger/entry.ts` | 注释登记 `payload.gate={decision,snapshot,target}` 与 `payload.timing={assembleUs,decideUs,protectorUs}`；无需新增条目类型。 |
| 14 | `gep/version.ts`、协议包与根锁文件条目 | 协议包版本升至 `0.1.11`。 |
| 15 | schema 生成器与 `schemas/**` | 生成独立 `risk-gate.json`（含 GateInput、GateDecision、GateTicket、GateTarget、ProtectorPreVerdict 等定义）并更新 schema registry；`ConnectorAccountSnapshot.confirmedAt` 与 `VenueCapabilities.rules` 静态能力已进入生成 schema。 |
| 16 | `risk-gate/consistency.ts` | 新增纯函数 `checkGateDecisionConsistency()`，检查判决映射、review 必须升级且非 review 不得升级、`monitorHits` 动作、allow verdict 不含 deny hit、LIMIT 含至少一个 limit hit、ALLOW 的目标摘要一致。 |
| 17 | `conformance/risk-gate/` | 新增 21 个完整 JSON 一致性输入、README 与 `loadGateConformanceCases()` 加载器；协议测试覆盖 fixture schema、GateInput / GateTarget 条件、兼容字段、GateDecision 一致性映射、GateSnapshot、GateTicket、保护器结论与加载失败路径。第三轮补充 actor 来源、新鲜度、能力、购买力及 LLM / engine 对照夹具；仅验证声明与结构，`decide()` 仍由内核实现。 |
| 18 | `model/order.ts`、`model/risk.ts` | 新增 `TPSL_ROLES`、`POSITION_SIDES`、`GATE_ACCOUNT_MODES`、`PROTECTOR_PAUSE_SCOPES` 同源常量并由其派生对应联合类型；schema 复用这些常量与 `ORIGIN_ACTOR_TYPES`。 |

## v0.1.10 · 2026-10-14

依据：插件协议 r2.1 P0-2（红线 2 / 3）。

| # | 位置 | 追加 / 变更 |
|---|---|---|
| 1 | `TOOL_SOLICITS_SECRET`（`PLUGIN_ISSUE_CODES`） | 新增工具入参索要密钥问题码；字段词表并入内核 `SECRET_KEY_NAMES` 的 `seed`，其余重合词统一由协议扫描器处理 |
| 2 | `packages/protocol/src/plugin/secret-solicit.ts`；`normalizeForScan`（`manifest.ts`） | 导出 `findSecretSolicitation(schema, basePointer)`、`SECRET_SOLICIT_KEY_PHRASES`、`SECRET_SOLICIT_HANDLE_SUFFIXES`、`SECRET_SOLICIT_TEXT_PATTERNS`；复用并导出 `normalizeForScan` 文本归一化函数 |
| 3 | `PROTOCOL_PACKAGE_VERSION`、协议包与锁文件版本 | 升至 `0.1.10` |

第二轮补充：键名与说明扫描统一补足 NFKC、格式字符清理、camelCase/分隔符归一化和繁体词表；遍历所有 schema 对象与数组，扫描 `properties` 与 `required` 名称并仅跳过 `enum`、`const` 的值与 `default`、`examples` 里的标量，`dependentRequired` 名称按键名判定，数值 `seed` 仅在 `spec.seed` 且本地声明类型可证时放行；工具入参须成功序列化且不超上限后才运行密钥扫描。

## v0.1.9 · 2026-10-13

依据：插件协议 r2（`docs/plugin-protocol.md`）。老清单一个字不改仍然通过 schema；新增的语义规则各有一个问题码，其中身份前缀（`ID_PREFIX_MISMATCH`、`VENDOR_ID_MISMATCH`）会让 id 与 kind / vendor 对不上的老清单被语义层拒绝（这是新规则，不是 schema 收紧）。

| # | 位置 | 追加 / 变更 |
|---|---|---|
| 1 | `PluginManifest.tools?: PluginTool[]`（schema `plugin:1` 同步） | **工具声明**。`PluginTool = {name, desc, tags, input, output?, permissions?}`；`name` 满足 `PLUGIN_TOOL_NAME_RE`（`^[A-Za-z0-9_-]{1,64}$`）且清单内唯一，`desc` 非空且 <= 200 字，`input` / `output` 是 `type: "object"` 的 JSON Schema，`permissions` 是清单 `permissions` 的子集。`PLUGIN_TOOL_TAGS` 给 10 个推荐语义标签，词表开放。没声明的工具内核不转发 |
| 2 | `PluginManifest.evidence` 类型由 `Record<string, unknown>` 改为 `PluginEvidence = {claims: EvidenceClaim[], notes?}`；`EvidenceClaim = {metric, value: Decimal, basis, window: {from, to}, ref?, assumptions?}`；`EVIDENCE_BASES = backtest / paper / live` | **证据定型**（草案期内的例外：此前 schema 里 `evidence` 只是任意对象，没有任何内置清单带它）。`claims` 必填但可空数组 |
| 3 | `PluginManifest.name` 加 `maxLength 80`、`desc` 加 `maxLength 400`（schema） | 展示文案长度上限；旧清单超长会被 `SCHEMA` 拒 |
| 4 | `ID_PREFIX_OF_KIND` | `id` 第一段 = 该表对应值：全部等于 `kind`，唯一例外 `decision-model` -> `decision` |
| 5 | `PLUGIN_ISSUE_CODES`（35 个字符串码）、`PluginIssue = {code, path, message, hint?}` | **结构化清单问题码**。`path` 是指向清单字段的 JSON Pointer。清单：`MANIFEST_UNREADABLE` `SCHEMA` `ID_PREFIX_MISMATCH` `VENDOR_ID_MISMATCH` `DUPLICATE_ID` `PACKAGE_KIND_MISMATCH` `PERMISSION_NEVER_GRANTABLE` `PERMISSION_UNKNOWN` `PERMISSION_KIND_MISMATCH` `NET_HOSTS_EMPTY` `FACTOR_HAS_NET` `UNSIGNED_FORBIDDEN_PERMISSION` `KIND_REQUIRES_FIELD` `TOOL_NAME_DUPLICATE` `TOOL_SCHEMA_INVALID` `TOOL_PERMISSION_UNDECLARED` `TOOLS_NOT_CALLABLE` `EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS` `EVIDENCE_FORWARD_NEEDS_REF` `EVIDENCE_WINDOW_INVALID` `PRIVACY_SENDS_WITHOUT_NET` `PRIVACY_HOSTED_WITHOUT_NET` `PROMISE_LANGUAGE` `REQUIRES_VERSION_INEXACT` `HASH_MISMATCH` `UNSIGNED_NOT_ALLOWED` `SIGNATURE_KEY_UNTRUSTED` `SIGNATURE_DIGEST_MISMATCH` `SIGNATURE_INVALID` `ENTRY_MISSING` `ENTRY_NOT_FOUND` `ENTRY_ESCAPES` `COMPAT_SCHEMA_UNSUPPORTED` `COMPAT_RANGE_INVALID` `COMPAT_GITRADER_UNSATISFIED`。`DUPLICATE_ID`、`MANIFEST_UNREADABLE`、哈希 / 签名 / 入口各码由内核扫描时判，协议包只定义码。只追加，不复用 |
| 6 | `checkPluginManifestIssues(m): PluginIssue[]`、`checkPluginCompat(m, kernelVersion, supportedSchema = '1'): PluginIssue[]`、`checkPluginManifest(m): string[]` | 前者是纯语义检查（不碰文件系统，不管 compat）；`checkPluginManifest` 现在等于前者的 `message` 列表，**已有消息文本一字不改**。原有四条 kind 必填加上新增的 `block` 缺 `ui.blocks`，统一报 `KIND_REQUIRES_FIELD`。`checkPluginManifestIssues` 里的 schema 可编译性检查靠 `registerSchemaCompiler` 注册的编译器，根入口（含 `validate.ts`）加载时自动注册；只用 `./constants` 子路径（不含 ajv）时跳过这一项 |
| 7 | `validate.ts`：`ValidationIssue.code?`、`make()` 的语义检查可返回 `PluginIssue`、`compileSchema(schema)` | `validatePluginManifest` 的语义问题带 `code` 与精确 `path`（不再是 `/`）。`compileSchema` 用独立 Ajv 实例（`strict: false`，带 formats）编译任意 JSON Schema，失败抛 Error；供内核校验工具入参 / 出参，调用方自己缓存 |
| 8 | `PLUGIN_PROMISE_PATTERNS`、`findPromiseLanguage(text)` | 承诺类用语（中英各若干条）。扫描范围：`name`、`desc`、`tools[].desc`、`risk.disclosure`、`risk.worstCase`、`evidence.notes`；命中报 `PROMISE_LANGUAGE`，`path` 指到字段。词表变更走本文件 |
| 9 | `plugin/semver.ts`：`parseVersion` `compareVersions` `isValidRange` `satisfiesRange` | 够用的语义化版本（无第三方依赖）。范围语法：`>= > <= < =`、`^`、`~`、精确版本、`*`；空格 = 与，`\|\|` = 或；预发布版本只在同 major.minor.patch 的比较子自带预发布时才算入范围。`checkPluginCompat` 用它判 `compat.gitrader` |
| 10 | 错误码 `PLUGIN_TOOL_UNKNOWN = 5008`、`PLUGIN_RESULT_INVALID = 5009`（category PROTOCOL，不可重试） | 调用了清单里没声明的工具；工具返回值不合 `tools[].output`（结果不转发） |
| 11 | `PROTOCOL_PACKAGE_VERSION = 0.1.9`、`package.json` 0.1.9 | 版本同步 |
| 12 | `registerSchemaCompiler(fn)`（`plugin/manifest.ts` 导出） | 工具 schema 编译器的注册口。`validate.ts` 加载时自动注册 `compileSchema`；只走 `./constants` 子路径（不含 ajv）时不注册，`checkPluginManifestIssues` 跳过"工具 schema 可编译"一项，其余检查照常 |
| 13 | `findPromiseLanguage` 的否定放行 | 命中片段紧邻否定词不算承诺：中文看命中前 1–2 字是否为 不 / 非 / 没 / 无法 / 并非 / 不是；英文看前一个词是否为 not / no / never / cannot / can't / isn't / aren't / doesn't / don't / won't / without。"无风险"这类词本身仍是承诺，前面带否定才放行 |
| 14 | `compileSchema` 拒绝异步 schema | schema 树任意层级出现 `$async`（或编译出的校验器是异步的）抛 `Error('async schemas are not supported')`；清单检查据此对 `tools[].input / output` 报 `TOOL_SCHEMA_INVALID`。异步校验器返回 Promise，会绕过校验并让未处理的拒绝拖垮内核 |
| 15 | `plugin/safe-pattern.ts`：`patternRisk(pattern)`、`findUnsafePatterns(schema)`、`MAX_PATTERN_LENGTH = 256`、`MAX_TOOL_SCHEMA_BYTES = 64 KB` | 工具 schema 的回溯防护。`pattern` / `patternProperties` 键：长度 > 256、含回溯引用、或"重复量词作用在本身含重复量词或分支的分组上"（如 `(a+)+`、`(a\|aa)+`）一律拒；`?` 与 `{0,1}` 不算重复，`^[0-9]+(\.[0-9]+)?$`、`(?:ab)+` 放行。单个 input / output 序列化 > 64 KB 也拒。都报 `TOOL_SCHEMA_INVALID`，message 形如 `pattern "…" is rejected: quantifier over a group that contains a quantifier or alternation can backtrack catastrophically; rewrite without nested quantifiers (e.g. ^[a-z-]+$ instead of ^[a-z]+(-[a-z]+)*$)`（含改写示例；宁可误杀） |
| 16 | `findPromiseLanguage` 匹配前归一化 | NFKC；去零宽字符（U+200B–U+200D、U+FEFF、U+00AD）；连续空白折成一个，CJK 字符两侧的空白去掉（拉丁词之间保留一个空格，让否定词判断和 `sure win` 的词界成立）；连字符变体（U+2010–2015、U+2212、U+FE63、U+FF0D）统一成 `-`；小写；词表用到的少数繁体字转简体。返回的仍是原文片段。词表新增 `cannot lose`、`can not lose`、`never lose`，`risk-free` 允许写成 `riskfree`，`sure win` 加词界 |

**K（内核）需跟改**：清单扫描改用 `checkPluginManifestIssues` / `checkPluginCompat`；既有测试夹具的 `vendor.id` 要与 `id` 第二段一致（否则 `VENDOR_ID_MISMATCH`）；`PluginRecord.issues` 取 `[CODE] message`。

## v0.1.8 · 2026-10-10

依据：C 在 `VenueConnector` 之外加的两个可选方法，模拟场所靠它零 REST 撮合。全部可选，旧连接器 / 旧能力声明照样通过。

| # | 位置 | 追加 |
|---|---|---|
| 1 | `VenueCapabilities.bookSnapshot?: {snapshot, refresh, staleAfterMs?}`（schema 已同步，示例已更新） | **能力位**：`snapshot = true` 表示连接器实现了 `bookSnapshot`；`refresh = true` 表示另实现了 `refreshBook`（`refresh` 只在 `snapshot` 为真时有意义）；`staleAfterMs` 供使用方预估陈旧阈值。`supportsBookSnapshot(caps)` 给出 `{snapshot, refresh}`。**C 需跟改**：`HyperliquidConnector.describe()` 声明 `bookSnapshot: {snapshot: true, refresh: true, staleAfterMs: <bookStaleMs>}` |
| 2 | `VenueConnector` 可选方法 | `bookSnapshot?(id): BookSnapshot \| undefined`（本地 L2 快照，**同步、不联网**，没有快照返回 `undefined`）；`refreshBook?(id, opts?: {maxWaitMs?}): Promise<BookSnapshot \| undefined>`（快照缺失 / 陈旧时的有界、限频兜底；失败或被限频时原样返回现有快照，**不抛错、不排队阻塞**，是否拒绝由调用方决定）。`BookSnapshot = {book, asOf, stale}`（类型 + schema `model:0.1:BookSnapshot` + `validateBookSnapshot`）。使用方（模拟场所）约定：快照 `stale` 或缺失时先 `refreshBook`，仍 `stale` / 缺失就拒绝撮合，**不拿旧盘口成交**；连接器没有这两个方法（回放夹具）就退回 `await book()`。**venue-paper 需跟改**：`types.ts` 里本地定义的 `BookSnapshot` / `PaperMarket` 的两个可选方法可改为直接引用协议类型 |

## v0.1.7 · 2026-10-10

依据：C 把账户快照改成 WS 用户流增量维护后，在本地给连接器 `AccountSnapshot` 追加了三个字段（原 `TODO(protocol)`）。全部可选，旧数据照样通过。

| # | 位置 | 追加 |
|---|---|---|
| 1 | `connector.AccountSnapshot`（子路径 `@gitrader/protocol/connector`；schema `model:0.1:ConnectorAccountSnapshot`，`validateConnectorAccountSnapshot`） | `asOf?: Ms`（数据最后一次被场所确认 / 更新的时刻；账户没动静时 WS 不推，所以可以比 now 老很多，可信度看 `stale`，不看 asOf 与 now 的差）；`stale?: boolean`（true = 现在不能当实时数据用：WS 断了且 REST 兜底也过期，或还没拿到首批快照；风控闸遇到 stale 快照按 failClosed 处理）；`source?: 'ws' \| 'rest' \| 'replay' \| 'fixture'`（`ACCOUNT_SNAPSHOT_SOURCES`）。C 的实现里 `source` 目前只用 ws / rest，`replay` / `fixture` 留给回放与夹具。**C 需跟改**：`connector-hyperliquid/src/account.ts` 的 `CachedAccountSnapshot` 可直接改用协议的 `AccountSnapshot`（三个字段已在其中），`AccountView.source` 的类型换成 `AccountSnapshotSource`。GEP 的同名 `AccountSnapshot`（`attestation` 那个）不变 |

## v0.1.6 · 2026-10-10

依据：G 交付后的三项（主会话裁决）。其中 #1 **改了 v0.1.1 起的块清单形状（破坏性，仅限 `gitrader-block/1` 草案内）**。

| # | 位置 | 变更 |
|---|---|---|
| 1 | `BlockManifest`（`gitrader-block/1`） | **裁决：`vendor` 为对象 `{name, url?}`；`license` 为 SPDX 字符串（如 `"Apache-2.0"`）；`fixtures` 为数组（至少一个路径）**。原协议要求 `vendor = {id, name, kind, verified}`、`license = {spdx}`，F 的 SDK 与 G 的块用字符串。块 id 已含 vendor 段，完整 vendor 信息在插件清单里。schema、类型、手写示例已同步。**F 需跟改**：`blocks-sdk/src/manifest.ts` 的 `vendor: string` 改为 `{name, url?}`，`fixtures: string` 改为 `string[]`，并改为 re-export `@gitrader/protocol` 的 `BlockManifest`（其 `license` 已是字符串，不用改）；**G 需跟改**：`blocks-default` / `plugin-template` 里各块清单的 `vendor` 字符串改成 `{name, url?}`，`fixtures` 写成数组。契约 §4.1 的 `fixtures` 本就是"离线事件回放文件"，未限定类型 |
| 2 | 浏览器安全子路径 | 新增 `@gitrader/protocol/constants`（全部常量与纯函数，**不含 ajv 校验器**；根入口 `.` 仍带校验器）与 `@gitrader/protocol/types`（`export type *`，编译后为空模块）。另有既有的 `/decimal`、`/connector`。已用 esbuild 浏览器目标打包核对：constants / types 产物不含 `ajv`，不依赖任何 `node:` 模块。块与壳在浏览器里取常量或类型一律走这两条子路径；需要运行时校验才走根入口 |
| 3 | `risk.state` / `account.summary` 载荷 | 新增载荷类型与 schema（`ui:0.1:*`，`validateRiskStateSnapshot` / `validateAccountSummary`）：`RiskStateSnapshot = {tradingState, reasons?, policyVersion?, denyLlmLiveEntries?, usage?: RiskUsageItem[]}`，**`usage[] = {key, used, limit, unit, ratio?, scope?, window?}`**（每项限额已用 / 上限，十进制字符串，`key` 取 `RISK_USAGE_KEYS` 或 `x-` 扩展）；`AccountSummary = {accountId, ts, equity, available, positions?, openOrders?, dayStartEquity?}`，**`dayStartEquity`** 是当日基线权益（`dailyResetAt` 时点），块算当日盈亏用。内核可以多给字段，块只依赖这里列的；`UiQueries` 里补了 `risk.state`、`account.summary`。**B 需跟改**：`risk.state` 查询补 `usage`，`account.summary` 补 `dayStartEquity` |

## v0.1.5 · 2026-10-10

依据：D 交付 engine-core 后留下的七项约定（先在引擎里实现，这里定稿）。保持与 D 现状兼容（一致性 stdio 31/0、ws 33/0），旧字段与既有测试不动，只有 `HOST_METHOD_NAMES` 的计数断言 17 -> 18（新增 `host.proposal.create`）。

| # | 位置 | 定稿 |
|---|---|---|
| 1 | `market` 流事件 | 宿主 -> 引擎：`type = market.candle`，`data = {interval, candle, closed?}`（`MarketCandleData`）；批量为 `market.candles`，`data = {interval, candles[], closed?}`。**标的在事件信封的 `instrumentId`，不在 data 里**（一致性套件的假宿主已改）。`closed = true` 才触发评估，形成中 K 线的更新只更新 |
| 2 | `strategy.start` | 追加可选 `sizing?: Partial<StrategySizing>` = `{allocRatio (0,1], allocCapNotional >0, leverage [1,50], maxSlippageBps, minStepNotional}`（number，分析级）。只决定引擎想要多大，宿主风控闸与授权书额度仍是上限 |
| 3 | `host.order.place` | 追加可选 `origin?: {tool, causation?, ...}`（`OriginHint`）。宿主**必须覆盖** `actor / actorType / via / requestId`，只采信 `tool` 与 `causation`，多发的字段忽略不报错（契约 §1.6 行为人不能自报）。T26 现在接受 `instanceId` 参数或 `origin.causation.instanceId` |
| 4 | 扩展方法与提案 | ① `x-gitrader.workflow.{nodes,blank,validate,run,values}`（能力位 `x-gitrader.workflow`）与 `x-gitrader.strategy.files`（能力位 `x-gitrader.strategy-folder`）登记为扩展方法约定（`X_GITRADER_METHODS`），未声明能力位调用回 5002；② **新增 `host.proposal.create`**（宿主方法，可选）：引擎主动提交提案，一定产生 pending 提案（预检 deny 则 denied），不直接下单；**`act.propose` -> `host.proposal.create`，`act.order` / `act.close` -> `host.order.place`**（后者授权书不够时宿主自动转提案：`status = denied`、问题码 2009 并带新票号）。`WORKFLOW_ACTION_HOST_METHOD` 记录这个对应。**kernel / MCP 需实现 `host.proposal.create`** |
| 5 | `BacktestSpec.data.files[].format` | 追加 `json`（原 `parquet / csv`） |
| 6 | `seed` 例外 | S1 的秘密字段规则对 `seed` 的唯一例外收窄为：路径形如 `...spec.seed` 且值为 number。别处的 `seed`（含 number）一律拒收 |
| 7 | 事件确认 | 规范名统一为 **`host.events.ack`**（通知 `{upToSeq}`），两个方向都用；契约 §2.4 引擎一侧的 `events.ack` 成为**已弃用别名**，两端必须继续接受、不应再发（`GEP_DEPRECATED_METHOD_ALIASES`）。假宿主、文档、schema 已一致 |

另：`conformance/self.test.ts` 在设了 `GEP_LAUNCH` 或 `GEP_ENDPOINT` 时整个文件自动跳过（自检针对假引擎，不适用于真引擎）。

## v0.1.4 · 2026-10-10

依据：B 交付后的三项（主会话转述）。可选字段追加，旧字段与既有测试不动。

| # | 位置 | 变更 |
|---|---|---|
| 1 | `RiskLimits`、`MandateLimits` | 追加可选 `maxDailyOrders`（单日下单笔数，正整数）、`maxCancelsPerMinute`（每分钟撤单次数，正整数）、`duplicateIntentWindowSec`（重复意图窗口，秒，≥ 0，0 = 关闭去重）。与 `maxOrdersPerMinute` 同属交易速率预算，不是 Agent 步数闸；两处并存时取最严 |
| 2 | **契约勘误：HALTED 状态** | 契约 §1.4.10 写"HALTED = 只撤单与查询"。**更正（维护者 不变量，B 已按此实现）：HALTED 允许撤单和仅减仓的平仓单**（停机不能让人平不掉仓），仍禁止一切增加敞口的单。`TRADING_STATE_ALLOWS` 给出三态的允许表。契约 §1.4.10 状态表与 §5.6 的"完成后进入 HALTED（只撤单）"措辞待主会话同步 |
| 3 | 心跳与看门狗（澄清，无字段变更） | 心跳超时维持契约语义：授权书降级 + `halt_new`（进 `REDUCING`）。场所级 `scheduleCancel`（`VenueCapabilities.deadman`）作为**实盘挂单期间常驻的看门狗**，由内核定期续期，**不依赖 HALTED**——内核进程死亡时场所在 delaySec 内撤掉全部挂单，持仓不动 |
| 4 | 构建 `scripts/build.mjs` | ESM 产物加 `createRequire` banner，解决被打包的 CJS 依赖（ws）里的 `require('events')`；已确认 `gitrader` CLI（内含 kernel）打成单文件 `packages/cli/dist/bin.js`（约 1.6 MB），在隔离 `GITRADER_HOME`、离线模式（`GITRADER_OFFLINE=1`）、端口 47955 下跑通 `init / serve / status / ledger verify`，收尾只按自己的 PID 结束进程 |

## v0.1.3 · 2026-10-10

依据：主会话裁决（合伙人引擎的四个缺口按 OPEN-QUESTIONS 的建议追加）。**全部是可选字段 / 枚举追加，旧字段与既有测试不动。**

| # | 位置 | 追加 |
|---|---|---|
| 1 | 子仓位 / 多出场计划 | `OrderIntent`、`Order`：`legId?`、`exitPlanId?`、`ocoGroupId?`；`Fill`：`legId?`、`exitPlanId?`（继承自订单）；`Position.legs?: [{legId, exitPlanId?, size, entryPrice?}]`（归因视图，size 之和须等于 `Position.size`，可作为 reconciliation 的一项；场所真实持仓仍是聚合的）；`Origin.causation.legId? / exitPlanId?` |
| 2 | 实验阶段 | `EXPERIMENT_STAGES` 追加 `hypothesis`、`holdout`、`shadow`、`live`、`retired`（原六个值不动；"小额实盘"沿用既有 `live_small`，没有另加连字符写法） |
| 3 | 训练事件与模型版本 | `DecisionRecord.modelVersion?`；账本类型追加 `model.trained`（新组 `training`），payload 形状 `ModelTrainedPayload`：`{modelId, modelVersion, modelSha256, trainWindow, labelMaturityMs, sampleCount, metrics?}`，训练只用 `ts + labelMaturityMs ≤ trainWindow.to` 的样本 |
| 4 | 交易时段与点差 | `Instrument.sessions?: {tz, windows: [{days, from, to, quality: regular\|thin\|closed, typicalSpreadBps?}]}`、`Instrument.typicalSpreadBps?` |
| 5 | 亏损分解 | `Experiment.metrics.{backtest\|paper\|live}.lossAttribution?`：`{totalLoss, earlyExit, lateExit, violation, overtrading, residual, method, basis{fromSeq,toSeq}}`，十进制字符串，各项之和须等于 `totalLoss`（`validateLossAttribution` 精确检查）。不进账本头部 |
| 6 | 产品裁决写入注释 | LLM 型钥匙的"限额自动"档 = 纸面自动 + 实盘仅减仓与撤单自动，实盘开仓仍走"需确认"；人在人面 + PIN 下显式关闭 `denyLlmLiveEntries` 后才包含实盘开仓；引擎型执行者（`actorType = engine`）不受该开关影响（类型注释，无行为变化） |

### v0.1.3 · 追加（C / F 交付后并入）

| # | 位置 | 变更 |
|---|---|---|
| 7 | 连接器接口 `src/connector/*`（子路径 `@gitrader/protocol/connector`，根入口命名空间 `connector`） | 以 C 的 `connector-hyperliquid/src/types.ts` 为底稿原样收入（与 C 现有类型**双向可赋值**，已用编译器核对）：`VenueConnector`（行情 / 账户 / 交易 / 启动对账 / `scheduleCancel` / 可选 `armDeadman`）、`SignerHandle`（`signTypedData` 形状）、`SignedEvent`、`AccountRef`、`TradeContext`、`OrderAck`、`SubmitResult`、`CancelTarget / CancelAck`、`AmendRequest`、`VenueFill`、`AccountSnapshot`、`VenueOpenOrder`、`StartupSnapshot`、`VenueOrderStatus`、`SubscriptionSpec / VenueEvent`、`MarketStatus`、`RateBudget / BudgetUsage`（速率预算对象）、`DeadmanHandle`、`CandleRecorder`；`supportsScheduleCancel(caps)` = 能力位 `VenueCapabilities.deadman.method === "schedule_cancel"`。**差异**：连接器的 `AccountSnapshot` 与 GEP 的同名但形状不同（无 `openOrders / attestation`、带 `accountModel`），所以根入口只以 `connector.AccountSnapshot` 暴露；要原名走子路径。契约 §3.6 只给方法名，这里是进程内形状，GSP 只是把它搬到 JSON-RPC |
| 8 | 十进制算术 `src/decimal.ts`（子路径 `@gitrader/protocol/decimal`，根入口命名空间 `dec`） | 由 connector 与 venue-paper 两份同源 `dec.ts` 合并：导出名全部沿用（`fx / str / roundFx / mul / div / abs / min / max / ZERO / ONE_FX / fracDigits / intDigits / sigDigits / SCALE / Fx / RoundMode`），替换时只改 import 路径；新增 `add / sub / neg / cmp / sign`，以及字符串层 `addDec / subDec / mulDec / cmpDec / roundDec / floorToStep`（输入输出都是规范十进制字符串）。`div` 除零抛 `RangeError`（原实现是 BigInt 的 `RangeError`，行为一致）。精度：18 位定点，乘除超出的位向零截断 |
| 9 | UI 线格式 `src/ui/wire.ts` + schema `ui:0.1:*` | 壳 ↔ 内核：`POST /api/session {bootstrap} → {sessionToken, user, ws?}`；`ws://…/ui`，JSON-RPC 2.0，首帧 `auth`（5 s 内），方法 `auth / subscribe / unsubscribe / query / command`，通知 `event`；`command` 带 `origin{tool, via:"ui"}`（actor / actorType / requestId 由内核盖章）与可选 `attestation`（`PresenceProof`，PIN 6–12 位数字）；查询 / 命令名：`settings.get`、`settings.network.set`、`settings.agent_layout.set`、`pin.set`、`credential.import / generate / revoke`、`takeover.<level>`、`trading_state.resume`、`workspace.*`、`instruments.search`。新增错误码 **1010 `ATTESTATION_REQUIRED`**（REJECTED；契约 §2.8 码表没有它）；错误的 PIN 回 `AUTH_FAILED`（5003） |

**UI 线格式与契约 / 现有实现的差异**（冲突处以契约为准；契约没写的以 F 的实现为准）：

- 契约 §4.2 的 `bridge.*` 是**块 ↔ 壳**一跳，壳 ↔ 内核契约没写，不冲突；沿用 F 的方法名。
- 契约 §5.1 的 `attestation`（`{method, by, at, digest, sig}`）是内核**存档**的签名文档；线上请求侧是 `PresenceProof`（只有 `method` + `pin` / `assertion`）。内核校验后自己生成存档的 attestation（`session` / `system` 方法用本机安装密钥签）。
- 契约 §5.1 说"导入凭据"会话即可（不要 PIN），F 沿用（`credential.import`）；B 现有实现是 `wallet.import` + `presence: pin`。**以契约为准：会话即可**。`params.secret` 是私钥明文，是 S1 秘密字段规则的唯一豁免（`UI_SECRET_FIELD_EXEMPT`），且永不入账本 / 日志。
- 契约 §5.6 恢复 ACTIVE 要在场证明——一致；§5.1「收紧风控」会话即可——一致。
- **B 现有实现与本线格式不一致，需 B 改**：B 的 WS 路径是 `/ws`、帧是 `{t:"hello"|"subscribe"|…}` 自定义形状（`gitrader-bridge/1`），换票请求体字段是 `boot`、PIN 走 `X-Gitrader-PIN` 头 / `pin` 字段、设置 PIN 叫 `pin.setup`、钥匙叫 `wallet.*`、HTTP 面是 `/api/op/<name>`。按本协议：路径 `/ui`、JSON-RPC 帧、字段 `bootstrap`、`attestation: {method:"pin", pin}`、`pin.set`、`credential.*`。B 的 HTTP `/api/op/<name>`（给 E 的 Agent 面 / CLI 用）不在本线格式范围内，可保留。
- F 的 `takeover.<level>` 命令 `scope: {type: "org"}` 不带 `id`；协议允许 `id` 缺省，缺省 = 本机默认组织 `org_local`。

新 schema：`LossAttribution`、`ExperimentMetrics`、`ModelTrainedPayload`；新校验器：`validateLossAttribution`、`validateModelTrainedPayload`。

## v0.1.2 · 2026-10-10

依据：主会话转述的 维护者 三条决定（授权在 `packages/protocol` 落码，契约文档由主会话之后同步）。

### 追加（旧字段不动）

| # | 位置 | 变更 |
|---|---|---|
| 1 | GEP 传输 | 传输固定三种：本地 `stdio`（任意语言子进程）、本地 `ws`（仅 loopback）、远程 `wss`（必须令牌或 mTLS）。`GEP_TRANSPORTS = [stdio, ws, wss]`；`EngineDescribe.protocol.transports`、插件清单 `engine.gep.transports`、`entry.transport` 的枚举加入 `wss` |
| 2 | 引擎启动配置 | 新增语言无关的 `EngineLaunch`：本地 `{command, args?, env?, cwd?}`，远程 `{url, auth}`；`auth` 为 `{method:"token", tokenRef}` 或 `{method:"mtls", clientCertRef, caCertRef?}`（配置里只放句柄，不放明文）。新增 schema `gep:EngineLaunch`、`validateEngineLaunch()`、`checkEngineLaunch()`（非 loopback 必须 wss、令牌不许放 URL、必须有认证）；插件清单 `engine.launch` 可选 |
| 3 | `gep.hello` | `auth` 在 `token` 之外可声明 `mtls: true`；二者至少一个 |
| 4 | 插件清单 `runtime.type` | 追加枚举值 `sidecar`（任意语言的子进程）；`python-sidecar` 保留。`runtime.python` 仍是可选便利，只对 Python 旁车有意义；清单里没有任何必填项含 python。GSP 同样语言无关 |
| 5 | `Origin.actorType` | **新增必填字段**，枚举 `human / engine / llm-agent / system`；由内核盖章；与 `actor` 前缀必须一致（`user→human`、`agent→llm-agent`、`engine / workflow / strategy / plugin→engine`、`system / venue / mandate→system`），schema 强制。账本条目的 `origin` 带它，界面可一键筛 `llm-agent`。`deriveOriginActorType()` 给出映射 |
| 6 | `RiskPolicy.denyLlmLiveEntries`、`Mandate.denyLlmLiveEntries` | 新增布尔字段，**缺省 = true（默认开启）**：`actorType = llm-agent` 的实盘开仓一律拒绝；减仓、撤单、提案、纸面 / 影子单不受限；经人批准的提案执行不受限。两处与适用作用域取最严（`effectiveDenyLlmLiveEntries()`：只有全部显式 false 才放行）。人有意关闭属放宽类动作，须在场证明（`HUMAN_ONLY_ACTIONS` 新增 `policy.allow_llm_live_entries`） |
| 7 | `RuleHit.code` | 追加 `LLM_LIVE_ENTRY`（`isLlmLiveEntryDenied()`、`llmLiveEntryRuleHit()`） |
| 8 | MCP 工具描述 | `order` 的描述写明"LLM 实盘开仓默认被策略拒绝"；`ledger` 的 `filter` 提示可按 `origin.actorType` 过滤 |

### 许可证（维护者 定稿：完全开源、完全免费）

- 根 `LICENSE` 改为 Apache-2.0 原文；删除 `LICENSES/` 与全部旧的分层许可文本；`NOTICE` 重写。
- 所有包 `package.json` 的 `license` 统一 `Apache-2.0`，各包目录内的 `LICENSE` 同步；各包 README 首行同步；`package.json` 里的 `gitrader.layer` 删除。
- 根 README 的三层表换成一句"Apache-2.0，完全开源免费"；`CONTRIBUTING.md` 的贡献协议由 CLA 改为 DCO（`Signed-off-by`）。
- JSON Schema 的 `$comment` 去掉 `Gitrader-Layer` 标记（`workflow.json` 是契约 §5.9 原文，只改了这一处标记）；夹具 `engine-describe.json`、`BlockManifest` 样例里的许可证值随之改为 `Apache-2.0`。
- 其他包（kernel / engine-core / connector / venue-paper / workbench 等）源码文件头已统一为 `SPDX-License-Identifier: Apache-2.0`（开源卫生复验已核对）。
- 契约 §0.3 的三层表、§7.5 的旧许可标识待核、DCO / CLA 分层、"许可边界 CI 检查"等条目作废（见 OPEN-QUESTIONS）。

### 其他（落码中的澄清，非契约变更）

- `findSecretFields()`：值为 number 的 `seed` 不算秘密字段（`BacktestSpec.seed` 是随机种子；契约 S1 的 `seed` 指助记词种子，二者撞名，见 OPEN-QUESTIONS）。
- 校验器 `strictRequired` 关闭（条件必填写在 `if/then` 里）。

## v0.1.1 · 2026-10-10（初始落码）

按契约 v0.1.1 转写：

- 统一交易模型（§1）：`Decimal` 品牌类型与规范形、Org / AccountGroup / Account / Instrument / VenueCapabilities / SimVenueDeclaration / OrderIntent / Order / Fill / Position / FundingPayment / Balance / MarginSnapshot / RiskPolicy / Protector / TradingState / PrecheckResult / Signal / Experiment / DecisionRecord / Origin / Problem / RuleHit，及一一对应的 JSON Schema（draft 2020-12）与 `validateX()`。
- GEP（§2）：方法名与参数 / 返回类型（引擎 32 个、宿主 17 个、通知 5 个）、事件信封与 14 个流、错误码表、`engine.describe`、能力位、Binding（模式 A / B）、版本协商、`GepClient` / `GepServer` 类型级接口、JSON-RPC 信封、秘密字段拒收。
- 插件清单 `gitrader-plugin/1`（§3.1–3.4）、权限枚举与永不可授予清单、GSP 方法名与签名请求类型。
- 块清单 `gitrader-block/1`、块桥、联动组、工作区 `gitrader-workspace/1`、布局 API（§4）。
- Agent 接口（§5）：AgentKey、Mandate（对外四档 ↔ 内部五级、晋级门槛）、Proposal 状态机与转移表、`confirmToken`、接管三档、人面专属动作表。
- MCP 工具清单（17 个；分组、描述、入参 schema、按级别加载、预算、74 → 17 映射）。
- 账本 `gitrader-ledger/1`（§6）：条目、类型表、`canonicalize()`（RFC 8785）、哈希输入构造、创世哈希、测试向量。
- GEP 一致性套件（§2.11）：T01–T26 / A1–A3 / O1–O8 + B1–B5 登记，内存假引擎与 stdio 传输自测。

### 本包相对契约文字新增的字段 / 结构（A 追加，请主会话确认）

| 位置 | 追加内容 | 原因 |
|---|---|---|
| `VenueCapabilities.venue`（必填） | 场所 id | `host.describe.venues[]` 需要区分各场所，§1.5.1 的键表没有 |
| `VenueCapabilities.marketEmulation` | 与 `orderTypes` 同级 | §1.5.1 只写"`orderTypes.market = emulated` + `marketEmulation`"，位置未定 |
| `BindingAccount.signer` | `{address?, fingerprint?}`，模式 B 必填 | §2.6 要求模式 B 声明签名者，未给字段名 |
| `ControlIntent` | `{controlKind, params}`，`controlKind` ∈ start_strategy / run_workflow / request_promotion / install_plugin | §5.4 只列了用途 |
| `StrategyInstance` / `ReplayState` | 实例状态与回放状态的字段 | §2.4 只给方法 |
| `Quote` / `Trade` / `VenueStatus` | 行情类最小字段 | §7.3 只列了名字 |
| 宿主 → 引擎的行情事件 | `stream = market`，`type = market.candle`，`data = {instrumentId, interval, candle}` | §2.5 流表只写"行情" |
| 引擎 → 宿主的实例事件 | `strategy.started / stopped`；事件 `type` 第一段必须等于 `stream` | §2.5 未枚举 |
| 3006 的交付形式 | `OrderResult{status: submitted, problem: 3006}`，不是 JSON-RPC 错误 | 契约只说"返回 3006" |
| `TradingScope`、`RiskPreset` schema、`PrecheckEstimates` | 独立 schema | 便于复用 |

## B3-08A: execution reconciliation read models

- Add the execution reconciliation account, finding, evidence, suggestion, and confirmation input/result types; add optional inferred-confirmation provenance to Fill and optional avgFillPrice to connector VenueOrderStatus. Existing venue fills and older payloads remain valid; no problem codes are added.

## B3-04: operation rate and WebSocket subscription limits

- Add OperationRateLimitConfig and ServerSecurityConfig protocol types for authenticated operation budgets and bounded WebSocket subscriptions. Defaults and range validation are enforced by the kernel; no problem codes are added.

## B3-06B: historical replay provenance

- Add the PaperReplayProvenance model and optional provenance on PaperReplayStatus to identify fixture-bound historical results.

## B3-06B lifecycle durability

- Persist the single-run claim and latest replay status in the internal paper-replay-run document; restore terminal status after restart and show interrupted active status as failed without resuming it. Capture exported paper state, close the driver, then persist the final summary so export or close failures cannot produce a completed artifact. No public shape or problem code is added.

## B3-08C-TX: confirmed inferred-fill transaction receipts

- Add required offerId to ReconcileConfirmInput and optional offerId to ReconcileAccountView. Add ReconcileConfirmationReceipt with input, fillId, confirmedAt, confirmedBy, and effectsState. No new problem code is added.

## B3-08C1: late real fill evidence

- Record a late non-inferred fill after a human-confirmed inferred fill as a local, append-only evidence document with a per-account pending marker. Reuse existing Fill and boolean schemas; normalize safe economic identity for deduplication and do not persist raw venue payloads or credentials.
- Require human review and block further confirmation while late real evidence is pending. No automatic compensation or clearing is performed; no public protocol shape or problem code is added.

## R6-C: research jobs (x-gitrader.research.*) and the `research` MCP tool

- Add the 18th MCP tool `research` (group P, read-only hint, nine actions: optimize, walk_forward, factor_report, backtest_report, portfolio, search, status, result, cancel) and raise `MCP_BUDGET` to toolCount 18 / defaultLoadL0 14 / defaultLoadL1Plus 17. Existing tool definitions are unchanged.
- Append the engine extension methods `x-gitrader.research.run|status|result|cancel` with capability `x-gitrader.research`, plus `RESEARCH_LIMITS` (500 trials, 8,000-byte summary, paged detail) and the wire types. `X_GITRADER_METHODS` is untouched. No problem code is added.
