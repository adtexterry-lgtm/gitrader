<!-- SPDX-License-Identifier: CPAL-1.0 -->
# 风控闸门协议 `gitrader-risk-gate/1`（r1.2 · 施工版）

> 状态：施工版（2026-10-14）。两轮对抗审稿（41 条 + 17 条）后定稿，记录在内部目录 `reports/risk-gate-r1/`。本版把范围切成 **r1（本轮施工）** 与 **r1.2（下一轮）**，见 §15。实现落点：`packages/protocol`（类型、问题码、规范化、一致性夹具）、`packages/kernel`（闸门引擎、票据、预留、断电器、回放）、连接器（标记价、新鲜度、场所硬规则、到期透传）。
> 一句话：**每一次向场所提交会改变账户的动作，都恰好经过一次同一个纯函数的判定；判定带着它看到的全部输入一起签名入账、可回放可验证；执行侧只认判定签发的票据。** 判定只有三种：`ALLOW`（原样放行）、`LIMIT`（收紧后放行）、`BLOCK`（不放行）。

## 0. 与 M1 的关系：追加，不重写

M1 已有：`RiskGate.precheck()`（限额 / 白名单 / 授权书 / LLM 实盘开仓拒绝 / 陈旧价 / 速率 / 冷却，输出 `PrecheckResult{verdict: allow|deny|review, ruleHits[], estimates}`）、带签名与版本链的 `RiskPolicy`、三态 `ACTIVE / REDUCING / HALTED` 与接管 / 杀开关 / 死人开关、后置保护器、提案与票号、确认令牌、账本 `risk.precheck / risk.denied / order.intent`。

本协议**不改这些的语义**（旧字段、旧码、旧条目类型原样），只做五件事：

1. 判定收口为三值 `decision: ALLOW | LIMIT | BLOCK`，旧 `verdict` 保留并给出固定映射（§3.2）。
2. 每次判定附带**签名快照**：判定看到的全部输入的规范哈希 + 安装密钥签名，入账可回放、可验证（§3.4、§6）。
3. 执行侧只认**闸门票据**：连接器总线的每个写方法入口核验并作废票据；没有票据的动作不签、不发（§5）。
4. **规则插件化**：保护器增加预检接口；第三方保护器 r1 只接受声明式模板（零代码），代码型放 r1.2；两种都不进内核线程（§3.8）。
5. 补齐 G3 情报的硬条款：锁存式第 0 层断电器（含文件形态、撤单保留止损）、固定评估顺序 + 全量评估 + fail-closed 只拦开仓、购买力与敞口按**预留**计入在途量与挂单、授权书纵深防御、`enforce | monitor` 灰度、标记价、场所硬规则由连接器动态声明。

修订脉络：r1 → r1.1 按首轮 41 条修（断电器锁存、保护器不进内核线程、fail-closed 只拦开仓、下行通道全覆盖、判定绑定意图、RFC 8785、预留生命周期、两段跑法等）；r1.1 → r1.2 按复核 17 条修：降风险动作不受速率限制（N1）、断电器撤单保留止损（N2）、非下单动作的载荷形状（N3）、死人开关列与续期（N4）、撤止损 / 改单按发起人区分且只把止损算保护单（N5）、挂单名义计入敞口（N6）、两种 `available` 语义的预留公式（N7）、结果未知订单按到期释放（N8）、两段跑法定义为单次可复现语义（N9）、声明式模板并入策略的主键 / 卸载 / 来源规则（N10）、输入表补 `precheckId` / `dryRun`（N11）、小数写法（N12）、收紧后的动作类别（N13）、`asOf` 语义（N14）、「不联网」措辞（N16）、附带止盈止损与批量（N17）、签名器只能做作用域绑定（§5.4）、范围切分（§15）。

## 1. 红线映射

| 红线 | 本协议怎么满足 | 章节 |
|---|---|---|
| 1 一切皆插件 | 内核只保留闸门引擎、内置数字限额与内置保护器；其余规则以 `protector` 插件提供：r1 声明式模板零代码，r1.2 代码型走插件协议既有的子进程隔离 | §3.8 |
| 2 用户拥有第一性 | 风控策略只能本机 PIN 改（放宽须强在场证明，M1）；策略、判定、快照全部留在本机账本；签名用本机安装密钥；策略可导出只读；保护器插件拿不到内核进程的文件（不联网是清单声明，靠签名与来源审查，不是运行时强制） | §3.6 §6 §3.8 |
| 3 模型不碰钱 | 唯一下行通道：连接器总线每个写方法都要票据，没有票据不签不发；Agent 工具 schema 不得含任何风控字段；`deny` 类 `BLOCK` 终局，`review` 类只能经提案由人批准后**重新判定**；LLM 来源的实盘开仓默认拒绝（M1）；断电器一旦触发只有人能解除 | §5 §4 §7 |
| 4 前向才作数 | 每次执行路径上的判定（含 `ALLOW`）入账，带快照哈希、意图哈希、策略版本哈希、签名；回放必须复现；拦截统计只算执行路径上 `deny` 类且按订单去重，转人批单列 | §6 |
| 5 零承诺语言 | `ALLOW` 的口径固定为「没有违反你写的规则」，不表示安全或盈利；判定对象、工具说明、界面文案不出现「安全」一类字眼与契约附录 B 的对外禁用词 | §10 |

## 2. 术语与动作类别

- **闸门（gate）**：纯函数 `decide(GateInput) → GateDecision`。同输入必得同输出；不读时钟、不做 I/O、不跨线程、不调用模型。耗时在函数外量。
- **组装（assemble）**：内核在调用 `decide()` 前准备 `GateInput` 的过程，可以有 I/O。
- **快照（snapshot）**：`GateInput` 去掉 `target` 后的规范化 JSON，哈希写进判定。
- **票据（ticket）**：判定为 `ALLOW | LIMIT` 时由内核签发、绑定调整后目标的哈希、绑定本次启动、30 秒有效、一次性的执行凭证。
- **断电器（kill switch）**：第 0 层，单标志覆盖一切；触发即**锁存**为粘性 `HALTED` 并执行停机动作；恢复必须人在场。
- **保护单（protective）**：**只**指止损单：`tpslRole = 'sl'`，或触发方向朝不利一侧的只减仓触发单。止盈不算保护单。
- **动作类别**（`GateAction`）：`open`（开仓 / 加仓 / 翻仓）、`reduce`（纯减仓，含 `reduceOnly` 与推断减仓；`closePosition` 不给数量时取持仓全量）、`cancel`（撤非保护单，含撤止盈）、`cancel_protective`（撤止损单，或 `cancelAll` 带 `keepProtective: false`）、`amend`（改单：按改后的订单重新归类为 `open` / `reduce`，并多做 §4.1 的 amend 规则）、`leverage`（单独改杠杆）、`deadman_arm`（死人开关布防 / 续期）、`deadman_disarm`（撤防）。
- **发起人**（`actorClass`）：`agent`（钥匙 / 引擎 / 插件）、`human`（人面会话或 PIN）、`system`（内核、接管、杀开关、死人开关）。

## 3. 对象定义（字段级）

数值一律十进制字符串（`Decimal`），时间一律整数毫秒（`Ms`）。所有新增字段、枚举值、码登记在 `packages/protocol/CHANGELOG.md`；JSON Schema 一律从常量生成，不手写枚举。

