> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/connector-hyperliquid

Hyperliquid 连接器：行情（WS 为主、REST 兜底）、交易（API 钱包签名）、权重预算、主网 / 测试网、多 dex（HIP-3）动态发现。实现 `VenueConnector`（`src/types.ts`）。

```ts
import { HyperliquidConnector, createWeightBudget } from '@gitrader/connector-hyperliquid'

const hl = new HyperliquidConnector({ environment: 'testnet', budget: createWeightBudget() }) // budget 由内核注入，同机多连接共用一份
await hl.start()                                     // perpDexs + 每个 dex 的 meta，连 WS
hl.quote('hyperliquid:xyz:TSLA')                     // { bid, ask, last, stale, ageMs }
hl.subscribe({ channel: 'book', instrumentId: 'hyperliquid:BTC' }, (e) => { /* ... */ })
await hl.submit({ account, signer, onSigned }, [intent]) // signer 是内核给的 signTypedData 句柄，连接器拿不到私钥
```

## 能力声明（`describe()`，契约 §1.5.1）

只声明**实际实现**的部分：永续（`perp`）；订单类型 限价 / 市价（模拟，IOC 限价 + 滑点上限）/ 止损 / 止盈（市价与限价）；`tif` gtc / ioc / alo；触发价类型 `mark`；TP/SL 父子单与仓位级；改单（native）、全撤（emulated，逐单撤）；场所级死人开关（`scheduleCancel`，≥5 s、每天最多触发 10 次）；账户模式 standard / unified / portfolio；API 钱包（无提现权限、每签名者独立 nonce、最长 180 天）。
**没做、不声明**：现货与结果市场、`twap`、`trailing_stop`、批量改单、多签。出处：知识库 `API_info与exchange要点_速率限制`、`API钱包_代理钱包与nonce`、`订单类型与TP-SL语义`、`账户模式与保证金`、`Builder_Codes`、`HIP-3_dex清单`。

## 限速口径

- 场所按 **IP 聚合权重 1200 / 分钟**（`allMids` / `l2Book` / `clearinghouseState` / `orderStatus` = 2，`userRole` = 60，其余 info = 20；`candleSnapshot` 每 60 条加 1，`userFills*` 等每 20 条加 1；exchange 动作 `1 + floor(批量/40)`）。
- 本包的默认预算 `createWeightBudget()`：**任意连续 60 s 内已批准权重 ≤ 720（= 60%）**，并按用途（`kind`）区分交易、查询与后台任务。连接器的 HTTP 接缝同时传 `kind` 与优先级（`priority`）：`trade` 使用 `high`，`query` / `background` 使用 `low`；这兼容按 `kind` 分档的本包预算和按 `priority` 分档的内核预算。内核低优先级额度可能让账户 / 行情 REST 兜底排队；这不代表 REST-only 稳态容量已解决。收到 429 整体退避。`budget.usage()` 的 `ratio` 是对外公布的「HL 权重占用」。
- WS 增量优先：行情、账户数据优先使用 WS 与本地缓存；REST 用于冷启动、账户和行情兜底、显式查询及交易动作。WS 订阅数上限默认 900（官方 1000），用户流涉及不同用户 ≤10 / IP 由内核把关。
- 每地址的「每成交 1 USDC 换 1 次请求」额度本包不管（在账户侧，由内核的交易速率预算管）。

## 账户读取：WS 用户流 + 本地快照（缓存即时返回，后台兜底）

查一次账户（逐 dex 的清算状态 + 现货 + 逐 dex 的挂单）用 REST 要约 110 权重，一个实盘账户配一个会刷新的工作台几秒就能打满预算。所以账户 / 持仓 / 挂单 / 成交优先由 **WS 用户流增量维护本地快照**；读取立即返回缓存，缺失或过期时另行安排后台 REST 刷新：

| 数据 | 订阅（按知识库 `WebSocket订阅类型` 选最省的） |
|---|---|
| 全部 dex 的保证金与持仓 | `allDexsClearinghouseState`（1 条，覆盖所有 HIP-3 dex，不按 dex 逐个订） |
| 现货余额 | `spotState` |
| 挂单 | `openOrders`（每个在线 dex 1 条；dex 增减时自动对齐） |
| 成交 | `userFills`（首包快照 + 增量；与对外的 `userFills` 订阅共用同一条订阅） |

