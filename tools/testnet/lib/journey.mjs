// SPDX-License-Identifier: CPAL-1.0
// 旅程引擎：对任意一个已入库交易连接器（VenueConnector 形状）跑一条固定顺序的测试网旅程。
// 顺序：连接 → 查账户 → 前置检查（该标的无持仓）→ 查合约元数据 → 查盘口 → 下一笔远离盘口的极小限价单
//      → 查单 → 改单（能力位允许时）→ 撤单 → 确认撤销 → 下一笔触发单 → 撤触发单 → 查持仓为空。
// 任一步失败立即停：后续步骤标 skipped，整体退出码 1；上游 Problem 原样保留码与名字，文本统一脱敏。
//
// 本文件**不 import 任何 TS 工作区包**：连接器由调用方注入（真跑时是 packages/connector-<venue>-trade，
// 离线测试时是「真连接器 + 各包 test/helpers 的假服务器 fetch」）。因此 journey-<venue>.mjs 的静态 import
// 不会在注册 TS 解析钩子之前触发 TS 加载。
import { randomBytes } from 'node:crypto'
import { compareDecimal, isNonZero, multiplyDecimal, shiftBps, snapDown, snapUp } from './decimal-text.mjs'

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, NO_CREDENTIALS: 3 }

/** 旅程脚本自己的 Problem 码（与协议 2.8 的错误码表不重叠；上游 Problem 一律原样上抛）。 */
export const JOURNEY_PROBLEM = {
  PRECONDITION_POSITION_OPEN: { code: 4001, name: 'PRECONDITION_POSITION_OPEN' },
  STEP_FAILED: { code: 4002, name: 'STEP_FAILED' },
  ORDER_STILL_LIVE: { code: 4003, name: 'ORDER_STILL_LIVE' },
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** 脱敏：把每个密钥原文与其 base64 形态替换掉（按长度降序，避免前缀互相覆盖）。 */
export function createRedactor(secrets = []) {
  const forms = new Set()
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    forms.add(secret)
    forms.add(Buffer.from(secret, 'utf8').toString('base64'))
  }
  const ordered = [...forms].sort((a, b) => b.length - a.length)
  return (text) => {
    let out = String(text ?? '')
    for (const form of ordered) out = out.split(form).join('<redacted>')
    return out
  }
}

/** 把任意异常收敛成可打印的脱敏 Problem（不带 raw 上游报文）。 */
export function describeProblem(error, redact) {
  const problem = error && typeof error === 'object' ? error.problem : undefined
  if (problem && typeof problem === 'object' && typeof problem.message === 'string') {
    return {
      code: typeof problem.code === 'number' ? problem.code : null,
      name: typeof problem.name === 'string' ? problem.name : 'UNKNOWN',
      message: redact(problem.message),
      retryable: problem.retryable === true,
      ...(problem.venue ? { venue: { id: problem.venue.id, code: problem.venue.code ?? null, message: redact(problem.venue.message) } } : {}),
    }
  }
  return {
    code: null,
    name: (error && error.name) || 'ERROR',
    message: redact(error && error.message !== undefined ? error.message : error),
    retryable: false,
  }
}

function journeyProblem(kind, message, extra = {}) {
  const error = new Error(message)
  error.problem = { code: kind.code, name: kind.name, category: 'PROTOCOL', message, retryable: false, ...extra }
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

/** 该标的的非零持仓行（数量符号不计，只看有没有量）。 */
function openPositionRows(snapshot, instrumentId) {
  const rows = snapshot && Array.isArray(snapshot.positions) ? snapshot.positions : []
  return rows.filter((p) => p && p.instrumentId === instrumentId && isNonZero(p.size))
}

/**
 * 触发单形状（场所参数 spec.triggerShape 选，缺省 sell）：方向 + 远离参考价 40% 的触发价 + reason。
 * sell = 保护性止损（sell + stop_market，触发价在参考价下方，向下贴 tick）——其它场所一直用这个；
 * buy  = buy + stop_market，触发价在参考价上方（向上贴 tick）——给没有原生 reduce-only、
 *        平仓账户上卖触发单 = 开空会被拒的场所（IBKR）。两者都「永不触发」。
 */
const TRIGGER_SHAPES = {
  sell: {
    side: 'sell',
    price: (reference, tick) => snapDown(shiftBps(reference, -4000), tick),
    reason: 'testnet journey: protective-shape stop far below the book, must stay untriggered',
  },
  buy: {
    side: 'buy',
    price: (reference, tick) => snapUp(shiftBps(reference, 4000), tick),
    reason: 'testnet journey: buy-side stop far above the book, must stay untriggered',
  },
}

/** 纯函数：按形状给出触发单的方向 / 触发价 / reason；未知形状抛错。 */
export function triggerPlan(shape, referencePrice, tick) {
  const entry = Object.hasOwn(TRIGGER_SHAPES, shape) ? TRIGGER_SHAPES[shape] : undefined
  if (!entry) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `unknown trigger shape ${JSON.stringify(shape)}; expected sell or buy`)
  return { side: entry.side, triggerPrice: entry.price(referencePrice, tick), reason: entry.reason }
}