### 3.1 `GateInput`（判定输入）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `precheckId` | `PrecheckId` | 是 | 函数外生成，进摘要 |
| `dryRun` | `boolean` | 是 | 只预检：不入账、不出票、不占预留、不计熔断 |
| `action` | `GateAction` | 是 | 组装期确定；推断减仓在这里定型并写回 `reduceOnly: true`（§3.3） |
| `actorClass` | `'agent' \| 'human' \| 'system'` | 是 | 由已盖章的 origin 推出 |
| `originActorType` | `Origin['actorType']` | 是 | 已盖章 origin 的细类（`llm-agent` / `engine` / `plugin` / `user` / `system` …）；`LLM` 阶段只认 `llm-agent`，`actorClass` 不够细 |
| `target` | `GateTarget` | 是 | 联合类型：`{ kind: 'order'; intent: NormalizedIntent }` / `{ kind: 'cancel'; targets: { orderId; clientOrderId; tpslRole? }[] }` / `{ kind: 'cancel_all'; instrumentId?; keepProtective: boolean }` / `{ kind: 'leverage'; instrumentId; leverage; marginMode? }` / `{ kind: 'deadman'; atMs: Ms \| null }` |
| `originalTargetDigest` | `Sha256Digest` | 否 | 组装期改动过目标（剥掉减仓单的 `leverage`、写回 `reduceOnly`）时，记改动前的哈希 |
| `account` | `{ accountId, venue, mode: 'paper' \| 'live', groupIds: string[] }` | 是 | 账户身份，不含凭据 |
| `instrument` | `Instrument` | `order` / `leverage` 时必填 | 合约乘数、杠杆上限、费率、精度、最小名义 |
| `snapshot` | `GateAccountView` | 是 | 派生量：`equity`、`available`、`availableDeductsOpenOrders: boolean`、`positions[]`（标的、方向、数量、名义、杠杆）、`openOrders`（按标的、按方向的**非只减仓**挂单名义与笔数）、`stopLossOrderIds[]`、`asOf: Ms`（最后一次推送）、`confirmedAt?: Ms`（最后一次确认新鲜）、`stale: boolean`。**不含**挂单全表 |
| `mark` | `{ price: Decimal; ts: Ms; source: 'venue_mark' }` | 否 | 场所标记价；缺失或无效即 fail-closed；有效旧价仅可用于 human / system 严格减仓例外 |
| `last` | `{ price: Decimal; ts: Ms }` | 否 | 最近价，只用于估算展示 |
| `mandate` | `Mandate \| null` | 是 | **生效**授权书（验签失败或过期时内核合成的 L0 原样放进来） |
| `mandateIntegrity` | `{ ok: boolean; problems: string[] }` | 是 | |
| `policy` | `RiskPolicy \| null` | 是 | 入账时换成引用 |
| `policyIntegrity` | `{ ok: boolean; problems: string[] }` | 是 | |
| `path` | `'direct' \| 'proposal' \| 'approved'` | 是 | |
| `now` | `Ms` | 是 | 由内核传入 |
| `stats` | `PrecheckStats` | 是 | 日内统计（M1；`ordersLastMinute` / `ordersToday` 含预留里的在途笔数） |
| `rate` | `{ used, limit }` | 否 | 场所权重预算 |
| `reserved` | `ReservedView` | 是 | 进程内预留（§8）：`{ account: { margin: Decimal; notional: Decimal; count: number }; byInstrument: Record<InstrumentId, { long: { notional: Decimal; count: number }; short: { notional: Decimal; count: number } }>; today: { notional: Decimal; count: number }; lastMinute: { count: number } }`；没有预留时各项为 `"0"` / `0`，`byInstrument` 为空对象 |
| `states` | `StateReason[]` | 是 | org / group / account / instrument / mandate 作用域的状态与原因，含断电器锁存 |
| `killSwitch` | `{ tripped: boolean; source?: 'manual' \| 'file' \| 'deadman' \| 'auto'; reason?: string }` | 是 | §7 |
| `venueRules` | `VenueRules` | 否 | §3.9 |
| `protectorResults` | `ProtectorResult[]` | 是 | 代码型保护器结论（r1 恒为空数组；形状见 §3.8） |

### 3.2 `GateDecision`（判定输出）

`GateDecision extends PrecheckResult`，旧字段全部保留；新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `gate` | `{ schema: 'gitrader-risk-gate/1'; rulesetVersion: string }` | `rulesetVersion` = 内核版本 |
| `decision` | `'ALLOW' \| 'LIMIT' \| 'BLOCK'` | |
| `action` | `GateAction` | **调整后**的类别（翻仓收紧为减仓时填 `reduce`，r1.2） |
| `targetDigest` | `Sha256Digest` | 输入目标（含写回的 `reduceOnly`）的规范哈希 |
| `adjustedTargetDigest` | `Sha256Digest` | 调整后目标的哈希；`ALLOW` / `BLOCK` 时等于 `targetDigest` |
| `applied` | `GateAdjustment[]` | `LIMIT` 时包含真实调整；有效旧标记价下获准的纯减仓可附 `kind: 'warning'`，此警告不改变 `ALLOW` 判定 |
| `allowedActions` | `Record<GateAction, boolean>` | 该账户 / 标的此刻对**当前发起人类别**允许的动作表。**只由** `states`、`killSwitch`、授权书级别与 `actorClass` 推出（§4.1 表的 `SYS` / `KILL` / `STATE` / `MANDATE` 四行），不反映本次判定的其他命中（限额、保护器结论缺失等不改变它）；`amend` 取 `reduce` 的值（改单的真正判定按改后类别走） |
| `irreversibility` | `'high' \| 'low'` | `open` / `leverage` / `cancel_protective` / `deadman_disarm` / 改成 open 类的 `amend` = `high`；`reduce` / `cancel` / `deadman_arm` / 改成 reduce 类的 `amend` = `low` |
| `escalation` | `{ to: 'human_approval'; reason: RuleCode }` | 仅 `review` 类 `BLOCK`：可经提案由人批准，批准后**重新判定**；一般提案保存**调整后**目标，`REDUCE_ONLY_MISMATCH` 例外保存原 assembled target 供批准时复核，错配未消除则不执行 |
| `stages` | `GateStage[]` | 本动作类别应评估的阶段全部列出（全量评估）；代码型插件阶段按 §3.8 规则标 `'PROTECTOR:skipped'` |
| `monitorHits` | `RuleHit[]` | `monitor` 模式保护器的命中，`action: 'warn'`，不影响判定 |
| `snapshotDigest` | `Sha256Digest` | |
| `policyRef` | `{ policyId, version, digest } \| null` | |
| `mandateRef` | `{ mandateId, version, digest, effectiveLevel, effectiveStatus }` | 有授权书时填 |
| `dryRun` | `boolean` | |
| `attestation` | `Attestation`（`method: 'system'`，`by: 'kernel'`） | `digest` = 去掉 `attestation` 后的判定规范哈希（含 `precheckId`、两个目标哈希、`snapshotDigest`）；`sig` = 安装密钥签名 |

耗时不在判定对象里，由内核在函数外计量并写进账本条目的 `payload.timing`。

**与旧 `verdict` 的固定映射**：`ALLOW` ⇔ `verdict = allow` 且没有真实调整；`LIMIT` ⇔ `verdict = allow` 且至少有一项真实调整；`BLOCK` ⇔ `verdict ∈ {deny, review}`，`review` 必带 `escalation`。`warn` 不影响映射；旧标记价警告可作为 `applied` 的 `kind: 'warning'` 记录，不算真实调整；`monitor` 命中只进 `monitorHits`。

### 3.3 `GateAdjustment` 与 LIMIT 规则

