// SPDX-License-Identifier: CPAL-1.0
// dYdX v4 永续 · 测试网旅程入口。只在测试网跑：environment 恒为 testnet（链 id dydx-testnet-4），
// indexer / 节点基址只接受测试网缺省值或本机回环。
//
// 先护栏后功能：assertTestnetTarget() 在读密钥、建连接器之前就把「实盘主机 / 实盘链 id」拒掉（退出码 2），
// 建好连接器后再拿包里真实的 CHAIN_ID 复核一次（第二道闸，见 main）。
// 密钥只从 DYDX_TESTNET_PRIVATE_KEY 进；手续费三项（denom / amount / gas）也必须显式给，
// 本脚本**不猜金额**：缺任何一项都按「缺环境变量」退出 3，不发任何请求。
//
// G16（最高级别）：任何「读失败 / 状态不明」只许报错停下，绝不触发下单 / 平仓 / 撤单。
// 本文件没有任何「读失败 → 写」的分支：账户 / 盘口 / 订单读失败一律上抛，由旅程引擎停机。
// 未改 lib/journey.mjs、lib/cli.mjs、lib/venues.mjs：dYdX 要守两个基址 + 一条链 id，cli.mjs 的单基址白名单
// 装不下，所以本文件就地实现 main()（复用 journey.mjs 的引擎与脱敏）。lib/venues.mjs 是既有文件，spec 就地定义。
//
// 真跑会访问 indexer.v4testnet.dydx.exchange 与 dydx-testnet-rest.publicnode.com；不出网时用
// test/journey-dydx.test.mjs 的假链节点 + 假 Indexer（进程内 fetch，不开端口）。
import { pathToFileURL } from 'node:url'
import { EXIT, createRedactor, describeProblem, formatTable, runJourney } from './lib/journey.mjs'
import { loadBundle } from './lib/load-connector.mjs'
import { hostsFor, lookupHost } from './lib/venues-testnet.mjs'

export const venue = 'dydx'

/** 交易连接器与只读行情源的入口（行情源按包 README 的说法注入 DydxDataConnector）。 */
export const CONNECTOR_ENTRY = 'packages/connector-dydx-trade/src/index.ts'
export const MARKET_ENTRY = 'packages/connector-dydx-data/src/index.ts'

/** 测试网口径：环境、链 id、两个基址。改这里等于改护栏。 */
export const TESTNET = {
  environment: 'testnet',
  chainId: 'dydx-testnet-4',
  indexerBaseUrl: 'https://indexer.v4testnet.dydx.exchange',
  nodeBaseUrl: 'https://dydx-testnet-rest.publicnode.com',
  hosts: ['indexer.v4testnet.dydx.exchange', 'dydx-testnet-rest.publicnode.com'],
}

/** 实盘口径（出现即拒）。链 id 与主机名以 packages/connector-dydx-trade/src/constants.ts 的官方表为准。 */
export const LIVE = {
  chainIds: ['dydx-mainnet-1'],
  hosts: ['indexer.dydx.trade', 'indexer.dydx.exchange', 'dydx-rest.publicnode.com', 'dydx-grpc.publicnode.com', 'api.dydx.exchange'],
}

/** 本场所的旅程参数（lib/venues.mjs 是既有文件，本标段不改，spec 就地定义）。 */
export const spec = {
  venue,
  label: 'dYdX v4 永续',
  environment: TESTNET.environment,
  mode: '测试网（testnet Indexer + testnet 链节点）',
  baseUrl: TESTNET.indexerBaseUrl,
  nodeBaseUrl: TESTNET.nodeBaseUrl,
  hosts: TESTNET.hosts,
  defaultAccountId: 'acct_01TESTNET',
  defaultInstrumentId: 'dydx:BTC-USD',
  defaultSize: '0.01',
  subaccountNumber: 0,
  credentials: [
    { env: 'DYDX_TESTNET_PRIVATE_KEY', field: 'privateKey', secret: true },
    { env: 'DYDX_TESTNET_FEE_DENOM', field: 'feeDenom', secret: false },
    { env: 'DYDX_TESTNET_FEE_AMOUNT', field: 'feeAmount', secret: false },
    { env: 'DYDX_TESTNET_FEE_GAS', field: 'feeGas', secret: false },
  ],
}

