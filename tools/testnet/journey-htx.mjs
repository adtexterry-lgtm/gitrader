// SPDX-License-Identifier: CPAL-1.0
// HTX（火币）USDT 本位永续 · 测试网旅程入口。只在测试网跑：environment 恒为 testnet。
//
// 测试网主机的事实：HTX 官方《USDT 本位永续 · 接入说明 · 地址》只列 api.hbdm.com（主地址）、
// api.btcgateway.pro（调试备用）、api.hbdm.vn（部署推荐），全是实盘，没有测试网。api.hbdm.vip 没有任何官方出处。
// 所以 TESTNET.hosts 暂为空，缺省基址 api.hbdm.vip 会被护栏拒（不带 --base-url 直接跑即退出 2）。
// 真跑须等主会话确认测试网主机后写进 TESTNET.hosts。
//
// 先护栏后功能：assertTestnetTarget() 在读密钥、建连接器之前就判 —— 实盘主机（api.hbdm.com 等）一律拒；
// 只放行测试网缺省基址、本机回环，以及 RFC 2606 保留名（.test / .invalid / .example），
// 后者只为离线假服务器：HTX 的签名里含 host，假服务器必须有固定主机名才能独立复算签名。
// 保留 TLD 在公网不可解析，配 --base-url 也走不到任何真实场所。构建连接器后再用 http.baseUrl 复核一次。
//
// 密钥只从 HTX_TESTNET_API_KEY / HTX_TESTNET_API_SECRET 进；不打印、不落盘、不进 argv。
//
// G16（最高级别）：任何「读失败 / 状态不明」只许报错停下，绝不触发下单 / 平仓 / 撤单。
// 本文件没有任何「读失败 → 写」的分支；HTX 的市价全平端点（/v5/trade/position_all、/v5/trade/position）
// 本脚本一次都不调，tests 里断言 closeAllCalls === 0。
//
// 与 lib/journey.mjs 的差异（就地实现，未改既有文件）：
//   1. 本包 capabilities 把 stop_market / stop_limit 全声明为 'none'（触发单要 HTX 的「计划委托」端点，
//      包按 G3 规矩没有凭记忆编端点）。旅程引擎的「下第二张触发单」这一步在 HTX 上会以 ORDER_TYPE_UNSUPPORTED 失败，
//      所以这里用**第二张远离盘口的限价单**代替触发单：语义仍是「再挂一张永不成交的单，再撤掉」，只是不假装支持触发单。
//   2. 因此本场所的步骤表比其它场所少两个 trigger 步骤、多两个第二张限价单步骤（回执里步骤名自带解释）。
// 需要主会话决定的：是否给 lib/journey.mjs 加一个「按能力跳过 trigger 步骤」的开关，让所有场所走同一份引擎。
import { pathToFileURL } from 'node:url'
import { EXIT, JOURNEY_PROBLEM, createRedactor, describeProblem, formatTable, newClientOrderId } from './lib/journey.mjs'
import { compareDecimal, isNonZero, multiplyDecimal, shiftBps, snapDown, snapUp } from './lib/decimal-text.mjs'
import { loadBundle } from './lib/load-connector.mjs'
import { hasTestnet, hostsFor, lookupHost } from './lib/venues-testnet.mjs'

export const venue = 'htx'

export const CONNECTOR_ENTRY = 'packages/connector-htx-trade/src/index.ts'

/**
 * 测试网口径。改这里等于改护栏。
 * hosts 暂为空：登记表 tools/testnet/venues-testnet.json 把 HTX 标为「无测试网」（官方地址页只列实盘域名，
 * api.hbdm.vip 无官方出处）；真正的白名单以登记表为准，本常量只给用法说明与回执用。
 * 缺省 baseUrl 保留，但会被护栏拒。
 */
export const TESTNET = {
  environment: 'testnet',
  baseUrl: 'https://api.hbdm.vip',
  hosts: [],
}

/** 实盘主机（出现即拒）；以 HTX 官方地址页《USDT 本位永续 · 接入说明 · 地址》与包内 rest.ts 的 HTX_ENDPOINTS 为准。 */
export const LIVE = {
  hosts: ['api.hbdm.com', 'api.htx.com', 'api.hbdm.us', 'www.htx.com', 'api.hbdm.vn', 'api.btcgateway.pro'],
}

