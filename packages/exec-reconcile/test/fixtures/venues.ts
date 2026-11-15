// SPDX-License-Identifier: CPAL-1.0
// 真实回报形状夹具（只读抄形状，不抄逻辑）。
//
// 取值来源（各包 test/ 下的假服务器与解析用例，逐条注明）：
//   hyperliquid  packages/connector-hyperliquid/test/account.test.ts:132-145（openOrders / userFills 行，oid 5、tid 101、cloid 0xAA…）
//   binance      packages/connector-binance-trade/test/account.test.ts:156-166（orderId 4001 / 1001、clientOrderId 'gt-algo-1'、userTrades id 1）
//   okx          packages/connector-okx-trade/test/account.test.ts:44-49,85,113,239（ordId '3122698'、tradeId '77'、cz 张 × ctVal 0.01）
//   bybit        packages/connector-bybit-trade/test/account.test.ts:75-77,134-136,207-212,268-270（orderId 'ord-2001'、execId 'exec-1'）
//   bitget       packages/connector-bitget-trade/test/account.test.ts:126,193-196,211（orderId '7001'、tradeId 't-1'、clientOid 'c1'）
//   gateio       packages/connector-gateio-trade/test/account.test.ts:83-87,95-101（venueOrderId '7001'、clientOrderId 't-open-1'、left 折币、venueFillId '90002'）
//   alpaca       packages/connector-alpaca-trade/test/account.test.ts:188-236、parse.ts:381-404（venueFillId = `<order_id>:<cum_qty>`）
//   ibkr         packages/connector-ibkr-trade/src/account.ts:321（venueOrderId = permId）、test/account.test.ts:292（断言 '5001'）、
//                test/reference-wire.test.ts:251（execId '0000e1a7.6713b2c4.01.01'）、account.test.ts:205（orderRef）
//
// 这里只放「场所会这么回」的形状与值：状态用上游原话，数量按各连接器折算后的口径（基础资产单位）。
// 各场所的 open / history / fill / local 共用同一组单号与标的（编号取值照上游，只是把不同夹具行归到同一张逻辑单上），
// 这样「同一张单」的挂单 / 历史 / 成交 / 持仓才能互相对上。
import type {
  LocalOrderView, LocalPositionView, VenueFillView, VenueOrderView, VenuePositionView,
} from '../../src/types'
import { NOW, localOrder, venueFill, venueOpen } from '../helpers'

export interface VenueShape {
  name: string
  instrumentId: string
  sourceNote: string
  open: (over?: Partial<VenueOrderView>) => VenueOrderView
  history: (status: string, over?: Partial<VenueOrderView>) => VenueOrderView
  fill: (over?: Partial<VenueFillView>) => VenueFillView
  position: (over?: Partial<LocalPositionView>) => VenuePositionView
  local: (over?: Partial<LocalOrderView>) => LocalOrderView
}

const positionOf = (p: LocalPositionView): VenuePositionView => ({ ...p })

export const hyperliquid: VenueShape = {
  name: 'hyperliquid',
  instrumentId: 'hyperliquid:BTC',
  sourceNote: 'connector-hyperliquid/test/account.test.ts:132-145',
  open: (over = {}) => venueOpen({
    venueOrderId: '5', clientOrderId: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', instrumentId: 'hyperliquid:BTC',
    side: 'buy', type: 'Limit', size: '0.01', origSize: '0.02', price: '79000.0', status: 'open', createdAt: NOW - 1_000, ...over,
  }),
  history: (status, over = {}) => venueOpen({
    venueOrderId: '5', clientOrderId: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', instrumentId: 'hyperliquid:BTC',
    source: 'history', status, size: '0', origSize: '0.02', filledSize: '0.02', price: '79000.0', ...over,
  }),
  fill: (over = {}) => venueFill({
    venueFillId: '101', venueOrderId: '5', clientOrderId: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    instrumentId: 'hyperliquid:BTC', side: 'buy', price: '80000.0', size: '0.01', fee: '0.36', ts: NOW - 5, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'hyperliquid:BTC', side: 'long', size: '0.01', entryPrice: '80000', marginMode: 'cross', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'hl-o1', clientOrderId: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', venueOrderId: '5',
    instrumentId: 'hyperliquid:BTC', side: 'buy', price: '79000.0', size: '0.02', ...over,
  }),
}

