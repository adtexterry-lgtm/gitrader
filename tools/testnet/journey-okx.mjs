// SPDX-License-Identifier: CPAL-1.0
// OKX USDT 永续 · 模拟盘（x-simulated-trading: 1，同一主机 www.okx.com）旅程入口。
// 只在模拟盘跑：environment 恒为 testnet；密钥只读 OKX_DEMO_API_KEY / OKX_DEMO_API_SECRET / OKX_DEMO_PASSPHRASE。
import { pathToFileURL } from 'node:url'
import { runCli } from './lib/cli.mjs'
import { connectorEntry, loadBundle } from './lib/load-connector.mjs'
import { venueSpec } from './lib/venues.mjs'

export const venue = 'okx'
export const spec = venueSpec(venue)

/** 真跑用的连接器工厂：把本仓 TS 源码用 esbuild 打成临时 ESM 再实例化（见 lib/load-connector.mjs）。 */
export async function createConnector({ credentials, environment, baseUrl, instrumentId, fetchImpl, clock }) {
  const { connector } = await loadBundle({ connector: connectorEntry(venue) })
  const options = {
    environment,
    baseUrl,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    passphrase: credentials.passphrase,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
    onWarn: () => {},
  }
  return new connector.OkxTradeConnector(options)
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli({ spec, argv, createConnector, deps })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