/** 本场所的旅程参数（lib/venues.mjs 是既有文件，本标段不改，spec 就地定义）。 */
export const spec = {
  venue,
  label: 'HTX USDT 本位永续',
  environment: TESTNET.environment,
  mode: '测试网（主机待官方核实，真跑暂停）',
  baseUrl: TESTNET.baseUrl,
  hosts: TESTNET.hosts,
  defaultAccountId: 'acct_01TESTNET',
  defaultInstrumentId: 'htx:BTC-USDT',
  // 协议数量是币：合约面值 0.001 BTC/张 → 0.001 就是一张。
  defaultSize: '0.001',
  family: 'v5',
  credentials: [
    { env: 'HTX_TESTNET_API_KEY', field: 'apiKey', secret: true },
    { env: 'HTX_TESTNET_API_SECRET', field: 'apiSecret', secret: true },
  ],
}

const USAGE = [
  '用法：node tools/testnet/journey-htx.mjs [选项]',
  '',
  '选项：',
  `  --instrument <id>    协议标的 id（缺省 ${spec.defaultInstrumentId}）`,
  `  --account <id>       协议账户标签（缺省 ${spec.defaultAccountId}）`,
  `  --size <decimal>     下单量（币，缺省 ${spec.defaultSize}；会被合约面值向上贴齐）`,
  '  --base-url <url>     HTX 官方地址页只列实盘域名，测试网主机未经官方核实；真跑须先确认并写进 TESTNET.hosts；离线假服务器用 http://<名字>.test',
  '  --json               以 JSON 打印步骤（回执表给机器读）',
  '  --help               打印这段说明',
  '',
  `环境变量（只读这些名字）：${spec.credentials.map((c) => c.env).join(' · ')}`,
  `运行环境：${spec.mode}；脚本不会读任何密钥文件，也不会打印密钥。`,
  '本场所没有原生触发单（capabilities stop_market = none）：旅程用第二张远离盘口的限价单代替触发单。',
].join('\n')

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
/** RFC 2606 保留 TLD：公网永远解析不到，用来跑离线假服务器（HTX 签名含 host，假服务器要有固定主机名）。 */
const RESERVED_TLDS = new Set(['test', 'invalid', 'example', 'localhost'])
/** 实盘的可注册域名：挂在保留 TLD 前面冒充的（api.hbdm.com.evil.test）一律不认。 */
const LIVE_DOMAINS = ['hbdm.com', 'htx.com', 'hbdm.us', 'hbdm.vn', 'btcgateway.pro']