export const binance: VenueShape = {
  name: 'binance',
  instrumentId: 'binance:BTCUSDT',
  sourceNote: 'connector-binance-trade/test/account.test.ts:156-166',
  open: (over = {}) => venueOpen({
    venueOrderId: '4001', clientOrderId: 'gt-algo-1', instrumentId: 'binance:SOLUSDT',
    side: 'buy', type: 'LIMIT', size: '0.01', origSize: '0.01', filledSize: '0', price: '100', status: 'NEW', createdAt: NOW - 2_000, ...over,
  }),
  history: (status, over = {}) => venueOpen({
    venueOrderId: '4001', clientOrderId: 'gt-algo-1', instrumentId: 'binance:SOLUSDT', source: 'history',
    status, size: '0', origSize: '0.01', filledSize: '0.01', price: '100', ...over,
  }),
  fill: (over = {}) => venueFill({
    venueFillId: '1', venueOrderId: '4001', clientOrderId: 'gt-algo-1', instrumentId: 'binance:SOLUSDT',
    side: 'buy', price: '100', size: '0.001', ts: NOW - 10_000, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'binance:BTCUSDT', side: 'long', size: '0.01', entryPrice: '99000', marginMode: 'cross', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'bn-o1', clientOrderId: 'gt-algo-1', venueOrderId: '4001', instrumentId: 'binance:SOLUSDT',
    side: 'buy', price: '100', size: '0.01', ...over,
  }),
}

export const okx: VenueShape = {
  name: 'okx',
  instrumentId: 'okx:BTC-USDT-SWAP',
  sourceNote: 'connector-okx-trade/test/account.test.ts:44-49,85,113,239',
  open: (over = {}) => venueOpen({
    venueOrderId: '3122698', clientOrderId: 'gtopen1', instrumentId: 'okx:BTC-USDT-SWAP',
    side: 'buy', type: 'limit', size: '0.03', origSize: '0.05', filledSize: '0.02', price: '99000', status: 'live', createdAt: NOW - 3_000, ...over,
  }),
  history: (status, over = {}) => venueOpen({
    venueOrderId: '3122698', clientOrderId: 'gtopen1', instrumentId: 'okx:BTC-USDT-SWAP', source: 'history',
    status, size: '0.03', origSize: '0.05', filledSize: '0.02', price: '99000', ...over,
  }),
  fill: (over = {}) => venueFill({
    venueFillId: '77', venueOrderId: '3122698', clientOrderId: 'gtopen1', instrumentId: 'okx:BTC-USDT-SWAP',
    side: 'buy', price: '100000', size: '0.02', fee: '-0.02', ts: NOW - 4_000, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'okx:BTC-USDT-SWAP', side: 'long', size: '0.02', entryPrice: '99000', marginMode: 'isolated', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'okx-o1', clientOrderId: 'gtopen1', venueOrderId: '3122698', instrumentId: 'okx:BTC-USDT-SWAP',
    side: 'buy', price: '99000', size: '0.05', ...over,
  }),
}

