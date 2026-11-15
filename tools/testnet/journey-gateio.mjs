// SPDX-License-Identifier: CPAL-1.0
// Gate.io USDT 永续 · 测试网（https://api-testnet.gateapi.io）旅程入口。
// 只在测试网跑：environment 恒为 testnet；密钥只读 GATE_TESTNET_API_KEY / GATE_TESTNET_API_SECRET。
// 本包 amend 能力位是 none：改单一步会如实标 skipped。
import { pathToFileURL } from 'node:url'
import { runCli } from './lib/cli.mjs'
import { connectorEntry, loadBundle } from './lib/load-connector.mjs'
import { venueSpec } from './lib/venues.mjs'

export const venue = 'gateio'
export const spec = venueSpec(venue)

/** 真跑用的连接器工厂：把本仓 TS 源码用 esbuild 打成临时 ESM 再实例化（见 lib/load-connector.mjs）。 */
export async function createConnector({ credentials, environment, baseUrl, instrumentId, fetchImpl, clock }) {
  const { connector } = await loadBundle({ connector: connectorEntry(venue) })
  const options = {
    environment,
    baseUrl,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    // Gate 不用 defaultSymbol：查单按本进程记下的合约缩小扫描范围。
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
    onWarn: () => {},
  }
  return new connector.GateioTradeConnector(options)
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli({ spec, argv, createConnector, deps })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