/** 从基址取主机名；取不到返回空串。 */
export function hostOf(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  try {
    return new URL(text).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 主机名里任何位置挂着实盘域名（api.hbdm.com / api.hbdm.com.evil.test 这类伪装）都算实盘。 */
export function isLiveLookalike(host) {
  return LIVE_DOMAINS.some((domain) => host === domain || host.includes(`.${domain}.`) || host.endsWith(`.${domain}`))
}

function isReservedName(host) {
  if (LOOPBACK_HOSTS.has(host)) return true
  if (isLiveLookalike(host)) return false
  const labels = host.split('.')
  return RESERVED_TLDS.has(labels[labels.length - 1])
}

/**
 * 测试网护栏（纯函数，读环境变量之前跑）。
 *   1. environment 必须是 testnet；
 *   2. 基址主机必须不是实盘主机，且是测试网缺省主机 / 本机回环 / RFC 2606 保留名之一。
 * 不过就抛 code='USAGE' 的错误（main 据此退出 2，此时一个请求都还没发）。
 */
export function assertTestnetTarget({ environment, baseUrl }) {
  const problems = []
  if (String(environment) !== TESTNET.environment) {
    problems.push(`environment=${String(environment)}：本脚本只跑 ${TESTNET.environment}，实盘环境一律拒`)
  }
  const host = hostOf(baseUrl)
  if (host === '') {
    problems.push(`基址无法解析：${String(baseUrl ?? '')}；脚本不连来历不明的地址`)
  } else if (LIVE.hosts.includes(host) || isLiveLookalike(host)) {
    problems.push(`基址 ${host} 是 HTX 实盘主机（或挂着实盘域名的伪装），拒`)
  } else if (!lookupHost(venue, host) && !isReservedName(host)) {
    if (!hasTestnet(venue)) {
      problems.push(`基址 ${host} 不是测试网主机：登记表 venues-testnet.json 把 HTX 标为「无测试网」（官方地址页只列实盘域名，api.hbdm.vip 没有经官方核实，见 PLATFORM-GAPS #12），真跑暂停；离线假服务器请用 --base-url http://<名字>.test`)
    } else {
      const allowed = hostsFor(venue)
      problems.push(`基址 ${host} 既不是登记表里的测试网主机 ${allowed.join(' / ')}，也不是本机回环 / 保留名（离线假服务器），拒`)
    }
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

/** 解析 `--flag value`；未知旗标 → 用法错误（与 lib/cli.mjs 同口径）。 */
export function parseArgs(argv) {
  const options = {
    instrumentId: spec.defaultInstrumentId,
    accountId: spec.defaultAccountId,
    size: spec.defaultSize,
    baseUrl: spec.baseUrl,
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
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw usageError(`未知参数：${arg}`)
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

/** 真跑用的连接器工厂。返回的就是 VenueConnector 本身（HTX 有 start / refreshQuote，无需适配层）。 */
export async function createConnector({ credentials, environment, baseUrl, instrumentId, fetchImpl, clock }) {
  const { connector: mod } = await loadBundle({ connector: CONNECTOR_ENTRY })
  const connector = new mod.HtxTradeConnector({
    environment,
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    baseUrl,
    family: spec.family,
    defaultSymbol: nativeSymbolOf(instrumentId ?? spec.defaultInstrumentId),
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(clock ? { clock } : {}),
    onWarn: () => {},
  })
  // 第二道闸：连接器真要打的那个基址也得过测试网白名单。
  assertTestnetTarget({ environment: connector.environment, baseUrl: connector.http?.baseUrl ?? baseUrl })
  return connector
}

/** 'htx:BTC-USDT' → 'BTC-USDT'。 */
export function nativeSymbolOf(instrumentId) {
  const text = String(instrumentId)
  const index = text.indexOf(':')
  return index < 0 ? text : text.slice(index + 1)
}

function journeyProblem(kind, message) {
  const error = new Error(message)
  error.problem = { code: kind.code, name: kind.name, category: 'PROTOCOL', message, retryable: false }
  return error
}

function ackProblem(ack, stepName) {
  if (ack && typeof ack === 'object' && ack.problem) {
    const error = new Error(ack.problem.message ?? `${stepName}: rejected by the venue`)
    error.problem = ack.problem
    return error
  }
  return journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `${stepName}: no acknowledgement in the venue response`)
}

/** 取第 0 条 ack；有 problem / status=rejected|unknown 一律当失败。 */
function firstAck(result, stepName) {
  const ack = result && Array.isArray(result.acks) ? result.acks[0] : undefined
  if (!ack) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `${stepName}: empty acks`)
  if (ack.problem) throw ackProblem(ack, stepName)
  if (ack.status === 'rejected' || ack.status === 'unknown') {
    throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `${stepName}: ack status ${ack.status}`)
  }
  return ack
}

function isCancelSettled(status) {
  return typeof status === 'string' && /cancel|closed|expired/i.test(status)
}

function openPositionRows(snapshot, instrumentId) {
  const rows = snapshot && Array.isArray(snapshot.positions) ? snapshot.positions : []
  return rows.filter((row) => row && row.instrumentId === instrumentId && isNonZero(row.size))
}

/** 旅程步骤名（顺序固定；其它场所的两步 trigger 在这里换成两步「第二张限价单」）。 */
export const HTX_STEPS = [
  'connect', 'account', 'precondition-flat', 'instrument', 'reference-price',
  'place-limit', 'query-order', 'amend', 'cancel', 'confirm-cancel',
  'place-second-limit', 'cancel-second-limit', 'positions-flat',
]

/**
 * 跑一遍 HTX 旅程。
 * @param {object} options
 * @param {object} options.connector    VenueConnector（start/describe/accountState/getInstrument/book/submit/orderStatus/cancel）
 * @param {string} options.accountId
 * @param {string} options.instrumentId
 * @param {string} [options.sizeHint]
 * @param {string[]} [options.secrets]
 * @returns {Promise<{ok:boolean, exitCode:number, steps:object[], failedStep:string|null, problem:object|null}>}
 */
export async function runHtxJourney(options) {
  const {
    connector, accountId, instrumentId, sizeHint, secrets = [],
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = options
  const redact = createRedactor(secrets)
  const steps = []
  let failure = null

  // HTX 是 HMAC（API key），账户按 uid 认，不用地址：给引擎形状要的占位地址。
  const accountRef = { accountId, address: 'htx' }
  const ctx = { account: accountRef, signer: {} }

  let snapshot = null
  let instrument = null
  let caps = null
  let referencePrice = null
  let limitPrice = null
  let size = null
  let limitClientId = null
  let limitVenueId = null
  let secondClientId = null
  let secondVenueId = null

  /** 名义额不足场所下限时按 2 倍递增到够（仍是极小单）。 */
  function ensureMinNotional(amount, price) {
    if (instrument.minNotional === undefined) return amount
    let next = amount
    for (let guard = 0; guard < 40 && compareDecimal(multiplyDecimal(next, price), String(instrument.minNotional)) < 0; guard += 1) {
      next = snapUp(multiplyDecimal(next, '2'), instrument.size.step)
    }
    return next
  }

  async function step(name, fn) {
    if (failure) {
      steps.push({ name, ok: false, skipped: true, ms: 0, receipt: 'skipped: earlier step failed' })
      return
    }
    const started = now()
    try {
      const receipt = await fn()
      steps.push({ name, ok: true, skipped: false, ms: Math.max(0, now() - started), receipt: receipt === undefined ? '' : String(receipt) })
    } catch (e) {
      const problem = describeProblem(e, redact)
      steps.push({ name, ok: false, skipped: false, ms: Math.max(0, now() - started), receipt: `FAILED ${problem.name}`, problem })
      // 读失败 / 状态不明一律停在这里，不往下走任何写步骤（G16）。
      failure = { step: name, problem }
    }
  }

  await step('connect', async () => {
    await connector.start()
    caps = connector.describe()
    return `${venue} env=${connector.environment ?? 'unknown'} amend=${caps?.amend ?? 'unknown'} stop_market=${caps?.orderTypes?.stop_market ?? 'unknown'}`
  })

  await step('account', async () => {
    snapshot = await connector.accountState(accountRef)
    const balances = Array.isArray(snapshot.balances) ? snapshot.balances.length : 0
    return `balances=${balances} positions=${Array.isArray(snapshot.positions) ? snapshot.positions.length : 0}`
  })

  await step('precondition-flat', async () => {
    const open = openPositionRows(snapshot, instrumentId)
    if (open.length > 0) {
      const sizes = open.map((row) => `${row.side}:${row.size}`).join(',')
      throw journeyProblem(JOURNEY_PROBLEM.PRECONDITION_POSITION_OPEN,
        `instrument ${instrumentId} already has a position (${sizes}); flatten the testnet account before running the journey`)
    }
    return 'no position on the target instrument'
  })

  await step('instrument', async () => {
    instrument = connector.getInstrument(instrumentId)
    if (!instrument) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `instrument ${instrumentId} is not in the venue catalogue`)
    return `tick=${instrument.price.tick ?? 'n/a'} step=${instrument.size.step} min=${instrument.size.min} status=${instrument.status}`
  })

  await step('reference-price', async () => {
    let bid
    let ask
    const quote = await connector.refreshQuote?.(instrumentId)
    if (quote && Number.isFinite(quote.bid)) bid = quote.bid
    if (quote && Number.isFinite(quote.ask)) ask = quote.ask
    if (bid === undefined && ask === undefined) {
      const book = await connector.book(instrumentId, 5)
      bid = Array.isArray(book.bids) && book.bids.length > 0 ? book.bids[0].price : undefined
      ask = Array.isArray(book.asks) && book.asks.length > 0 ? book.asks[0].price : undefined
    }
    if (bid === undefined && ask === undefined) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'no quote and empty order book: cannot price a far-from-book order')
    referencePrice = String(bid ?? ask)
    const tick = instrument.price.tick ?? '0.000001'
    limitPrice = snapDown(shiftBps(referencePrice, -1500), tick)
    if (compareDecimal(limitPrice, '0') <= 0) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `computed limit price ${limitPrice} is not positive`)
    size = snapUp(sizeHint ?? instrument.size.min, instrument.size.step)
    if (compareDecimal(size, instrument.size.min) < 0) size = snapUp(instrument.size.min, instrument.size.step)
    size = ensureMinNotional(size, limitPrice)
    return `bid=${bid ?? 'n/a'} ask=${ask ?? 'n/a'} limit=${limitPrice} size=${size}`
  })

  await step('place-limit', async () => {
    limitClientId = newClientOrderId()
    const result = await connector.submit(ctx, [{
      accountId,
      instrumentId,
      side: 'buy',
      type: 'limit',
      size,
      price: limitPrice,
      tif: 'gtc',
      reason: 'testnet journey: small limit order far from the book, must stay unfilled',
      clientOrderId: limitClientId,
    }])
    const ack = firstAck(result, 'place-limit')
    if (ack.status === 'filled') throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'limit order filled immediately: the price was not far enough from the book')
    limitVenueId = ack.venueOrderId ?? null
    return `clientOrderId=${ack.clientOrderId} venueOrderId=${ack.venueOrderId ?? 'n/a'} status=${ack.status}`
  })

  await step('query-order', async () => {
    const status = await connector.orderStatus(accountRef, {
      clientOrderId: limitClientId, ...(limitVenueId ? { venueOrderId: limitVenueId } : {}), instrumentId,
    })
    if (!status || status.found !== true) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'order not found right after placement')
    return `status=${status.status ?? 'unknown'} filled=${status.filledSize ?? 'n/a'}`
  })

  await step('amend', async () => {
    // HTX 没有改单端点（capabilities.amend = 'none'）：这一步只回执，不发请求。
    return `skipped: venue declares amend=${caps?.amend ?? 'none'}（HTX 无改单端点，内核按撤旧挂新）`
  })

  await step('cancel', async () => {
    const acks = await connector.cancel(ctx, [{
      instrumentId,
      ...(limitVenueId ? { venueOrderId: limitVenueId } : {}),
      ...(limitClientId ? { clientOrderId: limitClientId } : {}),
    }])
    const ack = Array.isArray(acks) ? acks[0] : undefined
    if (!ack) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'cancel returned no acknowledgement')
    if (!ack.ok) throw ackProblem(ack, 'cancel')
    return 'ok:true'
  })

  await step('confirm-cancel', async () => {
    let last = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(250)
      last = await connector.orderStatus(accountRef, {
        clientOrderId: limitClientId, ...(limitVenueId ? { venueOrderId: limitVenueId } : {}), instrumentId,
      })
      if (!last || last.found !== true) return 'not found after cancel (treated as cancelled)'
      if (isCancelSettled(last.status)) return `status=${last.status}`
    }
    throw journeyProblem(JOURNEY_PROBLEM.ORDER_STILL_LIVE,
      `order is still ${last && last.status ? last.status : 'present'} after cancel; the venue did not settle it`)
  })

  await step('place-second-limit', async () => {
    // 本场所没有原生触发单（G3：不编端点）；第二张单用更远的限价单代替，同样永不成交。
    if (referencePrice === null) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'no reference price from the earlier step')
    const tick = instrument.price.tick ?? '0.000001'
    const secondPrice = snapDown(shiftBps(referencePrice, -4000), tick)
    secondClientId = newClientOrderId()
    const secondSize = ensureMinNotional(size, secondPrice)
    const result = await connector.submit(ctx, [{
      accountId,
      instrumentId,
      side: 'buy',
      type: 'limit',
      size: secondSize,
      price: secondPrice,
      tif: 'gtc',
      reason: 'testnet journey: second resting limit far below the book (HTX has no native stop orders), must stay unfilled',
      clientOrderId: secondClientId,
    }])
    const ack = firstAck(result, 'place-second-limit')
    if (ack.status === 'filled') throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'second limit order filled immediately: the price was not far enough from the book')
    secondVenueId = ack.venueOrderId ?? null
    return `price=${secondPrice} size=${secondSize} venueOrderId=${ack.venueOrderId ?? 'n/a'} status=${ack.status}`
  })

  await step('cancel-second-limit', async () => {
    const acks = await connector.cancel(ctx, [{
      instrumentId,
      ...(secondVenueId ? { venueOrderId: secondVenueId } : {}),
      ...(secondClientId ? { clientOrderId: secondClientId } : {}),
    }])
    const ack = Array.isArray(acks) ? acks[0] : undefined
    if (!ack) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'cancel-second-limit returned no acknowledgement')
    if (!ack.ok) throw ackProblem(ack, 'cancel-second-limit')
    return 'ok:true'
  })

  await step('positions-flat', async () => {
    const after = await connector.accountState(accountRef)
    const open = openPositionRows(after, instrumentId)
    if (open.length > 0) {
      const sizes = open.map((row) => `${row.side}:${row.size}`).join(',')
      throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `position is not flat after the journey (${sizes})`)
    }
    return 'flat'
  })

  const ok = failure === null
  if (!ok) log(`journey failed at step "${failure.step}"`)
  return { ok, exitCode: ok ? EXIT.OK : EXIT.FAILED, steps, failedStep: failure ? failure.step : null, problem: failure ? failure.problem : null }
}