export const bybit: VenueShape = {
  name: 'bybit',
  instrumentId: 'bybit:BTCUSDT',
  sourceNote: 'connector-bybit-trade/test/account.test.ts:75-77,134-136,207-212,268-270',
  open: (over = {}) => venueOpen({
    venueOrderId: 'ord-2001', clientOrderId: 'gt-open-1', instrumentId: 'bybit:BTCUSDT',
    side: 'buy', type: 'Limit', size: '0.006', origSize: '0.01', filledSize: '0.004', price: '99000', status: 'New', createdAt: NOW - 5_000, ...over,
  }),
  history: (status, over = {}) => venueOpen({
    venueOrderId: 'ord-2001', clientOrderId: 'gt-open-1', instrumentId: 'bybit:BTCUSDT', source: 'history',
    status, size: '0', origSize: '0.01', filledSize: '0.01', price: '99000', ...over,
  }),
  fill: (over = {}) => venueFill({
    venueFillId: 'exec-1', venueOrderId: 'ord-2001', clientOrderId: 'gt-open-1', instrumentId: 'bybit:BTCUSDT',
    side: 'buy', price: '99000', size: '0.004', fee: '0.02', ts: NOW - 500, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'bybit:BTCUSDT', side: 'long', size: '0.01', entryPrice: '99000', marginMode: 'cross', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'bb-o1', clientOrderId: 'gt-open-1', venueOrderId: 'ord-2001', instrumentId: 'bybit:BTCUSDT',
    side: 'buy', price: '99000', size: '0.01', ...over,
  }),
}

export const bitget: VenueShape = {
  name: 'bitget',
  instrumentId: 'bitget:BTCUSDT',
  sourceNote: 'connector-bitget-trade/test/account.test.ts:126,193-196,211',
  open: (over = {}) => venueOpen({
    venueOrderId: '7001', clientOrderId: 'c1', instrumentId: 'bitget:BTCUSDT',
    side: 'buy', type: 'limit', size: '0.006', origSize: '0.01', filledSize: '0.004', price: '99000', status: 'live', createdAt: NOW - 1_000, ...over,
  }),
  history: (status, over = {}) => venueOpen({
    venueOrderId: '9001', clientOrderId: 'c1', instrumentId: 'bitget:BTCUSDT', source: 'history',
    status, size: '0', origSize: '0.01', filledSize: '0.01', price: '99000', ...over,
  }),
  fill: (over = {}) => venueFill({
    venueFillId: 't-1', venueOrderId: '7001', clientOrderId: 'c1', instrumentId: 'bitget:BTCUSDT',
    side: 'buy', price: '99000', size: '0.004', ts: NOW - 500, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'bitget:BTCUSDT', side: 'long', size: '0.01', entryPrice: '99000', marginMode: 'cross', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'bg-o1', clientOrderId: 'c1', venueOrderId: '7001', instrumentId: 'bitget:BTCUSDT',
    side: 'buy', price: '99000', size: '0.01', ...over,
  }),
}

export const gateio: VenueShape = {
  name: 'gateio',
  instrumentId: 'gateio:BTC_USDT',
  sourceNote: 'connector-gateio-trade/test/account.test.ts:83-87,95-101',
  open: (over = {}) => venueOpen({
    venueOrderId: '7001', clientOrderId: 't-open-1', instrumentId: 'gateio:BTC_USDT',
    side: 'buy', type: 'limit', size: '0.004', origSize: '0.01', filledSize: '0.006', price: '99000', status: 'open', createdAt: NOW - 800, ...over,
  }),
  // Gate 的历史订单状态是 finished + finish_as（filled / cancelled），连接器拼成 "finished/<finish_as>"
  history: (status, over = {}) => venueOpen({
    venueOrderId: '7001', clientOrderId: 't-open-1', instrumentId: 'gateio:BTC_USDT', source: 'history',
    status, size: '0', origSize: '0.01', filledSize: '0.01', price: '99000', ...over,
  }),
  fill: (over = {}) => venueFill({
    venueFillId: '90002', venueOrderId: '7001', clientOrderId: 't-open-1', instrumentId: 'gateio:BTC_USDT',
    side: 'buy', price: '99000', size: '0.006', ts: NOW - 1_200, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'gateio:BTC_USDT', side: 'long', size: '0.01', entryPrice: '99000', marginMode: 'cross', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'gt-o1', clientOrderId: 't-open-1', venueOrderId: '7001', instrumentId: 'gateio:BTC_USDT',
    side: 'buy', price: '99000', size: '0.01', ...over,
  }),
}