const USAGE = [
  '用法：node tools/testnet/journey-dydx.mjs [选项]',
  '',
  '选项：',
  `  --instrument <id>    协议标的 id（缺省 ${spec.defaultInstrumentId}）`,
  `  --account <id>       协议账户标签（缺省 ${spec.defaultAccountId}）`,
  `  --size <decimal>     下单量（缺省 ${spec.defaultSize}，会被场所步长与最小量修正）`,
  `  --base-url <url>     Indexer 基址；只接受 ${TESTNET.indexerBaseUrl} 或本机回环（本地镜像 / 假服务器）`,
  `  --node-url <url>     链节点基址；只接受 ${TESTNET.nodeBaseUrl} 或本机回环`,
  '  --json               以 JSON 打印步骤（回执表给机器读）',
  '  --help               打印这段说明',
  '',
  `环境变量（只读这些名字）：${spec.credentials.map((c) => c.env).join(' · ')}`,
  `运行环境：${spec.mode}；脚本不会读任何密钥文件，也不会打印密钥。`,
  '手续费必须显式给（本脚本不猜金额）；long-term 单没有手续费会被连接器按 INVALID_PARAMS 拒。',
].join('\n')

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 从基址取主机名；取不到返回空串（调用方当「无法解析」处理）。 */
export function hostOf(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  try {
    return new URL(text).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 测试网护栏（纯函数，读环境变量之前跑）：三条一起判。
 *   1. environment 必须是 testnet（mainnet 一律拒）；
 *   2. 链 id 必须是 dydx-testnet-4，实盘链 id（dydx-mainnet-1）与任何未知链 id 一律拒；
 *   3. indexer / 节点两个基址的主机必须在测试网白名单或本机回环内，实盘主机显式拒。
 * 有任一条不过就抛 code='USAGE' 的错误（main 据此退出 2，此时一个请求都还没发）。
 */
export function assertTestnetTarget({ environment, chainId, indexerBaseUrl, nodeBaseUrl }) {
  const problems = []
  if (String(environment) !== TESTNET.environment) {
    problems.push(`environment=${String(environment)}：本脚本只跑 ${TESTNET.environment}，实盘环境一律拒`)
  }
  const id = String(chainId ?? '')
  if (LIVE.chainIds.includes(id)) problems.push(`链 id ${id} 是 dYdX 实盘链，拒`)
  else if (id !== TESTNET.chainId) problems.push(`链 id ${id || '(空)'} 不是测试网链 ${TESTNET.chainId}，拒`)

  const bases = [['indexer', indexerBaseUrl], ['node', nodeBaseUrl]]
  for (const [label, raw] of bases) {
    const host = hostOf(raw)
    if (host === '') {
      problems.push(`${label} 基址无法解析：${String(raw ?? '')}；脚本不连来历不明的地址`)
      continue
    }
    if (LIVE.hosts.includes(host)) {
      problems.push(`${label} 基址 ${host} 是实盘主机，拒`)
      continue
    }
    if (lookupHost(venue, host)) continue
    if (LOOPBACK_HOSTS.has(host)) continue
    problems.push(`${label} 基址 ${host} 不在测试网白名单（登记表 venues-testnet.json：${hostsFor(venue).join(' / ')}）也不在本机回环，拒`)
  }

  if (problems.length > 0) {
    const error = new Error(problems.join('；'))
    error.code = 'USAGE'
    error.problems = problems
    throw error
  }
}

function usageError(message) {
  const error = new Error(message)
  error.code = 'USAGE'
  return error
}

/** 解析 `--flag value`；未知旗标 → 用法错误（与 lib/cli.mjs 同口径，多一个 --node-url）。 */
export function parseArgs(argv) {
  const options = {
    instrumentId: spec.defaultInstrumentId,
    accountId: spec.defaultAccountId,
    size: spec.defaultSize,
    baseUrl: spec.baseUrl,
    nodeBaseUrl: spec.nodeBaseUrl,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--instrument':
        if (!value) throw usageError('--instrument 需要值')
        options.instrumentId = String(value)
        i += 1
        break
      case '--account':
        if (!value) throw usageError('--account 需要值')
        options.accountId = String(value)
        i += 1
        break
      case '--size':
        if (!value) throw usageError('--size 需要值')
        options.size = String(value)
        i += 1
        break
      case '--base-url':
        if (!value) throw usageError('--base-url 需要值')
        options.baseUrl = String(value)
        i += 1
        break
      case '--node-url':
        if (!value) throw usageError('--node-url 需要值')
        options.nodeBaseUrl = String(value)
        i += 1
        break
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw usageError(`未知参数：${arg}（dYdX 的子账户号是连接器常量，不收旗标）`)
    }
  }
  return options
}

/** 只认环境变量；缺哪个报哪个（只报名不报值）。 */
export function readEnv(env) {
  const values = {}
  const missing = []
  for (const credential of spec.credentials) {
    const value = env[credential.env]
    if (typeof value !== 'string' || value.trim() === '') missing.push(credential.env)
    else values[credential.field] = value.trim()
  }
  return { values, missing }
}

/**
 * 真跑用的连接器工厂：ESM 打包 + 实例化「只读行情源 + 交易连接器」。
 * 返回的是旅程引擎要的那个壳（见 journeyView）：不改引擎，只补 dYdX 与引擎的三处口径差。
 */
export async function createConnector({ credentials, environment, baseUrl, nodeBaseUrl, fetchImpl, clock }) {
  const bundle = await loadBundle({ connector: CONNECTOR_ENTRY, market: MARKET_ENTRY })
  const chainId = bundle.connector.CHAIN_ID?.[environment]
  // 第二道闸：包里实际会拿去签名的链 id 也得是测试网链（包改缺省值会在这里被拦住）。
  assertTestnetTarget({ environment, chainId, indexerBaseUrl: baseUrl, nodeBaseUrl })

  const market = new bundle.market.DydxDataConnector({
    baseUrl,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
  })
  const connector = new bundle.connector.DydxTradeConnector({
    privateKey: credentials.privateKey,
    environment,
    indexerBaseUrl: baseUrl,
    nodeBaseUrl,
    subaccountNumber: spec.subaccountNumber,
    // 行情源同时交给交易连接器（getInstrument / book 走它），旅程与连接器看的是同一份目录。
    market,
    fee: {
      amount: [{ denom: credentials.feeDenom, amount: credentials.feeAmount }],
      gasLimit: Number(credentials.feeGas),
    },
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { now: clock } : {}),
  })
  // dYdX 的触发单落地后按市价成交：价带必须显式给（包拒绝猜滑点）。取包里能力声明的缺省价带。
  const bandBps = Number(bundle.connector.DEFAULT_MARKET_BAND_BPS ?? 50)
  return journeyView({ connector, market, environment, chainId, bandBps })
}

