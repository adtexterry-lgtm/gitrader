// SPDX-License-Identifier: CPAL-1.0
// 把一个场景装进假内核（SDK 的 testing 假内核或壳的夹具内核都行）：查询读场景数据，命令按人面规则要 PIN（缺证明回 ATTESTATION_REQUIRED，PIN 不对回 AUTH_FAILED），
// 命令成功后推送对应事件，和真内核的行为一致。仅测试 / 截图脚本用，不进浏览器包。
import type { LedgerEntry, Proposal } from '@gitrader/protocol'
import type { FakeKernel } from '@gitrader/blocks-sdk/testing'
import { entry, O_HUMAN, PIN, scenario, type Scenario, type ScenarioName } from './scenarios'

type Rec = Record<string, unknown>
const problem = (name: string, code: number, message: string) => Object.assign(new Error(message), { code, data: { code, name, message, category: 'PROTOCOL', retryable: false } })

/** 浏览器用例用的故障注入（IXD §14）：每次 load() 清空。 */
export interface Faults {
  /** 批准不要在场证明（流程 1 的用例不依赖壳的 PIN 弹层）。 */
  approveNoPin?: boolean
  /** 批准后执行失败：返回 status=failed 的提案，execution.problem.message = 这串原文（真内核 finishProposal 的形状）。 */
  approveFails?: string
  /** 批准后执行成功：返回 status=executed 的提案（真内核的成功路径；缺省仍回 approved，旧用例不变）。 */
  approveExecutes?: boolean
  /** 全部平仓不要在场证明。 */
  flattenNoPin?: boolean
  /** 全部平仓没平完：返回 {ok:false, remaining}，交易状态停在只减仓（真内核 TakeoverRecord 的形状）。 */
  flattenLeft?: Array<{ instrumentId: string; size: string }>
  /** 按命令名延迟（毫秒），看「执行中」。 */
  delayMs?: Record<string, number>
  /** 按命令名在在场证明之前直接失败，值是内核原文。 */
  fail?: Record<string, string>
  /** 查询一律延迟（毫秒），看骨架超时。 */
  queryDelayMs?: number
  /** r4：实盘账户的 position.close 先要在场证明（回 ATTESTATION_REQUIRED，壳弹 PIN）。 */
  closeNeedsPin?: boolean
  /** 返工 B-2：平仓市价单没有全部成交——partially_filled = 只成交一半（仓位减半，无 problem）；cancelled = 一笔没成（仓位不变，带 problem 原文）。 */
  closeStatus?: 'partially_filled' | 'cancelled'
  /** 返工：order.cancel 正常返回 {ok:false, problem:{message}}（不抛错），值是原文。 */
  cancelNotOk?: string
}

export interface Stage {
  sc: Scenario
  fault: Faults
  tradingState: 'ACTIVE' | 'REDUCING' | 'HALTED'
  /** 收到的命令（含有没有带在场证明）。 */
  calls: Array<{ action: string; params: Rec; attested: boolean }>
  now: number
  /** 切换场景（已打开的页面要重载才会重新查询）。 */
  load(name: ScenarioName): void
  /** 推一条账本条目（并按类型推对应事件），模拟 Agent 刚做了件事。 */
  emitLedger(e: LedgerEntry): void
  seq: number
}

