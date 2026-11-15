// SPDX-License-Identifier: CPAL-1.0
// Alpaca 美股 · 模拟盘（paper-api.alpaca.markets）旅程入口。
// 只在模拟盘跑：environment 恒为 testnet（→ 连接器 mode=paper），没有 --environment 这种参数，跑不到实盘。
// 密钥只读 ALPACA_PAPER_API_KEY / ALPACA_PAPER_API_SECRET；前缀 PK=模拟、AK=实盘
// （QD alpaca_trading/README.md:27-30）：前缀与 paper 不符时连接器在**构造期**拒绝（本脚本如实转成退出码 1）。
// 密钥不打印、不落盘、不进 argv；错误文本经 lib/journey.mjs 的 createRedactor 脱敏。
import { pathToFileURL } from 'node:url'
import { runCli } from './lib/cli.mjs'
import { connectorEntry, loadBundle } from './lib/load-connector.mjs'

export const venue = 'alpaca'

/**
 * 场所参数（cli.mjs 只读这些字段）。基址出处：QD `alpaca_trading/README.md:27-30`
 * （paper = paper-api.alpaca.markets）+ 包 `src/constants.ts` 的 TRADING_BASE_URLS / DATA_BASE_URL。
 */
export const spec = {
  venue,
  label: 'Alpaca 美股（模拟盘 paper）',
  environment: 'testnet',
  mode: '模拟盘 paper（paper-api.alpaca.markets；密钥前缀 PK）',
  baseUrl: 'https://paper-api.alpaca.markets',
  hosts: ['paper-api.alpaca.markets', 'data.alpaca.markets'],
  defaultAccountId: 'acct_01TESTNET',
  // 美股：标的用裸 ticker，协议 id 是 `alpaca:<ticker>`（包 src/assets.ts 的 normalizeSymbol）。
  defaultInstrumentId: 'alpaca:AAPL',
  // 现金流股票没有最小名义额门槛，1 股就是「极小单」；碎股只在标的 fractionable 时才收，缺省不用碎股。
  defaultSize: '1',
  credentials: [
    { env: 'ALPACA_PAPER_API_KEY', field: 'apiKey' },
    { env: 'ALPACA_PAPER_API_SECRET', field: 'apiSecret' },
  ],
  baseUrlSource: 'QD alpaca_trading/README.md:27-30（paper / live 基址）；包 README「端点出处」+ src/constants.ts',
}

/**
 * 旅程第 4 步是**同步**的 `getInstrument()`，而 Alpaca 的标的目录是按需单张拉取的（`GET /v2/assets/{symbol}`，
 * 包 `src/catalog.ts:63` 的 `ensure()`；`warmAssets()` 只是把整表预热）。所以启动时先把目标标的拉进缓存，
 * 否则旅程会在 instrument 一步报「not in the venue catalogue」——那是脚本没预热，不是场所缺标的。
 * 拉取失败就让 connect 一步如实失败（带上游 Problem），不吞。
 */
function withAssetWarmup(connector, instrumentId) {
  return new Proxy(connector, {
    get(target, prop) {
      if (prop === 'start') {
        return async () => {
          await target.start()
          await target.assets.ensure(instrumentId)
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/**
 * 真跑用的连接器工厂：把本仓 TS 源码用 esbuild 打成临时 ESM 再实例化（见 lib/load-connector.mjs）。
 * @param {object} params  cli.mjs 传来的 { credentials, environment, baseUrl, instrumentId, fetchImpl, clock }
 */
export async function createConnector({ credentials, environment, baseUrl, instrumentId, fetchImpl, clock }) {
  if (environment !== 'testnet') {
    throw new Error(`journey-alpaca only runs on the paper environment (environment must be testnet, got ${String(environment)})`)
  }
  const { connector } = await loadBundle({ connector: connectorEntry(venue) })
  const instance = new connector.AlpacaTradeConnector({
    // 模拟 / 实盘不许混：环境在这里写死 paper；密钥前缀 PK/AK 由连接器在构造期校验（rest.ts assertModeMatchesKey）。
    mode: 'paper',
    baseUrl,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
    // 连接器的告警里可能出现标的 / 时段信息，统一吞掉：回执表才是这里的唯一输出。
    onWarn: () => {},
  })
  return withAssetWarmup(instance, instrumentId)
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli({ spec, argv, createConnector, deps })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