| 字段 | 类型 | 说明 |
|---|---|---|
| `ruleId` | `string` | 与 `RuleHit.ruleId` 同体例 |
| `code` | `RuleCode` | 触发调整的规则码 |
| `field` | `'size' \| 'leverage' \| 'maxSlippageBps' \| 'reduceOnly' \| 'markPrice'` | r1 只实现 `size`；其余 r1.2；`markPrice` 只用于旧价警告 |
| `from` / `to` | `Decimal \| number \| boolean` | |
| `unit` | `string` | |
| `kind` | `'warning'` | 存在时表示不改变目标的规则警告，不作为 LIMIT 的真实调整 |

规则：
- 调整只在**策略允许**（`policy.limitMode[field] = true`）**且意图允许**（`intent.allowAdjust` 含该字段）时发生；任一不允许 → 按 `BLOCK`。两边都点头，取最严。
- **闭式求解，一次复核**：把全部线性约束（单笔名义、单标的比、总比、日名义、购买力、授权书额度）各自解出最大可行 `size`，取最小，按合约步长向下取整；得到调整后目标后**完整复核一遍**（含 `APPROVAL`）；复核仍不过 → `BLOCK`。没有第二轮。复核得到 `review` 时，提案里放调整后目标。
- 取整后低于场所最小名义 → `BLOCK`（`ORDER_NOTIONAL`）。
- **翻仓单**（反向且数量大于持仓）r1 一律按 `open` 评估、不收紧；r1.2 再做「收紧为纯减仓」。
- `reduce` 类不做任何数字调整。
- `SYS` 中有效但超过 `stalePriceMs` 的 `venue_mark`：human / system 的严格减仓记 `warn`，agent 减仓记 `review`；该旧价只供获准减仓估算与成交上下文使用，human 执行须 PIN。开仓与杠杆仍拒绝；缺价、非正数、非法来源或非法时间戳仍对所有订单拒绝。陈旧账户仍阻断，取消不依赖标记价。
- **推断减仓**：反向且数量 ≤ 持仓数量的意图在组装期定型为 `reduce`，并写回 `reduceOnly: true`（进 `targetDigest`；改前哈希记 `originalTargetDigest`）；不写回就按 `open` 评估。
- **减仓单夹带杠杆**：组装期剥掉 `leverage`、记 `warn`、改前哈希记 `originalTargetDigest`（账本能看出 Agent 要过多少倍）。想改杠杆走 `leverage` 动作。
- 调整项同时以 `RuleHit{ action: 'limit' }` 出现在 `ruleHits`（`RuleHit.action` 追加 `'limit'`，schema 从常量生成）。
- 订单记录、`clientOrderId` 摘要、账本载荷都用**调整后**目标；同一 `clientOrderId` 用原意图重试时按 `originalTargetDigest` 识别为幂等。

### 3.4 `GateSnapshot`、规范化与哈希（签名快照）

`GateSnapshot` = `GateInput` 去掉 `target`，并把 `policy` 换成引用 `{ policyId, version, digest }`；`mandate` 保留生效授权书全文（它是合成结果，取不回）。

规范化 = **RFC 8785（JCS）**，直接用协议包现有的 `canonicalize`：键按 UTF-16 码元序；`undefined` 非法——组装期必须先删掉值为 `undefined` 的属性再入哈希。数组排序键：`positions` 按 `instrumentId`；`openOrders` 按 `(instrumentId, side)`；`states` 按 `(scope.type, scope.id, state, protector ?? '', until ?? 0, reason)`；`protectorResults` 按 `(pluginId, order)`；`cancel.targets` 按 `orderId`。不得依赖 Map 或对象的插入顺序。

小数：加减乘精确；除法保留 18 位小数、向零舍入；`size` 向下取整到合约步长；比率类 `actual` 保留 8 位小数、向零舍入。**写法**：无指数、去尾零、零写 `"0"`、无正号、负数前置 `-`。

判定签名见 §3.2。回放时重算的判定去掉 `attestation` 后应与账本逐字节一致。

### 3.5 `GateTicket`（下行通道票据）

| 字段 | 类型 | 说明 |
|---|---|---|
| `ticketId` | `string` | `tk_` + ULID |
| `precheckId` | `PrecheckId` | |
| `bootId` | `string` | 本次内核启动 ID；重启后旧票一律无效 |
| `accountId` | `AccountId` | |
| `action` | `GateAction` | 调整后类别 |
| `targetDigest` | `Sha256Digest` | **调整后**目标的规范哈希 |
| `issuedAt` / `expiresAt` | `Ms` | `expiresAt − issuedAt ≤ 30 000` |
| `sig` | `string` | 安装密钥对上述字段规范 JSON 的签名 |

规则：
- 只有 `decision ∈ {ALLOW, LIMIT}` 且非 dry-run 才签票。
- **核验与作废在 `ConnectorBus` 每个写方法的入口、同一个同步块内完成**（签名、`bootId`、`accountId`、`action`、`targetDigest` 等于实际传入目标的哈希、未过期、未用过 → 立即标记已用），通过后才进入连接器。一票覆盖该次总线调用内部的全部签名与重试（如 HL 一次提交里先改杠杆再下单；附带止盈止损的父单与子单共用一张票）。
- `ConnectorBus.submit` 一次只提交一个意图：一票一意图。
- 连接器不负责核验，但会收到 `expiresAt`：有到期字段的场所写进动作（HL `expiresAfter`），让场所兜底拒绝迟到请求，并给结果未知的订单一个终止判定（§8）。
- 票据防的是「绕过闸门的代码路径」与「引擎 / 插件冒充内核直发」。发证与核验同在内核进程，签名在 r1 不增加对同进程恶意代码（T-C）的防护；它为 r3 的进程外连接器预留了跨进程核验的形式。

### 3.6 `RiskPolicy` 追加字段

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `limitMode` | `{ size?: boolean; leverage?: boolean; maxSlippageBps?: boolean }` | 全 `false` | 允许闸门用收紧代替拒绝的字段（待拍板 #1）；r1 只实现 `size` |
| `killSwitch` | `{ file?: boolean; onTrip?: { cancelAll: boolean; keepStopLoss: boolean; closeAll: boolean } }` | `file: true`，`onTrip: { cancelAll: true, keepStopLoss: true, closeAll: false }` | §7。文件 / 自动 / 死人开关来源**一律**保留止损；人工 `kill` 由人当场选择是否保留（M1 行为） |
| `failClosed.staleAccountMs` | `number` | 待拍板 #2 | 账户视图新鲜度阈值，独立于 `stalePriceMs`；过期或状态未知时，所有新订单（含 `reduce`）均拒绝；`confirmedAt` 的语义见 §3.9 |
| `protectors[].mode` | `'enforce' \| 'monitor'` | `'enforce'` | `monitor` = 只记 `monitorHits`、不拦截；内置数字限额没有 monitor |
| `protectors[].source` | `{ pluginId: string; version: string } \| 'builtin'` | `'builtin'` | 规则来源（声明式模板并入时填插件） |

r1.2 字段（本轮不实现，先登记名字）：`killSwitch.tripAfter`、`limits.maxOrderNotionalByInstrument`。

写入走 M1 的 `tighten / relax` 通道。施工清单必须同时更新 `PolicyPatch`、`merge()`、`isLooser()`：`limitMode` 任一项 `false → true`、`killSwitch.file` `true → false`、`onTrip.cancelAll` `true → false`、`onTrip.keepStopLoss` `true → false`、`mode` `enforce → monitor`、`staleAccountMs` 增大、删除任一保护器规则，都算**放宽**，需要强在场证明；`verify()` 的「非强签名版本不得比强签名版本更宽」对这些字段同样成立，并有测试。保护器配对键改为 `(source, kind, scope, 序号)`，内置与模板来的同种规则不再撞键。