function isCancelSettled(status) {
  return typeof status === 'string' && /cancel|closed|expired/i.test(status)
}

/**
 * 跑一遍旅程。
 * @param {object} options
 * @param {string} options.venue            场所 id（只用于回执）
 * @param {object} options.connector        VenueConnector 形状（start/describe/accountState/book/getInstrument/submit/orderStatus/cancel/amend）
 * @param {string} options.accountId        协议账户 id（测试网上是个本地标签）
 * @param {string} options.instrumentId     协议标的 id（如 binance:BTCUSDT）
 * @param {string} [options.sizeHint]       期望下单量（会被场所步长与最小量修正）
 * @param {string[]} [options.secrets]      需要脱敏的密钥原文
 * @param {'sell'|'buy'} [options.triggerShape] 触发单形状（缺省 sell，见 TRIGGER_SHAPES）
 * @returns {Promise<{ok:boolean, exitCode:number, steps:object[], failedStep:string|null}>}
 */
export async function runJourney(options) {
  const {
    venue, connector, accountId, instrumentId, sizeHint, secrets = [], triggerShape = 'sell',
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
  } = options
  const redact = createRedactor(secrets)
  const steps = []
  let failure = null

  const accountRef = { accountId, address: ZERO_ADDRESS }
  const ctx = { account: accountRef, signer: { address: ZERO_ADDRESS, signTypedData: async () => '0x00' } }

  let snapshot = null
  let instrument = null
  let caps = null
  let limitPrice = null
  let referencePrice = null
  let size = null
  let limitClientId = null
  let limitVenueId = null
  let triggerClientId = null
  let triggerVenueId = null

  /** 名义额不足场所下限时按 2 倍递增到够（仍是极小单，只是不能在场所眼里小到被拒）。 */
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
      failure = { step: name, problem }
    }
  }

  await step('connect', async () => {
    await connector.start()
    caps = connector.describe()
    return `${venue} env=${connector.environment ?? 'unknown'} amend=${caps?.amend ?? 'unknown'}`
  })

  await step('account', async () => {
    snapshot = await connector.accountState(accountRef)
    const balances = Array.isArray(snapshot.balances) ? snapshot.balances.length : 0
    return `balances=${balances} positions=${Array.isArray(snapshot.positions) ? snapshot.positions.length : 0}`
  })

  await step('precondition-flat', async () => {
    const open = openPositionRows(snapshot, instrumentId)
    if (open.length > 0) {
      const sizes = open.map((p) => `${p.side}:${p.size}`).join(',')
      throw journeyProblem(
        JOURNEY_PROBLEM.PRECONDITION_POSITION_OPEN,
        `instrument ${instrumentId} already has a position (${sizes}); flatten the testnet account before running the journey`,
      )
    }
    return 'no position on the target instrument'
  })

  await step('instrument', async () => {
    instrument = connector.getInstrument(instrumentId)
    if (!instrument) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `instrument ${instrumentId} is not in the venue catalogue`)
    return `tick=${instrument.price.tick ?? 'n/a'} step=${instrument.size.step} min=${instrument.size.min} status=${instrument.status}`
  })

  await step('reference-price', async () => {
    // 优先用报价（各连接器都有 refreshQuote，一次请求）；没有报价才退回盘口。
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
    const reference = String(bid ?? ask)
    referencePrice = reference
    const tick = instrument.price.tick ?? '0.000001'
    limitPrice = snapDown(shiftBps(reference, -1500), tick)
    if (compareDecimal(limitPrice, '0') <= 0) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `computed limit price ${limitPrice} is not positive`)
    let wanted = sizeHint ?? instrument.size.min
    size = snapUp(wanted, instrument.size.step)
    if (compareDecimal(size, instrument.size.min) < 0) size = snapUp(instrument.size.min, instrument.size.step)
    size = ensureMinNotional(size, limitPrice)
    return `bid=${bid ?? 'n/a'} ask=${ask ?? 'n/a'} limit=${limitPrice} size=${size}`
  })

  await step('place-limit', async () => {
    const intent = {
      accountId,
      instrumentId,
      side: 'buy',
      type: 'limit',
      size,
      price: limitPrice,
      tif: 'gtc',
      reason: 'testnet journey: small limit order far from the book, must stay unfilled',
      clientOrderId: newClientOrderId(),
    }
    limitClientId = intent.clientOrderId
    const result = await connector.submit(ctx, [intent])
    const ack = firstAck(result, 'place-limit')
    if (ack.status === 'filled') {
      throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'limit order filled immediately: the price was not far enough from the book')
    }
    limitVenueId = ack.venueOrderId ?? null
    return `clientOrderId=${ack.clientOrderId} venueOrderId=${ack.venueOrderId ?? 'n/a'} status=${ack.status}`
  })

  await step('query-order', async () => {
    const status = await connector.orderStatus(accountRef, { clientOrderId: limitClientId, venueOrderId: limitVenueId ?? undefined })
    if (!status || status.found !== true) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'order not found right after placement')
    return `status=${status.status ?? 'unknown'} filled=${status.filledSize ?? 'n/a'}`
  })

  await step('amend', async () => {
    if (!caps || caps.amend === 'none') return 'skipped: venue declares amend=none'
    const tick = instrument.price.tick ?? '0.000001'
    const nextPrice = snapDown(shiftBps(limitPrice, -500), tick)
    const result = await connector.amend(ctx, {
      instrumentId,
      ...(limitVenueId ? { venueOrderId: limitVenueId } : {}),
      ...(limitClientId ? { clientOrderId: limitClientId } : {}),
      order: {
        accountId,
        instrumentId,
        side: 'buy',
        type: 'limit',
        size,
        price: nextPrice,
        tif: 'gtc',
        ...(limitClientId ? { clientOrderId: limitClientId } : {}),
        reason: 'testnet journey: amend the resting limit order further away from the book',
      },
    })
    const ack = firstAck(result, 'amend')
    if (ack.venueOrderId) limitVenueId = ack.venueOrderId
    return `${limitPrice} -> ${nextPrice} status=${ack.status}`
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
      last = await connector.orderStatus(accountRef, { clientOrderId: limitClientId, venueOrderId: limitVenueId ?? undefined })
      if (!last || last.found !== true) return 'not found after cancel (treated as cancelled)'
      if (isCancelSettled(last.status)) return `status=${last.status}`
    }
    throw journeyProblem(
      JOURNEY_PROBLEM.ORDER_STILL_LIVE,
      `order is still ${last && last.status ? last.status : 'present'} after cancel; the venue did not settle it`,
    )
  })

  await step('place-trigger', async () => {
    if (referencePrice === null) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'no reference price from the earlier step')
    const tick = instrument.price.tick ?? '0.000001'
    const plan = triggerPlan(triggerShape, referencePrice, tick)
    const triggerPrice = plan.triggerPrice
    triggerClientId = newClientOrderId()
    const triggerSize = ensureMinNotional(size, triggerPrice)
    const result = await connector.submit(ctx, [{
      accountId,
      instrumentId,
      side: plan.side,
      type: 'stop_market',
      size: triggerSize,
      triggerPrice,
      reduceOnly: false,
      reason: plan.reason,
      clientOrderId: triggerClientId,
    }])
    const ack = firstAck(result, 'place-trigger')
    triggerVenueId = ack.venueOrderId ?? null
    return `triggerPrice=${triggerPrice} size=${triggerSize} venueOrderId=${ack.venueOrderId ?? 'n/a'} status=${ack.status}`
  })

  await step('cancel-trigger', async () => {
    const acks = await connector.cancel(ctx, [{
      instrumentId,
      ...(triggerVenueId ? { venueOrderId: triggerVenueId } : {}),
      ...(triggerClientId ? { clientOrderId: triggerClientId } : {}),
    }])
    const ack = Array.isArray(acks) ? acks[0] : undefined
    if (!ack) throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, 'cancel-trigger returned no acknowledgement')
    if (!ack.ok) throw ackProblem(ack, 'cancel-trigger')
    return 'ok:true'
  })

  await step('positions-flat', async () => {
    const after = await connector.accountState(accountRef)
    const open = openPositionRows(after, instrumentId)
    if (open.length > 0) {
      const sizes = open.map((p) => `${p.side}:${p.size}`).join(',')
      throw journeyProblem(JOURNEY_PROBLEM.STEP_FAILED, `position is not flat after the journey (${sizes})`)
    }
    return 'flat'
  })

  const ok = failure === null
  if (!ok) log(`journey failed at step "${failure.step}"`)
  return { ok, exitCode: ok ? EXIT.OK : EXIT.FAILED, steps, failedStep: failure ? failure.step : null, problem: failure ? failure.problem : null }
}

/** 内核口径的 clientOrderId：32 位小写十六进制（所有五个连接器都接受）。 */
export function newClientOrderId() {
  return randomBytes(16).toString('hex')
}

/** 回执表（等宽文本；CJK 按两列宽算）。 */
export function formatTable(steps) {
  const width = (text) => {
    let w = 0
    for (const ch of String(text)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1
    return w
  }
  const pad = (text, target) => String(text) + ' '.repeat(Math.max(0, target - width(text)))
  const rows = [['#', 'step', 'ms', 'result', 'receipt']]
  steps.forEach((s, i) => rows.push([String(i + 1), s.name, String(s.skipped ? '-' : s.ms), s.skipped ? 'skip' : s.ok ? 'ok' : 'FAIL', s.receipt ?? '']))
  const widths = [0, 0, 0, 0, 0]
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i], width(cell)) })
  const lines = [rows[0].map((cell, i) => pad(cell, widths[i])).join('  ')]
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const row of rows.slice(1)) lines.push(row.map((cell, i) => pad(cell, widths[i])).join('  ').trimEnd())
  return lines.join('\n')
}