/**
 * 触发单的价带：dYdX 的 stop_market 触发后按市价成交，连接器**拒绝猜滑点**（INVALID_PARAMS），
 * 引擎给的触发意图里没有 maxSlippageBps。这里显式补上能力声明里的缺省价带（不是绕过闸门：
 * 闸门要的就是「调用方自己给一个数」，只是引擎的意图形状里没有这个字段）。
 * 旅程的触发单离盘口 40%，永不触发，价带只约束「万一触发」时的最差成交价。
 */
function withBand(intents, bandBps) {
  return intents.map((intent) => {
    if (!intent || typeof intent !== 'object') return intent
    const needsBand = (intent.type === 'stop_market' || intent.type === 'take_market') && intent.maxSlippageBps === undefined
    return needsBand ? { ...intent, maxSlippageBps: bandBps } : intent
  })
}

/**
 * 引擎 ↔ dYdX 的三处口径差，只在这层补：
 *   1. 引擎要求 start()：dYdX 交易连接器没有 start（无订阅、无目录），这里只复核环境仍是 testnet，
 *      再让行情源拉一次 /v4/perpetualMarkets（getInstrument 靠它）。**不发任何写请求**。
 *   2. 引擎给的是哨兵账户地址 0x000…0：dYdX 的账户就是签名者 bech32 地址，读账户 / 查单 / 撤单都按它查。
 *      这里把哨兵地址换成签名者地址（地址来自连接器自身的签名器，不是外部输入）。
 *   3. 引擎优先用 refreshQuote：dYdX 的报价要额外两次 Indexer 请求，旅程只要一个参考价，直接不给这个方法，
 *      引擎就会退回 book()（一次请求，链路更短，失败也更好读）。
 * 注意：这里没有任何 catch 把读失败改写成写请求（G16）。
 */