### 3.7 `OrderIntent` 追加字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `allowAdjust` | `Array<'size' \| 'leverage' \| 'maxSlippageBps'>` | 意图作者允许闸门收紧的字段；缺省空 |

这是意图里**唯一**与风控有关的字段，语义只能是「允许更严」。Agent 工具的 schema 里不得出现任何限额、状态、批准类字段（M1 规则，重申）。

### 3.8 保护器：内置、声明式模板（r1）、代码型（r1.2）

**内置保护器**（`cooldown` 等五种，M1）在 `decide()` 里按 `order` 评估，纯函数。

**预检接口**（内置与插件共用的语义）：

```ts
interface ProtectorPreInput { target: GateTarget; snapshot: GateAccountView; mark?: { price: Decimal; ts: Ms }; stats: PrecheckStats; now: Ms; params: Record<string, unknown> }
type ProtectorPreVerdict =
  | { action: 'pass' }
  | { action: 'block'; code?: RuleCode; message: string }                       // code 缺省 PROTECTOR
  | { action: 'limit'; field: 'size'; to: Decimal; message: string }            // to 必须更严，否则视为非法返回；并入闭式求解
  | { action: 'pause'; scope: 'account' | 'instrument'; minutes: number; message: string }   // minutes ≤ 1440；本单 block，暂停由内核在 decide 之后执行
```

**声明式模板（r1）**：`kind: 'protector'` 插件的清单字段 `protector.rules: ProtectorSpec[]`，只能由内置种类与参数组成，**不得**含 `kind: 'plugin'`。授予后由人（会话即可，属收紧）把这些规则**并入策略**：写一个新策略版本（`policy.changed`，session 签名），每条规则带 `source: { pluginId, version }`。并入后规则属于策略本身：卸载插件不删规则；删规则走 `relax` + PIN；插件升级带来更宽的参数不自动并入，更严的参数也要人再并一次。在 `decide()` 里与内置保护器同一条路评估。

**代码型（r1.2，本轮只定义语义）**：`runtime.type = 'node'`，走插件协议既有的子进程隔离；清单 `protector.pre: true`、`protector.budgetMs`。内核在组装期异步调用 GSP `protector.pre`，带 `seq` 与超时；回复 `seq` 不匹配丢弃；超时 / 崩溃 / 非法返回 → `unavailable`。结论连同 `source.sha256`、版本、`seq`、耗时写进 `protectorResults`。健康状态机：连续 `N` 次 `unavailable` → `failed`，之后结论固定为 `unavailable`；人工重新启用属收紧，会话即可。插件随内核启动预先拉起。声明 `protector.pre` 的插件 `permissions` ⊆ `takeover.trigger` / `notify.user`；它读不到内核文件；「不联网」是清单声明，靠签名与来源审查。

**`decide()` 对插件结论的单次可复现语义**（r1 就写进实现，r1.2 才会有非空结论）：策略里配置了、`enforce` 模式、但 `protectorResults` 里没有其结论的插件：若其他阶段已有 `deny` / `review` 命中 → 该插件标 `PROTECTOR:skipped`；否则按 `PROTECTOR_UNAVAILABLE` 处理（`BLOCK`）。`monitor` 模式的缺失或 `unavailable` 只记 `warn`。插件收到的是**调整后**目标；插件的 `limit.to` 作为又一个上限并入闭式求解，不另开一轮。组装期「先无结论跑一次、收集结论后再跑最终」只是优化；最终 `decide()` 前必须在临界区内重读 `reserved` / `stats`。

`protectorResults[]` 条目：`{ pluginId, version, sourceDigest, order, mode, seq, result: ProtectorPreVerdict | { action: 'unavailable'; reason }, durationUs }`。

### 3.9 连接器提供的视图字段与 `VenueRules`

账户视图追加：`confirmedAt`（**最后一次确认新鲜的时刻**：WS 健康时取当前时间，不是最后一次推送；连接器既有的 `asOf` = 最后一次推送时间，语义不变、保留）、`stale`、`availableDeductsOpenOrders`、`openOrders`（按标的按方向的非只减仓挂单名义与笔数）、`stopLossOrderIds`。闸门的新鲜度判定：有 `confirmedAt` 时用 `now − confirmedAt > staleAccountMs`；连接器没给 `confirmedAt` 时**只看 `stale` 标志**，不拿 `asOf` 减阈值（安静账户几十秒没推送是正常的，不能因此拦开仓）。标记价：`source: 'venue_mark'`（HL `markPx`；模拟场所也必须给出，否则全部纸面开仓会被 `STALE_PRICE` 拦下）。

`rules?: { maxOpenOrders?: { cap: number; current: number }; marketPriceBandBps?: number; minOrderNotional?: Decimal }`，按账户、按当前状态动态给出（HL 挂单上限随成交量从 1000 递增到 5000，查到多少报多少）。闸门：
- `open` 类：`current + 1 > cap` → `BLOCK`（`VENUE_RULE`）；市价 / IOC 限价与标记价偏离超过 `marketPriceBandBps` → `BLOCK`（`VENUE_RULE`）；低于 `minOrderNotional` → `BLOCK`（`ORDER_NOTIONAL`）。附带止盈止损子单的触发价不受价带检查（HL 的 TP/SL 价带 r1.2）。
- `reduce` 类与触发单：`current + 1 > cap` → `warn`（「止损单可能发不出」），不拦。
- 算不出来的项跳过。其余 HL 硬规则归连接器协议。

## 4. 判定流程

### 4.1 动作类别 × 阶段

列：`open` / `reduce` / `cancel` / `cancel_protective` / `amend` / `leverage` / `deadman_arm` / `deadman_disarm`。「拦」= 命中即 `deny`；「查」= 按规则判；「—」= 不评估；「warn」= 只记 `warn` 放行；HALTED/kill 下 `agent` 的严格减仓记 `review` 并转人工审批，`human` / `system` 的严格减仓仍须通过其它门禁。

