// SPDX-License-Identifier: CPAL-1.0
// fix-r2 S1（ADR-16）：纸面状态按账本重建（账本是真源）+ 纸面状态与账本的对照审计（doctor / paper.audit 用）。
// 内核不依赖 venue-paper：这里只整理「事实」，真正的记账由调用方注入的纸面场所 rebuildFromLedgerFacts 做（与真实成交同一套算法）。
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { Kernel } from './kernel'
import type { LedgerEntry, Order } from './proto'
import { maxPaperSeqs, recordPaperState } from './paper-integrity'
import { systemOrigin } from './util/origin'
import * as d from './util/dec'
import { writeFileAtomic } from './util/fsperm'

export interface PaperRebuildFacts {
  orderSeq: number
  fillSeq: number
  accounts: Array<{
    accountId: string; initialBalance: string; ccy?: string; createdAt: number
    fills: Array<{ instrumentId: string; side: 'buy' | 'sell'; price: string; size: string; fee: string; leverage: number; ts: number }>
    funding: Array<{ instrumentId: string; amount: string; ts: number }>
    openOrders: Array<{
      venueOrderId: string; clientOrderId: string; instrumentId: string; side: 'buy' | 'sell'; type: string; tif: 'gtc' | 'ioc' | 'alo'
      size: string; filledSize: string; price: string | null; triggerPrice: string | null; reduceOnly: boolean; leverage: number
      role: 'parent' | 'tp' | 'sl'; parentVenueOrderId?: string; waitingParent: boolean; status: 'open' | 'untriggered' | 'partially_filled'; createdAt: number
    }>
  }>
}

/** 账本推算的期望值（十进制字符串）：现金 = 初始 + Σ已实现 − Σ手续费 + Σ资金费；持仓 = 成交逐笔累计的净数量。 */
export interface PaperLedgerExpectation { accountId: string; cash: string; realized: string; fees: string; funding: string; netSize: Record<string, string> }

const SIM_ORDER = /^sim-\d+$/
const SIM_FILL = /^simf-(\d+)$/
const LIVE = new Set(['open', 'untriggered', 'partially_filled'])

function* accountEntries(k: Kernel, accountId: string): Generator<LedgerEntry> {
  const stmt = k.db.prepare('SELECT entry FROM ledger WHERE account_id=? ORDER BY seq')
  for (const r of stmt.iterate(accountId) as Iterable<{ entry: string }>) yield JSON.parse(r.entry) as LedgerEntry
}

