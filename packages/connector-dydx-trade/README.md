未经真网验证，不得接实盘；注册进内核由主会话另行决定。（许可证：CPAL-1.0）

# @gitrader/connector-dydx-trade

dYdX v4 **永续交易**连接器：`DydxTradeConnector implements VenueConnector`。下单是真的链上交易（protobuf + secp256k1 签名），
签名只用 Node 内置 `node:crypto`，**零第三方依赖**（不用 viem / cosmjs / protobufjs）。

## 边界（先读）

- **只新建**：不注册进 CLI / 内核；不碰 `packages/connector-dydx-data`（只读行情，按下面的方式复用）。
- **只支持单向持仓、全仓**：`marginModes: ['cross']`、`positionMode: ['oneWay']`；逐仓 / 双向持仓在链上有消息，但本包未接线。
- **链上手续费未在真网核实**：短单（市价 / IOC）发空手续费（gas 0）；**长单（gtc / post-only / 条件单）必须由调用方注入 `fee`**，
  没配就拒绝（`INVALID_PARAMS`），不猜金额。
- **不能自动重试写请求**：广播超时 / 5xx / 断连一律 3006（`VENUE_OUTCOME_UNKNOWN`），先按 clientOrderId 对账。
- 账户读依赖 Indexer，行情依赖注入的行情源；不注入行情源时 `book/candles/context` 回 1004、`listInstruments` 回空数组。

## 端点（官方文档为准）

| 用途 | 端点 |
| --- | --- |
| 广播交易 | `POST {node}/cosmos/tx/v1beta1/txs`（`{tx_bytes, mode}`，一律 `BROADCAST_MODE_SYNC`；cosmos-sdk v0.50 只支持 sync / async） |
| 账户号 / 序列号 | `GET {node}/cosmos/auth/v1beta1/accounts/{address}` |
| 当前块高 | `GET {node}/cosmos/base/tendermint/v1beta1/blocks/latest`（短单 `good_til_block = 块高 + 20`） |
| 子账户 | `GET {indexer}/v4/addresses/{address}/subaccountNumber/{n}` |
| 持仓 | `GET {indexer}/v4/perpetualPositions?address=&subaccountNumber=&status=OPEN` |
| 挂单 | `GET {indexer}/v4/orders?address=&subaccountNumber=&status=`（裸数组；OPEN 与 UNTRIGGERED 各拉一次后合并） |
| 单笔订单 | `GET {indexer}/v4/orders/{orderId}`（不存在回 404） |
| 成交 | `GET {indexer}/v4/fills?address=&subaccountNumber=&limit=` |
| 市场参数 | `GET {indexer}/v4/perpetualMarkets`（`atomicResolution / quantumConversionExponent / stepBaseQuantums / subticksPerTick / oraclePrice`） |

节点与 Indexer 基址都可注入（`nodeBaseUrl` / `indexerBaseUrl`）；缺省是公开主网 / 测试网地址，**没有真网验证**。

## 签名（SIGN_MODE_DIRECT）

1. 32 字节私钥 → PKCS#8 DER（手写 ASN.1 包装，含 secp256k1 OID）→ `createPrivateKey`，公钥由 OpenSSL 派生；
2. 地址 = `bech32('dydx', ripemd160(sha256(压缩公钥 33 字节)))`（Cosmos 口径，同 cosmjs `rawSecp256k1PubkeyToRawAddress`，Node 内置 `sha256` + `ripemd160`）；
3. `SignDoc { body_bytes, auth_info_bytes, chain_id, account_number }` → `sha256` → ECDSA（64 字节 `r||s`，低 S 归一化）；
4. `TxRaw { body_bytes, auth_info_bytes, signatures }` → base64 → 广播；交易哈希 = `sha256(TxRaw)`。

签名器与私钥：私钥只存在 `DydxSigner` 的 `#` 私有字段；`JSON.stringify(connector)`、`util.inspect`、错误文本都不含私钥（有测试）。

**踩过的坑（写进测试）**：`crypto.sign(null, digest)` 会让 OpenSSL 再套一层默认摘要，链上验不过；必须 `crypto.sign('sha256', signDoc)`。
压缩公钥前缀取 Y 的**末**字节最低位（`y[31] & 1`），取错会让验签全失败。

## 订单映射

| Gitrader 意图 | dYdX 消息 | order_flags | TIF |
| --- | --- | --- | --- |
| `market`（按 `maxSlippageBps` 做价带） | Order + 限价 + IOC | 0 短单 | IOC(1) |
| `limit` + `tif: ioc` | 同上 | 0 短单 | IOC(1) |
| `limit`（缺省 gtc） | Order + `good_til_block_time` | 64 长单 | UNSPECIFIED(0)=GTC |
| `limit` + `postOnly` / `tif: alo` | Order | 64 长单 | POST_ONLY(2) |
| `limit` + `tif: gtd` + `expiresAt` | Order + 指定到期时间 | 64 长单 | GTC |
| `stop_market` / `stop_limit` | `condition_type = STOP_LOSS(1)` + 触发 subticks | 32 条件单 | IOC / GTC |
| `take_market` / `take_limit` | `condition_type = TAKE_PROFIT(2)` | 32 条件单 | IOC / GTC |
| `trailing_stop` / `twap` / `tif: fok` / 带 `tpsl` | — | — | 1004 |