| # | 阶段 | 检查 | 命中码 | open | reduce | cancel | cancel_protective | amend | leverage | deadman_arm | deadman_disarm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | `SYS` | 策略缺失 / 验签失败；视图 `stale`，或有 `confirmedAt` 且 `now − confirmedAt > staleAccountMs`；标记价缺失、无效或过期 | `TRADING_STATE`（验签失败，M1 原码）、`ACCOUNT_UNKNOWN`、`STALE_PRICE` | 拦 | 陈旧账户视图拦；有效旧价对 human / system 只警告、agent 转人工审批 | agent 旧/缺价拦；human/system 有效旧价警告、缺价不拦 | agent 旧/缺价拦；human/system 有效旧价警告、缺价不拦（保护权限仍按 H） | 按改后类别 | 拦 | — | H |
| 1 | `KILL` | 断电器锁存 | `KILL_SWITCH` | 拦 | agent review；human/system warn | warn | H | 按改后类别 | 拦 | — | H |
| 2 | `STATE` | 作用域生效状态 `REDUCING / HALTED`（含 group） | `TRADING_STATE`、`PROTECTOR` | 拦 | HALTED 下 agent review；human/system warn；REDUCING 保持原规则 | warn | H | 按改后类别 | 拦 | — | H |
| 3 | `MANDATE` | 有效期、状态、账户、级别；纵深防御三项（§4.2，只对 open） | `MANDATE_*`、`MANDATE_INCOMPLETE` | 查 | 查有效期 / 级别 | 查 | 查 | 查 | 查 | — | 拦（仅 system / human） |
| 4 | `LLM` | LLM 来源的实盘开仓 | `LLM_LIVE_ENTRY` | 查 | — | — | 查 | 按改后类别 | 查 | — | — |
| 5 | `ALLOWLIST` | 场所、标的白名单 | `VENUE_NOT_ALLOWED`、`INSTRUMENT_NOT_ALLOWED` | 查 | — | — | — | 按改后类别 | 查 | — | — |
| 6 | `CONST` | 杠杆、单笔名义、滑点、场所硬规则；显式 `reduceOnly` 的仓位方向与原始请求量；订单期限 | `LEVERAGE`、`ORDER_NOTIONAL`、`SLIPPAGE`、`VENUE_RULE`、`MANDATE_LIMIT`、`REDUCE_ONLY_MISMATCH`、`INTENT_EXPIRED` | 查，可 LIMIT(size) | 减仓不匹配 review；期限不合法或 ≤ `now + 2000ms` 拦 | — | — | 按改后类别 | 查杠杆 | — | — |
| 7 | `EXPOSURE` | 单标的比、总比、持仓数、日名义（含预留与非只减仓挂单） | `POSITION_NOTIONAL`、`TOTAL_NOTIONAL`、`OPEN_POSITIONS`、`DAILY_NOTIONAL`、`MANDATE_LIMIT` | 查，可 LIMIT(size) | — | — | — | 按改后类别 | — | — | — |
| 8 | `BUYING_POWER` | `available − 预留保证金 ≥ 新增保证金`（§8） | `INSUFFICIENT_MARGIN` | 查，可 LIMIT(size) | — | — | — | 按改后类别 | 查 | — | — |
| 9 | `LOSS` | 当日亏损比 / 额 | `DAILY_LOSS`、`MANDATE_LIMIT` | 查 | — | — | — | 按改后类别 | — | — | — |
| 10 | `RATE` | 每分钟 / 每日笔数（下单 + 改单，含预留在途）、权重预算、重复意图；撤单速率 | `RATE_BUDGET`、`COOLDOWN` | 查 | 普通权重 1；带期限减仓按权重 5 检查，预算不足记 warn | 查撤单速率（`system` 豁免） | 查撤单速率（`system` 豁免） | 按改后类别 | — | — | — |
| 11 | `PROTECTOR` | 内置保护器 + 模板规则 + 插件结论，按 `order` | `PROTECTOR`、`PROTECTOR_UNAVAILABLE` | 查 | — | — | — | 按改后类别 | — | — | — |
| 12 | `APPROVAL` | 需要人批准 | `NEEDS_APPROVAL` | 查 | — | — | `agent` 按 open 类审批 | 按改后类别 | 查 | — | — |

- **全量评估**：本类别应评估的阶段全部跑完，所有命中都进 `ruleHits`，不短路。
- agent 撤销单笔订单时按目标标的采集 `venue_mark` 价格见证；撤销全部订单时按快照可见的唯一标的采集见证并随 GateSnapshot 入账，缺价或价格过期即拒绝该 agent 撤销动作。
- human 与 trusted system 撤销只观察现有缓存，不等待行情；已知有效旧价在 ruleHits 和 applied 中记 STALE_PRICE 警示，缺价或读取失败不拦撤销，既有账户状态与保护单权限仍生效。
- 价格见证的 `quote` 取自标的元数据；缺少元数据时，警示的单位写作字面 `quote`，表示报价单位未标明，不推断币种。
- 判决合成：有 `deny` → `BLOCK`；否则有 `review` → `BLOCK` + `escalation`；否则有 `limit` → `LIMIT`（§3.3）；否则 `ALLOW`。`warn` 不影响判决。
- `reduce` 必须对应现有仓位、方向相反且原始请求量不超过仓位；`reduceOnly` 量在场所精度规整前核对。缺仓、错向或超量记 `REDUCE_ONLY_MISMATCH` 并转 review。陈旧或过期账户快照下，所有新订单（包括减仓）均以 `ACCOUNT_UNKNOWN` 拒绝。
- 有效 `HALTED` 或 kill 下，agent 严格减仓转 proposal，不得直发；human 严格减仓需 PIN，system 严格减仓无需 PIN。`REDUCING` 保持既有减仓权限。撤单仍按本表及速率规则处理。
- 订单提供 `expiresAt` 时必须是安全整数且严格晚于 `now + 2000ms`；相等边界拒绝。出票时重新核验期限，ConnectorBus 消费前再次核验剩余期限。期限在出票后穿过边界时，本地拒绝、释放预留且不调用连接器。带期限减仓按权重 5 评估；真实执行路径发生本地期限拒绝时记 5 个本地作废估计值，不代表场所实际消费；dry-run 不记该权重。
- `cancel_protective`（撤止损、`cancelAll` 带 `keepProtective: false`）：`agent` 在 `KILL` / `REDUCING` / `HALTED` 下拦，`ACTIVE` 下按 `open` 类审批；`human` 会话撤 / 挪自己的止损在任何状态下都放行并记 `warn`（是否要 PIN 见待拍板 #13）；`system` 来源（`kill` / 接管）豁免。
- `amend`：按改后订单分类，开仓改单仍走 `open` 限额；仅原下单行为人或人类可改未终态订单。业务授权层另拦 Agent 在 `HALTED` / `REDUCING` / 杀开关下的改单，HALTED 下不创建新的改单 proposal；在 `ACTIVE` 下，Agent 不得放远保护单触发价、缩小保护数量或把触发限价改向更难成交的方向。HALTED/kill 下 human 修改 `reduceOnly` 订单也需 PIN，即使修改的不是保护腿；保护单修改继续按原 PIN 规则执行。拒绝入 `order.rejected`；每次出票计一次持久化下单频率，TP/SL 子单不另计。预检剔除本单旧敞口，出票后释放账户队列并保留新旧较大预留；成功切换到新预留并记带 `orderId` 的 `order.amended`，明确拒绝恢复旧值，未知结果保留较大值、记 `amend.unknown` 并返回 3006。同单在途时不得再次改单。成功后按 cloid 查询刷新场所单号；连接器对附带 TP/SL 改单的 1004 原样返回。
- 触发单名义：触发限价取 `price`，无执行限价的触发单取 `triggerPrice`；普通市价单取标记价。
- 附带 TP/SL：连接器回执中的 tp/sl 分别落独立子单，继承父单来源，反向且只减仓；子单数量沿用父单（当前协议腿类型无独立数量字段）。触发、成交、取消依场所事件更新，不因父单撤单 ack 在本地推断子单终态。 缺场所单号仍落子行，内部标为未关联并记 warning；只凭可靠 cloid 关联，不按价格或数量猜测。未关联子行不建预留、不单独撤改，启动对账只记数量，不因此停机；可撤父单或全撤。
- 撤单 ack 仅表示请求接受；经推送或查询确认终态，查询本地订单时先补录成交，外来单只查状态。全撤确认最多并发 8 路；普通全撤等待确认并返回确认数，接管/系统路径收到 ack 即返回成功回执数，先记 `cancel_all.requested`，后台确认后再记 confirmed/requested（确认数为 0 时记 annotation）。成交按账户与场所成交编号去重，缺编号时按订单、场所时间、数量、价格组合去重；10000 项 FIFO 缓存外仍有持久化唯一约束。未知状态按场所/原始状态去重日志，本地订单另按订单/原始状态去重记 `order.status_unknown`，外来单只记日志。
- `leverage`：只过 `CONST` 杠杆上限、`BUYING_POWER`、`APPROVAL`、`LLM`；`KILL` / `REDUCING` / `HALTED` 下**对所有发起人**都拦（`allowedActions.leverage = false`；人要改杠杆先 `resume`），表中 `SYS` / `KILL` / `STATE` 三行的「拦」以此为准。
- `deadman_arm`（布防与每次续期）永远放行；`deadman_disarm` 只认 `system` / `human`。续期的判定只记计数（`payload.timing` 与计数进下一条账本条目），不逐条入账。
- **dry-run**：`dryRun: true`，不入账、不出票、不占预留、不计入熔断计数。
- 并发下判定顺序确定：同一账户的「读预留与统计 → `decide()` → 记预留」在一个同步块内完成（单账户单写入者），谁先进临界区谁先判（§8）。

