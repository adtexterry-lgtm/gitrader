// SPDX-License-Identifier: CPAL-1.0
// 场所注册表：venue 名 → 只读数据连接器（packages/connector-<venue>-data 的导出类）。
// 只做行情：这里能构造出来的连接器 describe() 全是交易能力 none（只读数据源）。
// 连接器是 TS 源码，靠 lib/ts-shim.mjs 的解析钩子直接 import；模块按场所缓存，重复构造只解析一次。
export const VENUES = {
  binance: { pkg: '@gitrader/connector-binance-data', ctor: 'BinanceDataConnector', baseUrl: 'https://fapi.binance.com' },
  bitget: { pkg: '@gitrader/connector-bitget-data', ctor: 'BitgetDataConnector', baseUrl: 'https://api.bitget.com' },
  bybit: { pkg: '@gitrader/connector-bybit-data', ctor: 'BybitDataConnector', baseUrl: 'https://api.bybit.com' },
  coinbase: { pkg: '@gitrader/connector-coinbase-data', ctor: 'CoinbaseDataConnector', baseUrl: 'https://api.coinbase.com' },
  deribit: { pkg: '@gitrader/connector-deribit-data', ctor: 'DeribitDataConnector', baseUrl: 'https://www.deribit.com' },
  dydx: { pkg: '@gitrader/connector-dydx-data', ctor: 'DydxDataConnector', baseUrl: 'https://indexer.dydx.trade' },
  gateio: { pkg: '@gitrader/connector-gateio-data', ctor: 'GateioDataConnector', baseUrl: 'https://api.gateio.ws' },
  kraken: { pkg: '@gitrader/connector-kraken-data', ctor: 'KrakenDataConnector', baseUrl: 'https://futures.kraken.com' },
  kucoin: { pkg: '@gitrader/connector-kucoin-data', ctor: 'KucoinDataConnector', baseUrl: 'https://api-futures.kucoin.com' },
  okx: { pkg: '@gitrader/connector-okx-data', ctor: 'OkxDataConnector', baseUrl: 'https://www.okx.com' },
}

/** 支持的场所名（README 与用法提示共用）。 */
export const VENUE_NAMES = Object.keys(VENUES).sort()

const modules = new Map()

/**
 * 构造只读连接器。opts 原样传给连接器构造器（fetchImpl / baseUrl / pollMs …）；
 * 缺省走各包自己的 fetch 与官方基址（也就是真实联网的那条路）。
 */
export async function createConnector(venue, opts = {}) {
  const spec = VENUES[venue]
  if (!spec) throw new Error(`unknown venue: ${JSON.stringify(venue)}; supported: ${VENUE_NAMES.join(', ')}`)
  let mod = modules.get(spec.pkg)
  if (!mod) {
    mod = await import(spec.pkg)
    modules.set(spec.pkg, mod)
  }
  const Ctor = mod[spec.ctor]
  if (typeof Ctor !== 'function') throw new Error(`${spec.pkg} does not export ${spec.ctor}`)
  return new Ctor(opts)
}

/** 连接器自报的历史数据能力（分页上限以各包 describe() 为准）。 */
export function historyOf(connector) {
  const caps = typeof connector.describe === 'function' ? connector.describe() : undefined
  const history = caps?.history
  const pageLimit = Number.isFinite(history?.pageLimit) && history.pageLimit > 0 ? Math.floor(history.pageLimit) : undefined
  const maxCandles = Number.isFinite(history?.maxCandles) && history.maxCandles > 0 ? Math.floor(history.maxCandles) : undefined
  return { ...(pageLimit === undefined ? {} : { pageLimit }), ...(maxCandles === undefined ? {} : { maxCandles }) }
}

/** 尽最大努力关掉连接器（连接器没实现 close 或 close 抛错都不影响收尾）。 */
export async function closeConnector(connector) {
  if (typeof connector?.close !== 'function') return
  try {
    await connector.close()
  } catch {
    /* 收尾失败不影响已落盘的文件 */
  }
}