const LEVEL_STATE = { halt_new: 'REDUCING', cancel_all: 'REDUCING', flatten_all: 'HALTED' } as const
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function installScenario(k: FakeKernel, initial: ScenarioName = 'normal'): Stage {
  const st: Stage = {
    sc: scenario(initial), fault: {}, tradingState: initial === 'halted' ? 'HALTED' : 'ACTIVE', calls: [], now: Date.now(), seq: 1000,
    load(name) { st.sc = scenario(name); st.fault = {}; st.tradingState = name === 'halted' ? 'HALTED' : 'ACTIVE' },
    emitLedger(e) { st.sc.ledger.unshift(e); k.publish('ledger.entry', e) },
  }
  const q = (method: string, fn: (p: Rec) => unknown) => k.onQuery(method, async (p) => {
    if (st.fault.queryDelayMs) await sleep(st.fault.queryDelayMs)
    if (st.sc.failing) throw problem('INTERNAL', -32603, '内核暂时读不到这份数据（演示用的读取失败场景）')
    return fn((p ?? {}) as Rec)
  })
  const acct = (p: Rec) => String(p.accountId ?? '')

  q('account.list', () => st.sc.accounts)
  q('account.positions', (p) => st.sc.positions[acct(p)] ?? [])
  q('account.summary', (p) => st.sc.summaries[acct(p)] ?? null)
  q('account.fills', (p) => st.sc.fills[acct(p)] ?? [])
  q('account.orders', (p) => st.sc.orders[acct(p)] ?? [])
  q('risk.state', () => ({ ...st.sc.risk, tradingState: st.tradingState }))
  q('risk.denials', () => st.sc.ledger.filter((e) => e.type === 'risk.denied'))
  q('proposal.list', (p) => st.sc.proposals.filter((x) => !p.status || x.status === p.status).slice(0, Number(p.limit ?? 50)))
  q('agentkey.list', () => st.sc.keys)
  q('mandate.list', () => st.sc.mandates)
  q('venue.status', () => st.sc.venues)
  // 壳每 2 s 查 status 来推导行情新鲜度（workbench/src/core/feed-state.ts，缺连接器 = 中断、涨跌色去掉）；夹具模拟「连接器在线、刚收到行情」。
  // 要演示中断 / 陈旧的用例（如 d1-feed-state.browser）在 applyPage 之后自己覆盖这条查询。
  k.onQuery('status', () => ({ accounts: st.sc.accounts.map((a) => ({ ...a, status: 'active' })), connectors: [{ id: 'venue_fixture', status: { wsState: 'connected', lastMessageTs: Date.now() } }] }))
  q('ledger.query', (p) => {
    const types = Array.isArray(p.types) ? (p.types as string[]) : null
    let rows = st.sc.ledger.filter((e) => (!types || types.includes(e.type)) && (!p.accountId || e.subject.accountId === p.accountId) && (!p.instrumentId || e.subject.instrumentId === p.instrumentId) && (!p.sinceTs || e.ts >= Number(p.sinceTs)))
    rows = [...rows].sort((a, b) => (p.order === 'asc' ? a.seq - b.seq : b.seq - a.seq))
    return rows.slice(0, Number(p.limit ?? 50))
  })

  const need = (action: string, params: unknown, ctx: { attestation?: unknown }, why: string) => {
    const att = ctx.attestation as { method?: string; pin?: string } | undefined
    st.calls.push({ action, params: (params ?? {}) as Rec, attested: !!att })
    if (!att) throw problem('ATTESTATION_REQUIRED', 1010, why)
    if (att.method !== 'pin' || att.pin !== PIN) throw problem('AUTH_FAILED', 5003, 'PIN 不对')
  }
  const record = (action: string, params: unknown, attested: boolean) => { st.calls.push({ action, params: (params ?? {}) as Rec, attested }) }
  /** 故障注入：先等（看执行中），再按需在在场证明之前失败（失败也记一次调用）。 */
  const pre = async (action: string, params: unknown, ctx: { attestation?: unknown }) => {
    const d = st.fault.delayMs?.[action]
    if (d) await sleep(d)
    const f = st.fault.fail?.[action]
    if (f) { record(action, params, !!ctx.attestation); throw problem('INVALID_PARAMS', -32602, f) }
  }
  const led = (type: LedgerEntry['type'], subject: LedgerEntry['subject'], payload: Rec): void => { st.emitLedger(entry(++st.seq, type, O_HUMAN, subject, payload, Date.now())) }

  const decide = (p: Rec, status: 'approved' | 'rejected'): Proposal => {
    const prop = st.sc.proposals.find((x) => x.proposalId === p.id)
    if (!prop) throw problem('NOT_FOUND', 1010, `没有这张提案：${String(p.id)}`)
    const next = { ...prop, status, decision: { by: 'user:usr_local', at: Date.now() } } as unknown as Proposal
    st.sc.proposals = st.sc.proposals.map((x) => (x.proposalId === prop.proposalId ? next : x))
    k.publish('proposal.decided', next)
    led('proposal.decided', { proposalId: prop.proposalId, ticket: prop.ticket }, { decision: status })
    return next
  }

  k.onCommand('proposal.approve', async (p, ctx) => {
    await pre('proposal.approve', p, ctx)
    if (st.fault.approveNoPin) record('proposal.approve', p, !!ctx.attestation)
    else need('proposal.approve', p, ctx, '批准提案需要在场证明')
    const next = decide((p ?? {}) as Rec, 'approved')
    if (st.fault.approveExecutes) {
      const done = { ...next, status: 'executed', execution: { orderIds: [], at: Date.now(), result: 'ok' } } as unknown as Proposal
      st.sc.proposals = st.sc.proposals.map((x) => (x.proposalId === done.proposalId ? done : x))
      k.publish('proposal.executed', done)
      led('proposal.executed', { proposalId: done.proposalId, ticket: done.ticket }, { result: 'ok' })
      return done
    }
    if (!st.fault.approveFails) return next
    // 批准后重新预检 / 价格边界没过：提案正常返回，但 status = failed（不是抛错）
    const failed = { ...next, status: 'failed', execution: { orderIds: [], at: Date.now(), result: 'rejected', problem: { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: st.fault.approveFails, retryable: false } } } as unknown as Proposal
    st.sc.proposals = st.sc.proposals.map((x) => (x.proposalId === failed.proposalId ? failed : x))
    k.publish('proposal.failed', failed)
    led('proposal.failed', { proposalId: failed.proposalId, ticket: failed.ticket }, { result: 'rejected' })
    return failed
  })
  k.onCommand('proposal.reject', (p) => { record('proposal.reject', p, false); return decide((p ?? {}) as Rec, 'rejected') })
  k.onCommand('mandate.update', async (p, ctx) => {
    await pre('mandate.update', p, ctx)
    need('mandate.update', p, ctx, '改 Agent 权限需要在场证明')
    const { mandateId, input } = (p ?? {}) as { mandateId: string; input: Rec }
    const cur = st.sc.mandates.find((m) => m.mandateId === mandateId)
    if (!cur) throw problem('NOT_FOUND', 1010, `没有这份授权：${mandateId}`)
    if (input.level === 'L3' && !input.heartbeat) throw problem('INVALID_PARAMS', -32602, 'L3 requires heartbeat')
    const next = { ...cur, level: input.level, version: cur.version + 1 } as typeof cur
    st.sc.mandates = st.sc.mandates.map((m) => (m.mandateId === mandateId ? next : m))
    k.publish('mandate.changed', next)
    return next
  })
  k.onCommand('risk.setLlmLiveEntries', (p, ctx) => {
    const deny = (p as Rec | undefined)?.deny !== false
    if (!deny) need('risk.setLlmLiveEntries', p, ctx, '关闭大模型实盘开仓保护需要在场证明')
    else record('risk.setLlmLiveEntries', p, false)
    st.sc.risk = { ...st.sc.risk, denyLlmLiveEntries: deny, policy: { ...(st.sc.risk.policy as Rec), denyLlmLiveEntries: deny } }
    k.publish('risk.state', { kind: 'policy', version: 4, ts: Date.now() })
    return { ok: true }
  })
  for (const level of ['halt_new', 'cancel_all', 'flatten_all'] as const) {
    k.onCommand(`takeover.${level}`, async (p, ctx) => {
      await pre(`takeover.${level}`, p, ctx)
      if (level === 'flatten_all' && !st.fault.flattenNoPin) need(`takeover.${level}`, p, ctx, '全部平仓需要在场证明')
      else record(`takeover.${level}`, p, !!ctx.attestation)
      const reason = (p as Rec | undefined)?.reason
      led('takeover.requested', { orgId: 'org_local' as never }, { level, reason })
      // 和真内核一样（kernel/src/takeover.ts）：接管只收紧；全部平仓没平完 → ok:false + remaining，停在只减仓，记 takeover.failed
      const left = level === 'flatten_all' ? st.fault.flattenLeft : undefined
      if (left) {
        if (st.tradingState === 'ACTIVE') st.tradingState = 'REDUCING'
        k.publish('risk.state', { scope: { type: 'org' }, to: st.tradingState, reason: 'takeover', ts: Date.now() })
        led('takeover.failed', { orgId: 'org_local' as never }, { level, reason, remaining: left })
        return { ok: false, level, stateAfter: st.tradingState, cancelled: 0, closeOrders: left.length, remaining: left }
      }
      if (st.tradingState !== 'HALTED') st.tradingState = LEVEL_STATE[level]
      k.publish('risk.state', { scope: { type: 'org' }, to: st.tradingState, reason: 'takeover', ts: Date.now() })
      led('takeover.completed', { orgId: 'org_local' as never }, { level, cancelled: 0, closeOrders: 0, tradingStateAfter: st.tradingState })
      return { ok: true, level, stateAfter: st.tradingState, cancelled: 0, closeOrders: 0 }
    })
  }
  k.onCommand('trading_state.resume', (p, ctx) => {
    need('trading_state.resume', p, ctx, '恢复交易需要在场证明')
    st.tradingState = 'ACTIVE'
    k.publish('risk.state', { scope: { type: 'org' }, to: 'ACTIVE', ts: Date.now() })
    return { ok: true }
  })
  k.onCommand('venue.reconnect', (p) => { record('venue.reconnect', p, false); return { ok: true } })

  // r4 持仓卡行内动作：形状照真内核（trading.ts closePosition / place 回 PlaceResult {order}；cancel 回 {ok}），成功后推 account.positions / account.orders。
  let lastTs = 0
  const stamp = () => (lastTs = Math.max(Date.now(), lastTs + 1))
  const putOrder = (o: Rec) => {
    const a = String(o.accountId)
    st.sc.orders[a] = [...(st.sc.orders[a] ?? []).filter((x) => x.orderId !== o.orderId), o]
    k.publish('account.orders', o)
    return o
  }
  const newOrder = (intent: Rec, status: string, filled: boolean): Rec => {
    const ts = stamp()
    return {
      orderId: `ord_r4_${ts}`, clientOrderId: `r4${ts}`, accountId: intent.accountId, instrumentId: intent.instrumentId, side: intent.side, type: intent.type, tif: 'gtc',
      size: intent.size, filledSize: filled ? intent.size : '0', ...(intent.triggerPrice ? { triggerPrice: intent.triggerPrice } : {}), reduceOnly: intent.reduceOnly === true,
      status, fee: '0', origin: O_HUMAN, createdAt: ts, updatedAt: ts,
    }
  }
  k.onCommand('position.close', async (p, ctx) => {
    await pre('position.close', p, ctx)
    const a = acct((p ?? {}) as Rec)
    const live = (st.sc.accounts.find((x) => x.accountId === a) as Rec | undefined)?.mode === 'live'
    if (st.fault.closeNeedsPin && live) need('position.close', p, ctx, '实盘平仓需要在场证明')
    else record('position.close', p, !!ctx.attestation)
    const { instrumentId, size } = (p ?? {}) as { instrumentId?: string; size?: string }
    const list = st.sc.positions[a] ?? []
    const pos = list.find((x) => x.instrumentId === instrumentId)
    if (!pos) throw problem('INVALID_PARAMS', -32602, `no open position in ${String(instrumentId)}`)
    const want = size ? Math.min(Number(size), Number(pos.size)) : Number(pos.size)
    const cs = st.fault.closeStatus
    const take = cs === 'cancelled' ? 0 : cs === 'partially_filled' ? Math.round((want / 2) * 1e8) / 1e8 : want
    const left = Math.round((Number(pos.size) - take) * 1e8) / 1e8
    const next = left > 0 ? ({ ...pos, size: String(left) } as typeof pos) : null
    st.sc.positions[a] = next ? list.map((x) => (x === pos ? next : x)) : list.filter((x) => x !== pos)
    const base = newOrder({ accountId: a, instrumentId, side: pos.side === 'long' ? 'sell' : 'buy', type: 'market', size: String(want), reduceOnly: true }, cs ?? 'filled', !cs)
    const order = putOrder(cs ? { ...base, filledSize: String(take), ...(cs === 'cancelled' ? { problem: { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: 'Order could not immediately match against any resting orders.', retryable: false } } : {}) } : base)
    if (take > 0) k.publish('account.positions', { accountId: a, instrumentId, position: next })
    return { order }
  })
  k.onCommand('order.place', async (p, ctx) => {
    await pre('order.place', p, ctx)
    record('order.place', p, !!ctx.attestation)
    const intent = ((p ?? {}) as Rec).intent as Rec | undefined
    if (!intent) throw problem('INVALID_PARAMS', -32602, 'order.place requires confirmToken or intent')
    return { order: putOrder(newOrder(intent, intent.type === 'stop_market' ? 'untriggered' : 'open', false)) }
  })
  k.onCommand('order.cancel', async (p, ctx) => {
    await pre('order.cancel', p, ctx)
    record('order.cancel', p, !!ctx.attestation)
    const { orderId } = (p ?? {}) as { orderId?: string }
    const a = acct((p ?? {}) as Rec)
    const o = (st.sc.orders[a] ?? []).find((x) => x.orderId === orderId)
    if (!o) throw problem('ACCOUNT_NOT_BOUND', 2101, 'order not found for this account')
    if (st.fault.cancelNotOk) return { ok: false, problem: { code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: st.fault.cancelNotOk, retryable: false } }
    putOrder({ ...o, status: 'cancelled', updatedAt: stamp() })
    return { ok: true }
  })
  return st
}