- `accountState`、`accountView`、`openOrders` 与本地成交读取会立即返回当前缓存；首次读取通常是空的 `stale` 视图，同时在后台探测账户模式、拉取账户 REST 快照并维护缓存。后续调用需要重新读取缓存，才能看到后台完成的新状态。`fills(ref, since)` 若请求早于本地跟踪起点，会等待 REST 历史回补；跟踪起点之后则读本地成交缓存。
- 每份快照带 `asOf`（数据最后变化时刻）、`stale` 和 `source`。`allDexsClearinghouseState` 的匹配用户 ACK 或有效推送提供独立清算证据；默认证据有效期为 `2 × restFallbackMs`，即 20 s。spot、挂单和成交分片只更新各自数据，不会延长清算证据。成功 REST 快照有独立的 20 s 默认有效期并推进 `confirmedAt`；失败或仍在等待的 REST 不会推进确认时间。`accountView(ref)` 一次给快照、挂单和成交，共用同一组标记。
- `startupSnapshot(ref, fillsSince)` 会立即返回当前缓存，并在后台安排账户 REST 与历史成交回补；首次结果可能是账户 `stale`、成交 `truncated`。调用方需再次读取，确认 REST 和历史数据已完成后再使用。账户后台警告按固定消息类别每十分钟限频一次。
- REST 还用于断线或账户清算证据过期后的后台兜底（默认最小间隔 10 s）、显式历史回补（以及 `orderStatus`）。`accounts: { stream: false }` 会禁用用户账户 WS，但账户读取仍先读本地缓存，并由后台 REST 刷新，不会让每次读取同步等待 REST。`cancelAll` 会直接查询场所挂单，并按交易优先级记权重。
- 同时跟踪的账户数上限 10（官方：用户级订阅涉及的不同用户 ≤10 / IP），超出返回 `4004 BUSY`。
- 已知取舍：WS 的 `openOrders` 推送不一定带订单类型 / 触发信息，认不出来的订单类型标 `unknown`（不猜；启动时 REST 引导过的订单沿用已知类型）。这几种推送的字段形状只按官方文档对照，没有对真账户核对。

权重占用曲线见 `bench/connector/result.json` 的 `weightCurve`（1 个实盘账户 + 工作台 + 每分钟 10 笔下单，10 分钟）：WS 用户流旧基准约 **170 权重 / 分钟（14%）**，其中交易 10；旧的逐次 REST 基准约 **6890 / 分钟（574%）**。这些数字是旧基准，本轮 REST 兜底行为未复跑，不能代表新兜底的稳态容量。工作台若订阅 `book` 通道（而不是反复调 `book()`）还能再省约 60。

## 行情

多 dex **动态发现**：`perpDexs` → 每个 dex 的 `metaAndAssetCtxs`；整个 dex 已下架或请求失败（连续 2 次 / 从未成功）即剔除并取消其订阅，每 10 分钟复查；dex 从 `perpDexs` 消失则连同行情一起移除；`instruments` 事件报告增减。行情 10 s 没更新即 `stale: true`（`quote()`、`status()`）。常驻标记优先用 `activeAssetCtx`；无 WS 推送时按 `markStaleMs / 2` 安排 REST 兜底，默认约 2.5 s。若低优先级预算或 HTTP 未能及时返回，`mark()` 可能为 `undefined`。连接器只标记，不替调用方判断能不能用（风控的 `failClosed` 在内核）。历史 K 线 `candles(id, interval, {from, to})` 按页取全，每页交给注入的 `recorder`（录制器接口，落盘由外部实现）。

HL 官方 WS 文档列出 fast 5 档 / slow 20 档深度；推送按区块生成，同一订阅两次更新至少间隔 500 ms。此频率不构成对本地 `stale` 阈值的承诺。

## 本地 L2 快照（给模拟场所用）