/**
 * 跑一遍 HTX 旅程的 CLI。
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
    // 第一道闸：读密钥之前。此时连接器还没造，一个请求都发不出去。
    if (!options.help) assertTestnetTarget({ environment: TESTNET.environment, baseUrl: options.baseUrl })
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
  const secrets = spec.credentials.filter((c) => c.secret).map((c) => values[c.field]).filter((value) => typeof value === 'string')
  const redact = createRedactor(secrets)
  if (missing.length > 0) {
    writeError(`缺少密钥环境变量：${missing.join('、')}`)
    writeError(redact(`本脚本不发任何请求。请先在当前终端导出：${missing.join(' ')}（只读环境变量，不会落盘；见 tools/testnet/README.md）。`))
    return EXIT.NO_CREDENTIALS
  }

  write(`Gitrader 测试网旅程 · ${spec.venue} · ${spec.mode}`)
  write(redact(`基址 ${options.baseUrl} · 标的 ${options.instrumentId} · 账户 ${options.accountId}`))

  let connector
  try {
    connector = await createConnector({
      credentials: values,
      environment: TESTNET.environment,
      baseUrl: options.baseUrl,
      instrumentId: options.instrumentId,
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
    result = await runHtxJourney({
      connector,
      accountId: options.accountId,
      instrumentId: options.instrumentId,
      sizeHint: options.size,
      secrets,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      log: (line) => write(redact(line)),
    })
  } finally {
    try {
      await connector.close?.()
    } catch {
      /* 关连接失败不改变旅程结论 */
    }
  }

  if (options.json) {
    write(redact(JSON.stringify({ venue, environment: TESTNET.environment, ok: result.ok, failedStep: result.failedStep, steps: result.steps }, null, 2)))
  } else {
    write('')
    write(redact(formatTable(result.steps)))
    write('')
    const total = result.steps.reduce((sum, stepItem) => sum + (stepItem.ms || 0), 0)
    write(`共 ${result.steps.length} 步 · ${total} ms · ${result.ok ? '全部通过' : `失败于「${result.failedStep}」`}`)
    if (!result.ok) {
      writeError(redact(`Problem: ${JSON.stringify(result.problem)}`))
      writeError('按 README「失败怎么读」一节处理：先查单对账，再决定是否重跑；不要盲目重发下单请求。')
    }
  }
  return result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
