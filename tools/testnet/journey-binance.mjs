// SPDX-License-Identifier: CPAL-1.0
// Binance USDⓈ-M 永续 · 测试网（https://demo-fapi.binance.com）旅程入口。只在测试网跑：
// environment 恒为 testnet；密钥只读 BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET。
// 真跑会访问 demo-fapi.binance.com（见 README）；不出网时用 test/journey-binance.test.mjs 的假服务器。
import { pathToFileURL } from 'node:url'
import { runCli } from './lib/cli.mjs'
import { connectorEntry, loadBundle } from './lib/load-connector.mjs'
import { nativeSymbolOf, venueSpec } from './lib/venues.mjs'

export const venue = 'binance'
export const spec = venueSpec(venue)

/** 真跑用的连接器工厂：把本仓 TS 源码用 esbuild 打成临时 ESM 再实例化（见 lib/load-connector.mjs）。 */
export async function createConnector({ credentials, environment, baseUrl, instrumentId, fetchImpl, clock }) {
  const { connector } = await loadBundle({ connector: connectorEntry(venue) })
  const options = {
    environment,
    baseUrl,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    defaultSymbol: nativeSymbolOf(instrumentId ?? spec.defaultInstrumentId),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
    onWarn: () => {},
  }
  return new connector.BinanceTradeConnector(options)
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli({ spec, argv, createConnector, deps })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