`bookSnapshot(id)` 同步读 WS `l2Book` 订阅维护的本地盘口，返回 `{ book, asOf, stale }`（stale = 距上次更新超过 `bookStaleMs`，默认 15 s）；`refreshBook(id, { maxWaitMs })` 是快照缺失 / 陈旧时的 REST 兜底：同一标的最少间隔 `bookRefreshMinMs`（默认 2 s），预算不够最多等 `maxWaitMs`（默认 1 s）就放弃并原样返回现有快照，**不排队阻塞**。TODO(protocol): 这两个是 `VenueConnector` 之外的可选方法。

## 交易

- 数值一律十进制字符串；价格 ≤5 位有效数字且小数位 ≤ 6 − szDecimals（整数恒合法），数量向零截断；价格不合法 → `1002 PRECISION`，除非意图带 `rounding: "passive"`（买单向下、卖单向上）。已和官方 SDK `formatPrice` 做过 3000 组随机对拍。
- 签名一律走内核给的 `signTypedData` 句柄，每次签名回调 `onSigned({ purpose, digest, signer, ts })`（只有载荷摘要，供内核写账本 `signer.signed`）。**每个 API 钱包独立 nonce**（毫秒时间戳、单调递增）。
- 上游报错原话进 `problem.venue.message`，不翻译、不改写；结果未知（发出后没拿到响应）→ `status: "unknown"` + `3006`，**绝不自动重发**，先 `orderStatus({ clientOrderId })`。
- 订单期限只在收到有效 HTTP `Date` 头时估算场所时钟偏差：用请求发送和接收时刻的中点计算，并将实测偏差加到期限上；不额外添加 30 s。HTTP `Date` 只有秒级精度，缺失或无效时沿用最后一次有效偏差（从未测得则按 0）。大偏差警告按十分钟限频；偏差回到 ±10 s 阈值内会复位，之后再次越界会重新警告。
- `approveAgent` / `approveBuilderFee` 只生成 EIP-712 待签载荷与说明（`buildApproveAgent` / `buildApproveBuilderFee`），由主钱包在系统浏览器签；`toExchangePayload()` 拼出提交体。
- 启动对账：`startupSnapshot(ref, fillsSince)` = 挂单 + 账户（账户模式感知）+ 成交回补；比对与保持 `HALTED` 由内核决定。
- 地址额度诊断是进程内会话估计：初值 10000，按已观察 userFills 的 USDC 成交额增加；撤单使用场所规则对应的较高估计上限。`http.addressBudget.usage(address)` 只返回动作计数、十进制成交量/估计上限和 `incomplete: true`。数据不持久化，未读取的历史成交和其它客户端消费未知，因此它不是场所真实余额或限流器，也不阻断写请求。

### Builder Code（「支持开发者」，默认关闭）

产品纯免费：`supportDeveloper` 默认 **false**，此时订单**永远不带 builder 字段**，也不会生成 `approveBuilderFee` 载荷（`buildApproveBuilderFee()` 要求显式 `supportDeveloper: true`，否则抛错）。用户在设置里打开后，且配置了收费地址、账户 `builder.status === "approved"`，订单才附 `{ b: <小写地址>, f: 10 }`——`f` 的单位是**十分之一个基点**，10 = 1 bp = 0.01%（`maxFeeRate: "0.01%"`）。未授权 / 未知时照常下单、不带 builder。收费地址须是 standard 账户模式且 ≥100 USDC。

## 测试

`npm test`（离线：`fixtures/hl/` + 假 fetch + 假 WebSocket + 随机测试密钥，全在内存，不落盘）。签名对拍：EIP-712 规范 Mail 示例（校验测试签名器）+ **官方 Python SDK 的 L1 动作已知签名向量**（r / s / v 逐位一致）+ approveAgent / approveBuilderFee 与 SDK `signUserSignedAction` 逐字节一致。基准：`node bench/connector/run.mjs`。

## 没验过的

没有对真实测试网 / 主网下过单；账户模式在 unified / portfolio 下的保证金口径只按文档推导，没有对真账户核对；触发市价单的 `p` 字段（取触发价）、仓位级 TP/SL 子单数量、改单后订单号变化、`scheduleCancel` 刷新是否计入每日 10 次，都未经场所验证。