export function journeyView({ connector, market, environment, chainId, bandBps = 50 }) {
  const address = connector.address
  const asAccount = (ref) => ({ ...ref, address: address ?? ref.address })
  return {
    venue,
    environment: connector.environment ?? environment,
    describe: () => connector.describe(),
    async start() {
      // 第二道闸只拿「真要发请求的那个 HTTP 对象」的字段判：环境、链 id、两个基址。
      // 判不过就抛（main 会退出 1 并打印脱敏 Problem），这一步发生在任何读之前，更在任何写之前。
      assertTestnetTarget({
        environment: connector.http?.environment ?? connector.environment,
        chainId,
        indexerBaseUrl: connector.http?.indexerBaseUrl,
        nodeBaseUrl: connector.http?.nodeBaseUrl,
      })
      await market.start()
    },
    accountState: (ref) => connector.accountState(asAccount(ref)),
    getInstrument: (instrumentId) => connector.getInstrument(instrumentId),
    book: (instrumentId, depth) => connector.book(instrumentId, depth),
    submit: (ctx, intents) => connector.submit({ ...ctx, account: asAccount(ctx.account) }, withBand(intents, bandBps)),
    orderStatus: (ref, key) => connector.orderStatus(asAccount(ref), key),
    cancel: (ctx, targets) => connector.cancel({ ...ctx, account: asAccount(ctx.account) }, targets),
    async close() {
      try {
        await connector.close?.()
      } finally {
        await market.close?.()
      }
    },
  }
}

/**
 * 跑一遍 dYdX 旅程。
 * @param {string[]} argv  process.argv.slice(2)
 * @param {object} [deps]  { env, stdout, stderr, fetchImpl, clock, sleep }
 * @returns {Promise<number>} 退出码：0 / 1 / 2 / 3
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env
  const write = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`))
  const writeError = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`))

  let options
  try {
    options = parseArgs(argv)
    // 第一道闸：读密钥之前。此时连连接器都还没造，一个请求都发不出去。
    if (!options.help) {
      assertTestnetTarget({
        environment: TESTNET.environment,
        chainId: TESTNET.chainId,
        indexerBaseUrl: options.baseUrl,
        nodeBaseUrl: options.nodeBaseUrl,
      })
    }
  } catch (error) {
    writeError(`参数错误：${error.message}`)
    writeError(USAGE)
    return EXIT.USAGE
  }
  if (options.help) {
    write(USAGE)
    return EXIT.OK
  }

  const { values, missing } = readEnv(env)
  const secrets = spec.credentials.filter((c) => c.secret).map((c) => values[c.field]).filter((v) => typeof v === 'string')
  const redact = createRedactor(secrets)
  if (missing.length > 0) {
    writeError(`缺少环境变量：${missing.join('、')}`)
    writeError(redact(`本脚本不发任何请求。请先在当前终端导出：${missing.join(' ')}（只读环境变量，不会落盘；手续费不猜金额）。`))
    return EXIT.NO_CREDENTIALS
  }

  write(`Gitrader 测试网旅程 · ${spec.venue} · ${spec.mode}`)
  write(redact(`Indexer ${options.baseUrl} · 节点 ${options.nodeBaseUrl} · 链 ${TESTNET.chainId} · 标的 ${options.instrumentId} · 账户 ${options.accountId}`))

  let view
  try {
    view = await createConnector({
      credentials: values,
      environment: TESTNET.environment,
      baseUrl: options.baseUrl,
      nodeBaseUrl: options.nodeBaseUrl,
      fetchImpl: deps.fetchImpl,
      clock: deps.clock,
    })
  } catch (error) {
    const problem = describeProblem(error, redact)
    writeError(redact(`连接器构造失败：${problem.name} ${problem.message}`))
    return EXIT.FAILED
  }

  let result
  try {
    result = await runJourney({
      venue,
      connector: view,
      accountId: options.accountId,
      instrumentId: options.instrumentId,
      sizeHint: options.size,
      triggerShape: 'sell',
      secrets,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      log: (line) => write(redact(line)),
    })
  } finally {
    try {
      await view.close()
    } catch {
      /* 关连接失败不改变旅程结论 */
    }
  }

  if (options.json) {
    write(redact(JSON.stringify({
      venue, environment: TESTNET.environment, chainId: TESTNET.chainId, ok: result.ok,
      failedStep: result.failedStep, steps: result.steps,
    }, null, 2)))
  } else {
    write('')
    write(redact(formatTable(result.steps)))
    write('')
    const total = result.steps.reduce((sum, step) => sum + (step.ms || 0), 0)
    write(`共 ${result.steps.length} 步 · ${total} ms · ${result.ok ? '全部通过' : `失败于「${result.failedStep}」`}`)
    if (!result.ok) {
      writeError(redact(`Problem: ${JSON.stringify(result.problem)}`))
      writeError('按 README「失败怎么读」一节处理：先查链上 / Indexer 对账，再决定是否重跑；不要盲目重发交易（dYdX 广播超时是 3006，结果未知）。')
    }
  }
  return result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