/** 从账本 + 订单表整理每个纸面账户的事实（自最近一次 paper.reset 起）。 */
export function paperLedgerFacts(k: Kernel): { facts: PaperRebuildFacts; expectations: PaperLedgerExpectation[] } {
  const accounts = k.accounts.list().filter((a) => a.mode !== 'live' && !!a.paper)
  let orderSeq = 0, fillSeq = 0
  const out: PaperRebuildFacts['accounts'] = []
  const expectations: PaperLedgerExpectation[] = []
  for (const a of accounts) {
    let initial: string = a.paper!.initialBalance
    let createdAt = k.clock.now()
    let fills: PaperRebuildFacts['accounts'][number]['fills'] = []
    let funding: PaperRebuildFacts['accounts'][number]['funding'] = []
    let realized = d.ZERO, fees = d.ZERO, fundingSum = d.ZERO
    let first = true
    for (const e of accountEntries(k, a.accountId)) {
      if (first) { createdAt = e.ts; first = false }
      const p = (e.payload ?? {}) as Record<string, unknown>
      if (e.type === 'annotation' && p.action === 'paper.reset') {
        initial = typeof p.initialBalance === 'string' ? p.initialBalance : initial
        fills = []; funding = []; realized = d.ZERO; fees = d.ZERO; fundingSum = d.ZERO; createdAt = e.ts
        continue
      }
      if (e.type === 'fill' && typeof p.price === 'string' && typeof p.size === 'string') {
        const order = e.subject.orderId ? k.orders.get(String(e.subject.orderId)) : undefined
        fills.push({ instrumentId: String(e.subject.instrumentId), side: p.side === 'sell' ? 'sell' : 'buy', price: p.price, size: p.size, fee: typeof p.fee === 'string' ? p.fee : '0', leverage: order?.leverage ?? 1, ts: typeof p.venueTs === 'number' ? p.venueTs : e.ts })
        realized = d.add(realized, d.D(typeof p.realizedPnl === 'string' ? p.realizedPnl : '0'))
        fees = d.add(fees, d.D(typeof p.fee === 'string' ? p.fee : '0'))
        const m = SIM_FILL.exec(String(e.venueRef?.nativeFillId ?? ''))
        if (m) fillSeq = Math.max(fillSeq, Number(m[1]))
      }
      if (e.type === 'funding' && typeof p.amount === 'string') {
        funding.push({ instrumentId: String(e.subject.instrumentId), amount: p.amount, ts: e.ts })
        fundingSum = d.add(fundingSum, d.D(p.amount))
      }
    }
    const all: Order[] = k.orders.list({ accountId: a.accountId, openOnly: true, limit: 1000 })
    const seqs = maxPaperSeqs(k.db, [a.accountId])
    orderSeq = Math.max(orderSeq, seqs.orderSeq)
    fillSeq = Math.max(fillSeq, seqs.fillSeq)
    const openOrders = all.filter((o) => LIVE.has(o.status) && !!o.venueOrderId && SIM_ORDER.test(o.venueOrderId) && !(o.parentOrderId && !o.tpslRole)).map((o) => {
      const parent = o.parentOrderId ? k.orders.get(o.parentOrderId) : undefined
      return {
        venueOrderId: o.venueOrderId!, clientOrderId: o.parentOrderId ? o.venueOrderId! : o.clientOrderId, instrumentId: o.instrumentId, side: o.side, type: o.type,
        tif: (o.tif === 'ioc' || o.tif === 'alo' ? o.tif : 'gtc') as 'gtc' | 'ioc' | 'alo', size: o.size, filledSize: o.filledSize, price: o.price ?? null, triggerPrice: o.triggerPrice ?? null,
        reduceOnly: o.reduceOnly === true, leverage: o.leverage ?? 1, role: (o.tpslRole ?? 'parent') as 'parent' | 'tp' | 'sl',
        ...(parent?.venueOrderId ? { parentVenueOrderId: parent.venueOrderId } : {}),
        waitingParent: !!parent && parent.status !== 'filled', status: o.status as 'open' | 'untriggered' | 'partially_filled', createdAt: o.createdAt,
      }
    })
    out.push({ accountId: a.accountId, initialBalance: initial, ...(a.paper!.ccy ? { ccy: a.paper!.ccy } : {}), createdAt, fills, funding, openOrders })
    const net: Record<string, d.Dec> = {}
    for (const f of fills) net[f.instrumentId] = d.add(net[f.instrumentId] ?? d.ZERO, f.side === 'buy' ? d.D(f.size) : d.neg(d.D(f.size)))
    expectations.push({
      accountId: a.accountId, realized: d.str(realized), fees: d.str(fees), funding: d.str(fundingSum),
      cash: d.str(d.add(d.sub(d.add(d.D(initial), realized), fees), fundingSum)),
      netSize: Object.fromEntries(Object.entries(net).filter(([, v]) => !d.eq(v, d.ZERO)).map(([k2, v]) => [k2, d.str(v)])),
    })
  }
  return { facts: { orderSeq, fillSeq, accounts: out }, expectations }
}

/**
 * 重建：调用方给出纸面场所的 rebuildFromLedgerFacts（返回状态串）。原文件改名为 paper-state.json.corrupt-<时间>（不删），写新文件并登记摘要，账本留痕。
 * 服务必须没在跑（由 CLI 保证）。
 */
export function rebuildPaperStateFromLedger(k: Kernel, build: (facts: PaperRebuildFacts) => string): { file: string; backup?: string; expectations: PaperLedgerExpectation[] } {
  const { facts, expectations } = paperLedgerFacts(k)
  const state = build(facts)
  const file = join(k.home, 'paper-state.json')
  let backup: string | undefined
  if (existsSync(file)) {
    backup = `${file}.corrupt-${new Date(k.clock.now()).toISOString().replace(/[:.]/g, '-')}`
    renameSync(file, backup)
  }
  writeFileAtomic(file, state)
  recordPaperState(k.db, state, k.clock.now(), k.ledger.head().seq)
  k.ledger.append({
    type: 'annotation', origin: systemOrigin('cli:paper.rebuild-from-ledger'), subject: { orgId: 'org_local' },
    payload: { kind: 'paper.rebuilt', ...(backup ? { backup: backup.slice(k.home.length + 1) } : {}), orderSeq: facts.orderSeq, fillSeq: facts.fillSeq, accounts: expectations.map((x) => ({ accountId: x.accountId, cash: x.cash, netSize: x.netSize, fills: facts.accounts.find((a) => a.accountId === x.accountId)?.fills.length ?? 0 })) },
  })
  return { file, ...(backup ? { backup } : {}), expectations }
}