### 4.2 授权书纵深防御

M1 签发 L3 / L4 授权书时已强制白名单、额度、日亏、心跳与有效期。闸门再查一次（实盘且级别 ≥ L3 的 `open` 类）：缺 `limits.autoMaxOrderNotional`、`limits.maxDailyLoss` 或空 `instrumentAllowlist` → `MANDATE_INCOMPLETE`（`action: review`，转提案）。只作用于 `open` 类；纵深防御，不追溯整改。

## 5. 唯一下行通道

人类请求也必须经过同一闸门：人通过已认证会话提交 HTTP intent，内核据会话身份组装输入并执行预检；仅命中需要 PIN 的动作才要求 PIN 在场证明。Agent 的实盘确认流程由同一把已认证 Agent 钥匙完成：先 preview，再由该钥匙提交与 preview 绑定的 confirmToken；内核在确认/提交时重新核验授权书、风控版本与价格漂移并重新走闸门。纸面 / shadow 可直接提交 intent。人类批准属于 proposal.approve，并在批准执行时重新判定；每个 confirmToken 不要求再由人逐笔确认。`ACTIVE` 状态下 `takeover.flatten_all` 要求人类会话与 PIN；`HALTED` 下的人类减仓也要求 PIN。服务身份仅可请求现有 kill 降风险路径；其余人类专属状态变更仍按各自会话与 PIN 规则执行。系统内部急停与死人开关属于内核控制路径。

1. **每次向场所提交恰好对应一次出票判定**。`preview + place`、`propose + approve` 本来就各判一次，只有最终提交那次出票。
2. 连接器总线写方法全部纳入，目标形状按 §3.1 `GateTarget`：`submit`（`order`）、`amend`（`order`，改后）、`cancel`（`cancel`）、`cancelAll`（`cancel_all`）、`setLeverage`（`leverage`）、`scheduleCancel`（`deadman`）。每个入口同步核验并作废票据（§3.5）；没有票据或票据不符 → `GATE_TICKET_INVALID` / `GATE_TICKET_EXPIRED`，不签、不发、入账 `risk.denied`。
3. 接管动作（撤单、全平、`systemReduceOnly`）也出票：它们是 `cancel` / `reduce` 类，`system` 发起，在 `KILL` / `HALTED` 下照常放行。
4. **签名器只做作用域绑定，不承诺内容绑定**：HL 的普通动作签的是动作哈希，内核签名器看不到内容。能做到的是：每次总线调用发一个限时、限次的签名句柄，调用结束即作废；只放行 `primaryType = 'Agent'` 一类普通动作签名；用户签名类动作（转账、提现、`SendAsset`、`approveAgent`）一律拒签，人面 PIN 流程除外。这一条与插件协议 r2.1 的「连接器双签名层级」是同一件事，只实现一次。
5. 死人开关续期在 r1 统一由内核发起（`scheduleCancel`），连接器内部的自动续期（`armDeadman`）禁用。
6. 外部引擎自己连场所下的单（引擎协议模式 B）不经闸门：账本 `attestation` 为 `engine-reported`，界面标明；本协议不把它算作受保护流量，前向账本也不认它。
7. `ALLOW` 原样发；`LIMIT` 按 `applied` 调整后发，票据绑定调整后的哈希；`BLOCK` 什么都不发。

## 6. 入账、验证与回放

- **不新增账本类型**。判定与快照挂进已有条目的载荷 `payload.gate = { decision, snapshot, target }`：`order` 类执行写 `order.intent`，拒绝写 `risk.denied`，提案 / 预览写 `risk.precheck`。**口径（r1.2 补，2026-10-15）**：凡执行路径上（`dryRun=false`）的拒绝，不论入口是直接下单还是提案，一律写 `risk.denied` 并发 `risk.denials` 事件（M1 口径不变，界面「被拦截」与拒单列表靠它）；`dryRun=true` 的预演不入账、不发事件；提案创建本身另写 `risk.precheck`；`cancel` / `cancel_all` 写 `order.cancelled`（拒绝写 `order.rejected`）；`leverage` 与 `deadman_disarm` 写 `annotation`（`payload.kind` 标明）；`deadman_arm` 只累计计数。头部 `precheck` 照旧；`decision ≠ ALLOW`（含 `LIMIT`）时头部 `ruleHits` 必填。
- `payload.timing = { assembleUs, decideUs, protectorUs }` 在函数外计量。
- **S1 已接入 CLI**：`risk verify` 验签策略及本地批准价格参数；`risk verify <precheckId>` 复用验签与回放检查。取条目，重算 `attestation.digest` 与 `snapshotDigest`，用安装公钥验签，核对 `policyRef.digest` 与策略链该版本一致、`targetDigest` 与载荷里的目标一致。任一不符即报告，不修改。
- `gitrader risk replay <precheckId>`（S1 已接入）：按 `snapshot` 取回策略版本，重建 `GateInput`（`target` 与 `protectorResults` 取自载荷），跑 `decide()`，比对 `decision / ruleHits（去 message）/ applied / allowedActions`。输出 `identical` 或逐字段差异；`rulesetVersion` 不同导致的差异要明示。
- 确定性：`decide()` 不用时钟、不用随机数、不跨线程；`precheckId` 在函数外生成后作为输入进入摘要。
- 拦截统计（`gitrader risk stats`）口径：只算执行路径（`direct` / `approved`）上 `deny` 类 `BLOCK`，按 `clientOrderId` 去重；`review` 单列「转人批」；dry-run 不计。损失类口径另立项（待拍板 #6）。
- 策略导出（S1 已接入）：`gitrader risk policy export` 输出签名策略、本地批准价格参数与完整性结果（均含摘要）；没有导入命令。
- 启动对账：唯一资金权威不健康时拒绝进入 `ACTIVE`（M1「启动对账失败 → 粘性状态」），本协议引用并要求入账。

## 7. 第 0 层断电器（锁存）

S1 已实现 `HALT` 启动检查与 `fs.watch`：出现先锁存再尝试撤单，删除不恢复，恢复仍需人面 PIN。下列完整协议目标中的轮询兜底、文件来源保留保护单与文件仍在时拒绝恢复尚未全部落地；不据此声称 K2 完成。

- 来源：人工 `kill`（M1）；死人开关触发（M1）；**文件**：数据目录（`GITRADER_HOME`）下存在 `HALT` 文件；自动熔断（`tripAfter`，r1.2）。
- **锁存**：任一来源首次触发即 `tstate.set(org, 'HALTED')` 并入账，同时执行 `killSwitch.onTrip`：撤挂单（文件 / 自动 / 死人开关来源**保留止损单**；人工 `kill` 由人当场选）、停机；`closeAll` 缺省关。文件的存在与否之后不再影响状态：删文件不恢复，恢复只认人在场的 `resume`（PIN）；`resume` 时文件仍在则拒绝并提示先删。文件检测：启动时查一次 + `fs.watch` + 1 秒轮询兜底，不在 `decide()` 内查。
- 触发后对 `agent` 的 `allowedActions` 只剩 `reduce` / `cancel` / `deadman_arm`；Agent 没有任何恢复类工具。`human` 仍可撤 / 挪止损。
- 接管流程与断电器来源的撤单以 `system` 发起，豁免 `cancel_protective` 与撤单速率限制，不会被自己的规则拦住。
- 多级：org / group / account / instrument / mandate 作用域。