- **数量**：`quantums = size × 10^(-atomicResolution)`；缺省（`rounding: 'reject'`）要求是 `stepBaseQuantums` 的整数倍，否则 `INVALID_PARAMS`
  （消息里写 step 大小）；`rounding: 'passive'` 时向下截到 step；结果小于一个 step 两种模式都拒。按 `notional` 折出来的数量一律向下截
  到 step（同样小于一个 step 就拒）。全部走 `@gitrader/protocol` 的定点十进制，不碰浮点。
- **价格**：`subticks = price × 10^(-(atomicResolution - quantumConversionExponent + 6))`；缺省要求是 `subticksPerTick` 的整数倍，
  否则 `INVALID_PARAMS`；`'passive'` 时买单向下、卖单向上取到 tick；结果小于一个 tick 也拒。
  市价按 `maxSlippageBps` 从**预言机价**放宽成价带（缺 `maxSlippageBps` → `INVALID_PARAMS`），价带取整买单向下、卖单向上（落在带内）。
- **触发**：dYdX 条件单按**预言机价**触发，`triggerType` 只接受 `mark`，其它值明确拒绝。
- **client id 与单号**：内核给的 32 位十六进制 clientOrderId 取前 8 位转 `client_id`，同账户碰撞时顺延（`ClientIdAllocator`）。
  场所单号（`venueOrderId`）= Indexer 的订单 UUID：`subaccountId = uuidv5('<address>-<subaccountNumber>')`，
  `orderId = uuidv5('<subaccountId>-<clientId>-<clobPairId>-<orderFlags>')`，namespace `0f9da948-a6fb-4c45-9edc-4685c3f3317d`；
  来源是 v4-chain `indexer/packages/postgres/src/helpers/uuid.ts`、`stores/subaccount-table.ts`、`stores/order-table.ts`。
  挂单 / 成交行的 `clientOrderId` 由进程内映射从该 UUID 反查，未知写 `null`。
- **撤单**：`MsgCancelOrder` 逐单发；短单带块高、长单带 `good_til_block_time`。`cancelAll` 是逐单撤（能力位 `emulated`）。
- **amend / setLeverage / scheduleCancel**：链上无对应消息或本包未接线，一律 1004。

## 与只读行情连接器的接法（不改它）

`@gitrader/connector-dydx-data` 已入库，本包按结构类型复用（`DydxMarketSource`）：

```ts
const market = new DydxDataConnector({ fetchImpl })
await market.start() // 行情源自己拉一次市场表
const conn = new DydxTradeConnector({ privateKey, environment: 'testnet', market })
```

交易所需的 `marketParams`（quantums / subticks 换算）由本包直接读 `/v4/perpetualMarkets`，不从行情包拿（它不暴露这些字段）。

## 已知限制（如实写）

1. **未经真网验证**：主网 / 测试网的 endpoint、gas、手续费金额、条件单触发口径都没有实盘核对过。
2. Indexer 私有成交不给单笔已实现盈亏，`VenueFill.realizedPnl` 写 `0`；持仓里的 `realizedPnl` 是真实值。
3. Indexer 子账户视图不保证给每仓杠杆，缺失时 `Position.leverage` 写 `0`（未知，不是「零倍」）。
4. 成交去重键优先 `fill.id`；缺失时回退 `${orderId}:${height}:${size}:${price}`，同一块同单同价同量多笔会撞键（会丢成交）——真网核实前用 `id`。
5. 逐仓、双向持仓、TWAP、trailing、附加止盈止损（O2CO）未实现；`leverage` 变更未接线。
6. 一次交易只放一条消息（`batch.maxOrders = 1`）；多消息同 tx 未验证。
7. 进程重启后 `client_id` 映射丢失：按 clientOrderId 查单会回退到「前 8 位推出 client_id + 拉挂单列表匹配」，碰撞顺延无法还原，
   碰撞时可能认错单；对账与撤单优先用 `openOrders()` 给的 `venueOrderId`。

## 测试（全离线）

```bash
../../node_modules/.bin/vitest run --config ../../vitest.config.ts --root .
../../node_modules/.bin/tsc -p . --noEmit
```

假链节点（`test/helpers/fake-dydx.ts`）独立实现：用自己的 TLV 读取器解 `TxRaw`，用 `node:crypto` 的 `verify` 复算
`sha256(SignDoc)` 验签，用 `ripemd160(sha256(压缩公钥))` + 自带的 bech32 算地址并逐条比对 `OrderId.owner`（不一致回 code 4），
校验 `quantums % stepBaseQuantums == 0`、`subticks % subticksPerTick == 0`、`client_metadata ≤ 127`、短单带块高 / 长单带 fixed32
时间戳、`TxExtension` 存在、`chain_id` 与 `account_number` 与账本一致；`BROADCAST_MODE_BLOCK` 回 HTTP 500（v0.50 的行为）。