export const alpaca: VenueShape = {
  name: 'alpaca',
  instrumentId: 'alpaca:AAPL',
  sourceNote: 'connector-alpaca-trade/test/account.test.ts:188-236 + parse.ts:381-404',
  open: (over = {}) => venueOpen({
    venueOrderId: 'ord-a', clientOrderId: 'gt-alpaca-1', instrumentId: 'alpaca:AAPL',
    side: 'buy', type: 'limit', size: '3', origSize: '5', filledSize: '2', price: '190.15', status: 'partially_filled', createdAt: NOW - 2_000, ...over,
  }),
  history: (status, over = {}) => venueOpen({
    venueOrderId: 'ord-a', clientOrderId: 'gt-alpaca-1', instrumentId: 'alpaca:AAPL', source: 'history',
    status, size: '0', origSize: '5', filledSize: '5', price: '190.15', avgFillPrice: '190.20', ...over,
  }),
  // venueFillId = `<order_id>:<累计成交量>`（REST 与私有流共用这个键）
  fill: (over = {}) => venueFill({
    venueFillId: 'ord-a:2', venueOrderId: 'ord-a', clientOrderId: 'gt-alpaca-1', instrumentId: 'alpaca:AAPL',
    side: 'buy', price: '190.15', size: '2', ts: NOW - 1_500, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'alpaca:AAPL', side: 'long', size: '5', entryPrice: '190.2', marginMode: 'cross', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'ap-o1', clientOrderId: 'gt-alpaca-1', venueOrderId: 'ord-a', instrumentId: 'alpaca:AAPL',
    side: 'buy', price: '190.15', size: '5', ...over,
  }),
}

export const ibkr: VenueShape = {
  name: 'ibkr',
  instrumentId: 'ibkr:AAPL',
  sourceNote: 'connector-ibkr-trade/src/account.ts:321 + test/account.test.ts:292',
  open: (over = {}) => venueOpen({
    venueOrderId: '5001', clientOrderId: 'REF', instrumentId: 'ibkr:AAPL',
    side: 'buy', type: 'LMT', size: '100', origSize: '100', filledSize: '0', price: '190.15', status: 'Submitted', createdAt: NOW - 4_000, ...over,
  }),
  // openOrder / orderStatus 的原话：PendingSubmit / PreSubmitted / Submitted / Filled / Cancelled / ApiCancelled / Inactive
  history: (status, over = {}) => venueOpen({
    venueOrderId: '5001', clientOrderId: 'REF', instrumentId: 'ibkr:AAPL', source: 'history',
    status, size: '0', origSize: '100', filledSize: '100', price: '190.15', avgFillPrice: '190.20', ...over,
  }),
  fill: (over = {}) => venueFill({
    venueFillId: '0000e1a7.6713b2c4.01.01', venueOrderId: '5001', clientOrderId: 'REF', instrumentId: 'ibkr:AAPL',
    side: 'buy', price: '190.20', size: '100', fee: '1.00', ts: NOW - 1_000, ...over,
  }),
  position: (over = {}) => positionOf({ instrumentId: 'ibkr:AAPL', side: 'long', size: '100', entryPrice: '190.2', marginMode: 'cross', ...over }),
  local: (over = {}) => localOrder({
    orderId: 'ib-o1', clientOrderId: 'REF', venueOrderId: '5001', instrumentId: 'ibkr:AAPL',
    side: 'buy', price: '190.15', size: '100', ...over,
  }),
}

export const ALL_VENUES: readonly VenueShape[] = [hyperliquid, binance, okx, bybit, bitget, gateio, alpaca, ibkr]
