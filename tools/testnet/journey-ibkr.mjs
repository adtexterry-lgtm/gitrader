// SPDX-License-Identifier: CPAL-1.0
// IBKR 美股 · 模拟盘（本机 TWS 7497 / IB Gateway 4002）旅程入口。
// 只在模拟盘跑：environment 恒为 testnet（→ 连接器 mode=paper）。连的是**本机** socket API，
// 只允许回环地址（非回环由连接器在构造期拒绝 → 本脚本退出码 1），不走 Client Portal Web API。
//
// 「密钥」：IBKR 的 socket API 没有 API key —— 凭据是 TWS / Gateway 里那个已登录的会话。
// 本脚本因此从环境变量读**连接参数**，缺任一项就退出码 3 且不建立任何连接：
//   IBKR_PAPER_PORT（模拟盘端口，照 QD ibkr_trading/README.md:13-18 端口表：TWS 7497 / Gateway 4002）
//   IBKR_ACCOUNT    （券商账户号，如 DU1234567；下单时随单发，回执与错误里一律脱敏）
// 端口与模式不许混：7496 / 4001 属于实盘，连接器构造期直接拒绝（allowCustomPort 也绕不过这一条）。
// 账户号不打印、不落盘、不进 argv；错误文本经 lib/journey.mjs 的 createRedactor 脱敏。
//
// 触发单用 `buy` 形状（spec.triggerShape = 'buy'：买入止损，触发价在参考价上方 40%，永不触发）：
// IB 股票没有原生 reduce-only，平仓的模拟账户上发卖出触发单 = 开空，被包的合规校验
// （packages/connector-ibkr-trade/src/compliance.ts，八条 5：不借券、不开空）按持仓前置拒单，
// 旅程会停在 place-trigger；买入止损是开多方向，场所规则允许，且同样不会成交。
import { pathToFileURL } from 'node:url'
import { runCli } from './lib/cli.mjs'
import { connectorEntry, loadBundle } from './lib/load-connector.mjs'
import { nativeSymbolOf } from './lib/venues.mjs'

export const venue = 'ibkr'

/** 自动化 / 策略固定 clientId 7（手动端固定 1；同一个 id 只允许一条连接，后连者踢先连者）。 */
export const CLIENT_ID = 7

/**
 * 场所参数（cli.mjs 只读这些字段）。端口表出处：QD `ibkr_trading/README.md:13-18`
 * + 包 `src/ids.ts` 的 IB_PORTS。`baseUrl` 这里只是主机：端口来自 IBKR_PAPER_PORT（也可用 --base-url 的端口覆盖）。
 */
export const spec = {
  venue,
  label: 'IBKR 美股（TWS / IB Gateway 模拟盘）',
  environment: 'testnet',
  mode: '模拟盘 paper（TWS 7497 / IB Gateway 4002；只连回环地址）',
  baseUrl: 'tcp://127.0.0.1',
  hosts: ['127.0.0.1:7497（TWS 模拟盘）', '127.0.0.1:4002（IB Gateway 模拟盘）'],
  defaultAccountId: 'acct_01TESTNET',
  // 美股：裸 ticker → 协议 id `ibkr:<ticker>`（包 src/ids.ts instrumentIdOf）。
  defaultInstrumentId: 'ibkr:AAPL',
  // IB 现金股票只收整数股（八条 4：不取整、不合规就拒），1 股即最小可用单；碎股一律不用。
  defaultSize: '1',
  // 触发单形状：买入止损（见文件头注释；其它五个场所缺省 sell）。
  triggerShape: 'buy',
  credentials: [
    { env: 'IBKR_PAPER_PORT', field: 'port' },
    { env: 'IBKR_ACCOUNT', field: 'account' },
  ],
  baseUrlSource: 'QD ibkr_trading/README.md:13-18 端口对应表；包 README「端口 / 环境对应」+ src/ids.ts IB_PORTS',
}

/** `tcp://127.0.0.1[:port]` / `127.0.0.1:port` / `localhost` → { host, port? }。 */
export function parseEndpoint(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { host: '127.0.0.1', port: undefined }
  const withScheme = /^(?:tcp|http|https):\/\/([^/:]+)(?::(\d+))?\/?$/i.exec(text)
  const bare = /^([^/:]+)(?::(\d+))?$/.exec(text)
  const match = withScheme ?? bare
  if (match === null) {
    throw new Error(`cannot parse the endpoint ${JSON.stringify(text)}; use tcp://127.0.0.1[:port]`)
  }
  return { host: match[1], port: match[2] === undefined ? undefined : Number(match[2]) }
}

/**
 * 真跑用的连接器工厂。cli.mjs 传入 { credentials, environment, baseUrl, instrumentId, fetchImpl, clock }。
 * fetchImpl 对 socket API 无意义（这里不用），保留参数只为与其它四个入口同一签名。
 */
export async function createConnector({ credentials, environment, baseUrl, instrumentId, clock }) {
  if (environment !== 'testnet') {
    throw new Error(`journey-ibkr only runs on the paper environment (environment must be testnet, got ${String(environment)})`)
  }
  const endpoint = parseEndpoint(baseUrl)
  const port = endpoint.port ?? Number(credentials.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`IBKR_PAPER_PORT is not a valid TCP port: ${JSON.stringify(credentials.port)}`)
  }
  const account = String(credentials.account ?? '').trim()
  if (account === '') throw new Error('IBKR_ACCOUNT is empty')
  // 自定义端口（allowCustomPort）挡不住「实盘 TWS 改了端口」：再按账户号把关——IB 模拟盘账户号以 D 开头（DU… / DF…），
  // 实盘是 U… / F…。账户号随单发，实盘 TWS 不认模拟账户号，二者合起来跑不到实盘。只报规则，不回显账户号。
  if (!/^D/i.test(account)) throw new Error('IBKR_ACCOUNT must be a paper-trading account (IB paper account ids start with D, e.g. DU...); refusing to run against a live account')
  const { connector } = await loadBundle({ connector: connectorEntry(venue) })
  return new connector.IbkrTradeConnector({
    // 模拟 / 实盘不许混：mode 写死 paper；7496 / 4001 这类实盘端口由连接器构造期拒绝。
    mode: 'paper',
    host: endpoint.host,
    port,
    // 允许非标准端口：假服务器 / SSH 隧道都落在随机端口上。相反模式的端口仍会被上面那条规则拒掉。
    allowCustomPort: true,
    clientId: CLIENT_ID,
    account,
    // start() 里会拉这个标的的合约详情（REQ_CONTRACT_DATA → CONTRACT_DATA_END）。
    symbols: [nativeSymbolOf(instrumentId)],
    ...(clock ? { clock } : {}),
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 4_000,
    ackTimeoutMs: 3_000,
    // 旅程是一次性脚本：断线就如实失败，不在后台重连。
    reconnect: { enabled: false },
    onWarn: () => {},
  })
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli({ spec, argv, createConnector, deps })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
