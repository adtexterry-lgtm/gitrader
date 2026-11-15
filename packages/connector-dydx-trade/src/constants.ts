// SPDX-License-Identifier: CPAL-1.0
// dYdX v4 交易连接器的常量表。端点与字段编号都以官方文档 / 官方 proto 为准（工单教训 1）：
//   · 交易广播走链节点 Cosmos LCD：POST /cosmos/tx/v1beta1/txs（docs.dydx.xyz/interaction/send-tx）。
//   · 账户 / 订单 / 成交 / 持仓读 Indexer 私有 REST（docs.dydx.xyz/indexer-client/http）；Indexer 限流 100 请求 / 10 s 每 IP
//     （docs.dydx.xyz/concepts/trading/limits/rate-limits）。
//   · 链上数据结构：dydxprotocol/clob/order.proto、clob/tx.proto、subaccounts/subaccount.proto（v4-chain main）；
//     Cosmos 交易封装：cosmos/tx/v1beta1/tx.proto（SignDoc / TxBody / AuthInfo / TxRaw）。

/** 场所 id（与 @gitrader/connector-dydx-data 一致，内核据此把行情与交易配到一起）。 */
export const VENUE = 'dydx' as const

/** Indexer 主网 / 测试网基址（官方公开端点）。 */
export const INDEXER_BASE = { mainnet: 'https://indexer.dydx.trade', testnet: 'https://indexer.v4testnet.dydx.exchange' } as const
/** 链节点 LCD 基址。主网公开节点只作为缺省值，生产应注入自己的节点。 */
export const NODE_BASE = { mainnet: 'https://dydx-rest.publicnode.com', testnet: 'https://dydx-testnet-rest.publicnode.com' } as const

/** 链 id（network-constants）：签名域的一部分，错一个字符整笔交易被拒。 */
export const CHAIN_ID = { mainnet: 'dydx-mainnet-1', testnet: 'dydx-testnet-4' } as const

/** bech32 前缀。地址 = bech32('dydx', ripemd160(sha256(压缩公钥 33 字节)))（Cosmos 口径）。 */
export const BECH32_PREFIX = 'dydx'

/** Cosmos secp256k1 公钥曲线 OID（1.3.132.0.10）与 ecPublicKey OID，供 PKCS#8 包装用。 */
export const OID_EC_PUBLIC_KEY = '2a8648ce3d0201'
export const OID_SECP256K1 = '2b8104000a'

/** secp256k1 群阶（低 S 归一化用）。 */
export const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')

/** 短单窗口：短单（flags=0）在链上最多存活 20 个块（docs.dydx.xyz/concepts/trading/orders）。 */
export const SHORT_BLOCK_WINDOW = 20

/** order_flags 位值（clob/order.proto OrderId 注释）。 */
export const ORDER_FLAGS = { shortTerm: 0, conditional: 32, longTerm: 64, twap: 128 } as const

/** Order.Side 枚举。 */
export const ORDER_SIDE = { buy: 1, sell: 2 } as const

/** Order.TimeInForce 枚举：UNSPECIFIED 即 GTC（proto 里没有 GTC 值）；FOK 官方标 deprecated。 */
export const ORDER_TIF = { gtc: 0, ioc: 1, postOnly: 2 } as const

/** Order.ConditionType 枚举。 */
export const CONDITION_TYPE = { stopLoss: 1, takeProfit: 2 } as const

/** msg type URL（Any.type_url）。 */
export const TYPE_URL = {
  msgPlaceOrder: '/dydxprotocol.clob.MsgPlaceOrder',
  msgCancelOrder: '/dydxprotocol.clob.MsgCancelOrder',
  msgBatchCancel: '/dydxprotocol.clob.MsgBatchCancel',
  pubKey: '/cosmos.crypto.secp256k1.PubKey',
  txExtension: '/dydxprotocol.accountplus.TxExtension',
} as const

/** SignMode.SIGN_MODE_DIRECT。 */
export const SIGN_MODE_DIRECT = 1

/** Indexer 限流（每 IP）：100 请求 / 10 000 ms。 */
export const INDEXER_RATE_LIMIT = 100
export const INDEXER_RATE_WINDOW_MS = 10_000

/** Indexer 私有端点单页上限（/v4/fills 与 /v4/orders 的 limit）。 */
export const INDEXER_PAGE_LIMIT = 100

/** 链上账户查询：GET /cosmos/auth/v1beta1/accounts/{address}（拿 account_number / sequence）。 */
export const ACCOUNT_PATH = (address: string): string => `/cosmos/auth/v1beta1/accounts/${address}`
/** 广播：POST /cosmos/tx/v1beta1/txs。 */
export const BROADCAST_PATH = '/cosmos/tx/v1beta1/txs'
/** 当前块高：GET /cosmos/base/tendermint/v1beta1/blocks/latest（短单 good_til_block = 块高 + 20）。 */
export const LATEST_BLOCK_PATH = '/cosmos/base/tendermint/v1beta1/blocks/latest'

/** 条件单 / 长单的到期时间缺省给 90 天（长单必须给 good_til_block_time）。 */
export const DEFAULT_STATEFUL_DAYS = 90

/** 市价单缺省价带（bps）：intent 没给 maxSlippageBps 时拒绝（工单教训 4），这个值只用于能力声明。 */
export const DEFAULT_MARKET_BAND_BPS = 50
