// SPDX-License-Identifier: CPAL-1.0
// 包入口。README 首行有「未经真网验证」的边界声明；本包不注册进 CLI / 内核。
export { DydxTradeConnector, ClientIdAllocator, parseMarkets, planOrder, randomClientOrderId, receiptHashOf } from './trading'
export type { DydxTradeConnectorOptions, DydxMarketSource, MarketSnapshot, OrderPlan, PlanOptions } from './trading'
export { dydxTradeCapabilities } from './capabilities'
export type { CapabilityOptions } from './capabilities'
export { DydxHttp, unlimitedBudget } from './client'
export type { BudgetLike, DydxHttpOptions, FetchLike, FetchResponseLike, RequestResult } from './client'
export { DydxSigner, addressFromPublicKey, pkcs8FromRawKey, verifySha256, toHex, fromHex } from './keys'
export type { DydxAddress, SigningKeyInfo } from './keys'
export { quantumsFor, subticksFor, sizeFromQuantums, priceFromSubticks, priceBand, roundToMultiple, truncToMultiple, isOnTick, isOnStep } from './precision'
export type { MarketParams } from './precision'
export { encodeOrder, encodeOrderId, encodeSubaccountId, msgPlaceOrder, msgCancelOrder, msgBatchCancel, anyOf } from './msgs'
export type { OrderMessage, OrderIdParts } from './msgs'
export { signTransaction, encodeTxBody, encodeAuthInfo, encodeSignDoc, encodeTxRaw, broadcastRequestBody, parseSignDoc, sha256Hex } from './tx'
export type { FeeConfig, SignedTx, TxConfig, CoinAmount } from './tx'
export { parseAccount, parseFills, parseOrders, parsePositions, instrumentIdOf, tickerOf, uuidv5, indexerOrderId } from './account'
export {
  ProblemError, asProblem, throwAsProblem, redactSecret, DydxHttpError, DydxNetworkError, DydxTxError, invalidParams, unsupported, capabilityUnsupported,
} from './errors'
export {
  VENUE, CHAIN_ID, INDEXER_BASE, NODE_BASE, ORDER_FLAGS, ORDER_SIDE, ORDER_TIF, CONDITION_TYPE, TYPE_URL,
  SHORT_BLOCK_WINDOW, INDEXER_RATE_LIMIT, INDEXER_RATE_WINDOW_MS,
} from './constants'
export { bech32Encode, bech32Decode } from './bech32'