## 8. 购买力与敞口按预留

内核维持进程内 `ReservationBook`（按账户；分桶：按标的按方向、当日、近一分钟）。

- **记**：出票时按最坏情况预留（新增保证金、名义额、1 笔），在与 `decide()` 相同的同步块内完成。
- **释**与公式，按连接器声明的 `availableDeductsOpenOrders`：
  - **为真**（HL 一类，`available` 已扣挂单保证金）：预留保证金 = Σ 已出票、但场所视图里还看不到的订单的新增保证金；该 `clientOrderId` 出现在视图的挂单或成交里即释放；购买力检查 `available − 预留 ≥ 新增保证金`。
  - **为假**（`available` 不扣挂单，如部分 CEX、模拟场所）：预留保证金 = 在途 + Σ 已挂未成交部分 × 价格 ÷ 杠杆；部分成交时已成交部分转入持仓、由场所承担，剩余部分继续预留；撤单、过期、成交完毕时释放。
  - 未到场所就结束的（签名器失败、幂等命中、价格漂移、票据过期未用）立即释放。
  - **结果未知**的订单：场所支持到期字段的，`expiresAt + 时钟余量` 后仍未出现在视图里即判定永不成交，释放并入账；不支持的保留到对账结束并持续告警。
- **敞口**：`EXPOSURE` 的单标的比 / 总比把**非只减仓挂单名义**（视图 `openOrders`）与预留一起计入——连挂 10 张在上限内的限价单不能叠加出 10 倍持仓。
- **对账**：定期用场所视图校正预留，差异入账。
- **重启**：预留只在内存；重启后从未终态订单重建并立刻对账。

## 9. 码表（追加，不复用，旧码语义不变）

规则码 `RULE_CODES` 新增 5 个：`KILL_SWITCH`、`ACCOUNT_UNKNOWN`、`PROTECTOR_UNAVAILABLE`、`VENUE_RULE`、`MANDATE_INCOMPLETE`（共 27 个）。**原有条件继续出原码**：验签失败与 `HALTED / REDUCING` 仍出 `TRADING_STATE`；新码只用于新条件。`RuleHit.action` 新增 `'limit'`。

规则码 → 问题码映射（`RULE_PROBLEM` 显式登记）：`KILL_SWITCH → TRADING_STATE (2002)`、`ACCOUNT_UNKNOWN → STALE_PRICE (2007，可重试)`、`PROTECTOR_UNAVAILABLE → PROTECTOR_PAUSE (2006)`、`VENUE_RULE → RULE_DENIED (2001)`、`MANDATE_INCOMPLETE → NEEDS_APPROVAL (2009)`。

问题码新增：`GATE_TICKET_INVALID = 2010`（RISK，不可重试）、`GATE_TICKET_EXPIRED = 2011`（RISK，可重试：重新判定）。

新枚举：`GATE_ACTIONS`、`GATE_STAGES`、`ACTOR_CLASSES`；`GateTarget` 联合类型。JSON Schema 一律从常量生成（修掉手写的 `enm('deny','warn','review')` 与 `ledger.json` 里的内联副本）。不新增账本类型、不新增插件运行时类型。清单新增字段 `protector: { rules?: ProtectorSpec[]; pre?: boolean; budgetMs?: number }`（r1 只校验 `rules`：内置种类、无 `kind:'plugin'`）。

与 G3 调研里 midas-core 码表的对照：`MAX_ORDER_NOTIONAL → ORDER_NOTIONAL`、`MAX_LEVERAGE → LEVERAGE`、`MAX_GROSS_EXPOSURE → TOTAL_NOTIONAL`、`DAILY_LOSS_HALT → DAILY_LOSS`、`MAX_ORDERS_PER_DAY → RATE_BUDGET`、`SYMBOL_NOT_IN_UNIVERSE → INSTRUMENT_NOT_ALLOWED`、`INSUFFICIENT_BUYING_POWER → INSUFFICIENT_MARGIN`、`STALE_MARKET_DATA → STALE_PRICE`、`KILL → KILL_SWITCH`、`MAX_DRAWDOWN_HALT → PROTECTOR`、`MAX_ORDER_NOTIONAL_PER_SYMBOL → r1.2`。

## 10. 性能、测试与口径

- `decide()` 单次 p95 ≤ 1 ms（参考机，不含组装）；`decideUs` 入账可统计。
- 一致性夹具：`packages/protocol/conformance/risk-gate/*.json`，每个用例 = `{ input: GateInput, expect: { decision, verdict, codes[], applied[], allowedActions } }`；覆盖两种 `availableDeductsOpenOrders` 语义、每个动作类别 × 发起人类别、`PROTECTOR:skipped` 与 `PROTECTOR_UNAVAILABLE` 两种缺结论情形；内核测试逐个跑。
- 回放测试：随机输入集上「回放输入 → 判定」逐字节等于原判定（去 `attestation`）。
- 并发测试：同账户两笔并发意图合计超过可用 → 第二笔 `INSUFFICIENT_MARGIN`；同标的两笔各自在上限内、合计越线 → 第二笔 `POSITION_NOTIONAL`；两笔并发反向单 → 第二笔按 `open` 评估；10 张在上限内的限价单 → 第 N 张 `POSITION_NOTIONAL`。
- 降风险测试：分别覆盖策略验签失败、账户视图陈旧、断电器锁存、日笔数已满、撤单速率已满的既有动作边界；账户视图陈旧仍阻断包括纯减仓的全部新订单。有效旧价时 human PIN 减仓与系统紧急全平可执行并记录估值及警示，agent 减仓转提案；human/system 撤单按缓存警示且不等待价格，agent 旧价或缺价撤单拒绝。断电器由文件触发后止损单仍在。
- 口径：`ALLOW` 只表示「没有违反你写的规则」，不表示安全或盈利；「无视判定照样调用场所，那它只是个日志器，不是护栏」写进文档。判定对象、工具说明、界面文案不得出现「安全」一类字眼与契约附录 B 的对外禁用词。

## 11. 好坏示例

**好：BLOCK（转提案）**

```json
{ "precheckId": "pck_01JC…", "verdict": "review", "decision": "BLOCK", "action": "open",
  "escalation": { "to": "human_approval", "reason": "NEEDS_APPROVAL" },
  "ruleHits": [{ "ruleId": "mdt_01JB…#autoMaxOrderNotional", "code": "NEEDS_APPROVAL", "limit": "2000", "actual": "3500", "unit": "USDC", "action": "review", "scope": "mandate" }],
  "applied": [], "monitorHits": [],
  "allowedActions": { "open": true, "reduce": true, "cancel": true, "cancel_protective": false, "amend": true, "leverage": true, "deadman_arm": true, "deadman_disarm": false },
  "irreversibility": "high",
  "stages": ["SYS","KILL","STATE","MANDATE","LLM","ALLOWLIST","CONST","EXPOSURE","BUYING_POWER","LOSS","RATE","PROTECTOR","APPROVAL"],
  "targetDigest": "sha256:…", "adjustedTargetDigest": "sha256:…", "snapshotDigest": "sha256:…",
  "policyRef": { "policyId": "pol_01JA…", "version": 7, "digest": "sha256:…" },
  "mandateRef": { "mandateId": "mdt_01JB…", "version": 3, "digest": "sha256:…", "effectiveLevel": "L3", "effectiveStatus": "active" },
  "dryRun": false,
  "attestation": { "method": "system", "by": "kernel", "at": 1760400000000, "digest": "sha256:…", "sig": "…" } }
```

**好：LIMIT（策略与意图都允许缩量，闭式求解一次复核通过）**

```json
{ "decision": "LIMIT", "verdict": "allow", "action": "open",
  "applied": [{ "ruleId": "pol_01JA…#maxOrderNotional", "code": "ORDER_NOTIONAL", "field": "size", "from": "0.5", "to": "0.28", "unit": "BTC" }],
  "ruleHits": [{ "ruleId": "pol_01JA…#maxOrderNotional", "code": "ORDER_NOTIONAL", "limit": "20000", "actual": "35000", "unit": "USDC", "action": "limit", "scope": "account" }],
  "targetDigest": "sha256:aaa…", "adjustedTargetDigest": "sha256:bbb…" }
```

**好：断电器锁存后的减仓**：`HALT` 文件出现 → 账户 `HALTED`、非止损挂单已撤、止损单仍在；Agent 提交 `reduceOnly` 减仓 → `review` 并创建 proposal，不调用连接器；human 持 PIN 批准后重新预检并执行，审计保留 Agent 原始来源；system 严格减仓无需 PIN。Agent 删除 `HALT` 文件后状态不变，开仓仍 `BLOCK`（`KILL_SWITCH`）；Agent 想撤止损 → `BLOCK`。

**坏：减仓单夹带杠杆**：`{ reduceOnly: true, size: "0.001", leverage: 50 }` → 组装期剥掉 `leverage`、记 `warn`、改前哈希进 `originalTargetDigest`；场所不会收到改杠杆请求。

**坏：十张限价单叠加**：现价下方挂 10 张各在上限内的限价买单 → 第 N 张因「非只减仓挂单名义 + 持仓 + 预留」越过单标的比而 `BLOCK`（`POSITION_NOTIONAL`）。

**坏：工具 schema 带风控字段**：`{"properties": {"maxLeverage": …}}` 或 `{"approve": true}` → 插件清单校验拒装（插件协议 §3.9 与本协议 §3.7）。

**坏：单边允许调整**：策略 `limitMode.size = true` 但意图没有 `allowAdjust: ["size"]` → 超限即 `BLOCK`，message 带上限值；反之亦然。

## 12. 待拍板清单

| # | 事项 | 建议 |
|---|---|---|
| 1 | `limitMode` 缺省全关；纸面账户是否默认开 `size` | 全关 |
| 2 | `failClosed.staleAccountMs` 缺省值（前提：`confirmedAt` = 最后一次确认新鲜，§3.9） | 30 000；过期或状态未知时拒绝所有新订单（含 `reduce`）；C 包在测试网实测 HL 推送节奏后再定 |
| 3 | 代码型保护器 `budgetMs` 与健康状态机 `N`（r1.2） | 20 ms（实测子进程往返满载 p99 约 1 ms、最大 7 ms）、连续 3 次 |
| 4 | `onTrip` 缺省：撤挂单 + 保留止损 + 不全平 | 照此 |
| 5 | 断电器文件名 `HALT`、默认启用 | 启用 |
| 6 | Prevented Loss / Delegation Gap 损失类口径 | r1 只出计数与被拦名义额 |
| 7 | 品种级单笔上限 `maxOrderNotionalByInstrument` | r1.2，字段与放宽判定一起补 |
| 8 | `tripAfter` 缺省与作用域（r1.2） | 不设；作用域缺省 `mandate` |
| 9 | 快照存派生量（含挂单名义、止损单号） | 照此；每条估 1–3 KB |
| 10 | 场所硬规则 r1 范围 | 挂单数（动态）+ 价带 + 最小名义 |
| 11 | positionRisk 形状对外暴露、每 Agent 一子账户 | 不在 r1 |
| 12 | `MANDATE_INCOMPLETE` 记 `review`（转提案） | 照此 |
| 13 | 人在会话里撤 / 挪自己的止损是否要 PIN | 会话即可（沿用 M1 提案审批强度） |
| 14 | 减仓单夹带的杠杆由内核剥掉（未经意图作者同意的改动） | 剥掉，记 `warn` 与 `originalTargetDigest` |

已由既有规则直接决定、不再拍板：`verdict` 保留到下一个 major；既有 L3 授权书不追溯；提案审批强度沿用 M1。工程常量不拍板：`pause.minutes ≤ 1440`、文件轮询 1 秒、小数 18 / 8 位。

## 13. 与其他协议的接口

- 插件协议：`kind: 'protector'` 清单新增 `protector` 字段；r1 声明式模板无运行时；r1.2 代码型为 `runtime.type = 'node'` + `protector.pre`。后置保护器不变。
- 连接器协议：账户视图追加 `confirmedAt` / `stale` / `availableDeductsOpenOrders` / `openOrders` / `stopLossOrderIds`；标记价 `source: 'venue_mark'`；`rules` 动态声明；写方法收 `expiresAt`；签名器作用域绑定（与插件协议 r2.1 P0-7 同一实现）。
- 实验注册表：成交与订单引用 `precheckId`；前向账本只认有判定与票据的成交。
- 工具面管理：`allowedActions` 决定下单 / 改单 / 撤单类工具是否可发现。
- Agent 总线：判定对象作为结构化结果回给宿主，不翻译、不缩写码。
- 界面（工作台 / 默认块）：`LIMIT` 提示、`resume` 因文件仍在被拒的提示、`allowedActions` 驱动按钮状态——r1 不做，列入工作台视觉轮。

## 14. 版本与合并顺序

协议包版本由主会话统一分配：r2.1 P0-2（0.1.10）→ **本协议 P 包（0.1.11）** → r2.1 清单三规则（0.1.12）。三者都碰 `plugin/manifest.ts`、`CHANGELOG.md`、版本号，按此顺序串行合并；本协议对清单只追加 `protector` 字段。施工顺序：先冻结 P 包接口（类型、schema、夹具，不含实现），K 与 C 再并行。

## 15. 范围切分

当前状态：S1 补齐 HALT 文件监视与 risk CLI；声明式保护器全量、自动熔断及其余 K2 待办仍未完成。以下为规划范围，不是完成清单。

**r1（本轮施工）**：三值与映射；动作类别 × 阶段表；总线票据（全部写方法）；推断减仓写回与减仓剥杠杆；规范化与小数；预留记 / 释 / 对账（两种 `available` 语义）与挂单名义计入敞口；断电器锁存（文件 + 保留止损 + 恢复规则）；group 作用域；标记价与新鲜度（C 包）；场所硬规则（动态挂单数 + 价带 + 最小名义）；LIMIT 只做 `size`；声明式保护器模板并入策略（含配对键与放宽判定）；码表与 schema 从常量生成；`risk verify / replay / stats / policy export`；一致性夹具。

**r1.2（下一轮）**：代码型保护器插件（GSP `protector.pre`、健康状态机、预拉起、`--rerun-protectors`）；LIMIT 的 `leverage` / `maxSlippageBps` / 翻仓收紧；`tripAfter`；品种级单笔上限；TP/SL 价带；界面提示。

**不在本协议**：签名器拒签资产类动作（r2.1 P0-7）；positionRisk 形状的对外暴露；每 Agent 一子账户。
