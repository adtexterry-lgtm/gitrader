// SPDX-License-Identifier: CPAL-1.0
// 订单与成交存储（当前状态；变化历史在账本里）。成交按 (accountId, venueFillId) 去重。
import type { Fill, Order } from './proto'
import type { Db } from './db'
import * as d from './util/dec'

const OPEN = ['new', 'submitted', 'open', 'untriggered', 'partially_filled']

export class OrderStore {
  constructor(private db: Db) {}

  upsert(o: Order, notional: string, opening: boolean): void {
    this.db.prepare(
      `INSERT INTO orders(order_id,client_order_id,venue_order_id,account_id,mandate_id,proposal_id,instrument_id,status,created_at,updated_at,notional,opening,doc)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(order_id) DO UPDATE SET status=excluded.status, venue_order_id=excluded.venue_order_id, updated_at=excluded.updated_at, doc=excluded.doc`,
    ).run(o.orderId, o.clientOrderId, o.venueOrderId ?? null, o.accountId, o.mandateId ?? null, o.proposalId ?? null, o.instrumentId, o.status, o.createdAt, o.updatedAt, notional, opening ? 1 : 0, JSON.stringify(o))
  }
  /** Explicit amendment updates the risk notional; ordinary status upserts retain it. */
  amend(order: Order, notional: string): void {
    this.upsert(order, notional, !order.reduceOnly)
    this.db.prepare('UPDATE orders SET notional=?, opening=? WHERE order_id=?').run(notional, order.reduceOnly ? 0 : 1, order.orderId)
  }
  get(orderId: string): Order | undefined {
    const r = this.db.prepare('SELECT doc FROM orders WHERE order_id=?').get(orderId) as { doc: string } | undefined
    return r ? (JSON.parse(r.doc) as Order) : undefined
  }
  byVenueOrderId(accountId: string, venueOrderId: string): Order | undefined {
    const r = this.db.prepare('SELECT doc FROM orders WHERE account_id=? AND venue_order_id=?').get(accountId, venueOrderId) as { doc: string } | undefined
    return r ? (JSON.parse(r.doc) as Order) : undefined
  }
  byClientOrderId(cloid: string): Order | undefined {
    const r = this.db.prepare('SELECT doc FROM orders WHERE client_order_id=?').get(cloid) as { doc: string } | undefined
    return r ? (JSON.parse(r.doc) as Order) : undefined
  }
  list(q: { accountId?: string; openOnly?: boolean; limit?: number } = {}): Order[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.accountId) { where.push('account_id=?'); args.push(q.accountId) }
    if (q.openOnly) where.push(`status IN (${OPEN.map((s) => `'${s}'`).join(',')})`)
    const sql = `SELECT doc FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${Math.min(q.limit ?? 100, 1000)}`
    return (this.db.prepare(sql).all(...args) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Order)
  }
  /** 某时刻起该账户的订单（不含被风控拒绝的），新的在前。 */
  since(accountId: string, sinceTs: number, limit = 200): Order[] {
    return (this.db.prepare(`SELECT doc FROM orders WHERE account_id=? AND created_at>=? AND status NOT IN ('denied','rejected') ORDER BY created_at DESC LIMIT ?`).all(accountId, sinceTs, limit) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Order)
  }
  /** Poll view: retain every open order plus recent effective terminal orders, without a result cap. */
  forPolling(accountId: string, sinceMs: number): Order[] {
    return (this.db.prepare(`SELECT doc FROM orders WHERE account_id=? AND status NOT IN ('denied','rejected') AND (status IN (${OPEN.map((s) => `'${s}'`).join(',')}) OR updated_at>=?) ORDER BY updated_at ASC, order_id ASC`).all(accountId, sinceMs) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Order)
  }
  /** 某时刻起的有效下单名义总和（不含被风控拒绝 / 场所拒绝的单）。 */
  notionalSince(accountId: string, sinceTs: number, mandateId?: string): d.Dec {
    const rows = (mandateId
      ? this.db.prepare(`SELECT notional FROM orders WHERE mandate_id=? AND created_at>=? AND opening=1 AND status NOT IN ('denied','rejected')`).all(mandateId, sinceTs)
      : this.db.prepare(`SELECT notional FROM orders WHERE account_id=? AND created_at>=? AND opening=1 AND status NOT IN ('denied','rejected')`).all(accountId, sinceTs)) as { notional: string }[]
    return rows.reduce((s, r) => d.add(s, d.D(r.notional)), d.ZERO)
  }
  countSince(accountId: string, sinceTs: number, mandateId?: string): number {
    const r = (mandateId
      ? this.db.prepare(`SELECT COUNT(*) c FROM orders WHERE mandate_id=? AND created_at>=? AND status NOT IN ('denied') AND json_extract(doc,'$.parentOrderId') IS NULL`).get(mandateId, sinceTs)
      : this.db.prepare(`SELECT COUNT(*) c FROM orders WHERE account_id=? AND created_at>=? AND status NOT IN ('denied') AND json_extract(doc,'$.parentOrderId') IS NULL`).get(accountId, sinceTs)) as { c: number }
    // Count issued tickets durably, including rejected/unknown outcomes; legacy successes count once.
    let amended: number
    if (mandateId) {
      const issued = this.db.prepare(`
        SELECT COUNT(*) c FROM ledger l
        WHERE l.mandate_id=? AND l.ts>=? AND l.type='annotation'
          AND json_extract(l.entry,'$.payload.kind')='amend.issued'
      `).get(mandateId, sinceTs) as { c: number }
      const legacy = this.db.prepare(`
        SELECT COUNT(*) c FROM ledger l LEFT JOIN orders o ON o.order_id=l.order_id
        WHERE (l.mandate_id=? OR (l.mandate_id IS NULL AND o.mandate_id=?)) AND l.ts>=?
          AND l.type='order.amended' AND NOT EXISTS (
            SELECT 1 FROM ledger issued WHERE issued.order_id=l.order_id AND issued.type='annotation'
            AND json_extract(issued.entry,'$.payload.kind')='amend.issued'
            AND json_extract(issued.entry,'$.payload.ticketId')=json_extract(l.entry,'$.payload.gate.ticketId'))
      `).get(mandateId, mandateId, sinceTs) as { c: number }
      amended = issued.c + legacy.c
    } else {
      const accountAmended = this.db.prepare(`
        SELECT COUNT(*) c FROM ledger l LEFT JOIN orders o ON o.order_id=l.order_id
        WHERE l.account_id=? AND l.ts>=?
          AND ((l.type='annotation' AND json_extract(l.entry,'$.payload.kind')='amend.issued')
            OR (l.type='order.amended' AND NOT EXISTS (
              SELECT 1 FROM ledger issued WHERE issued.order_id=l.order_id AND issued.type='annotation'
              AND json_extract(issued.entry,'$.payload.kind')='amend.issued'
              AND json_extract(issued.entry,'$.payload.ticketId')=json_extract(l.entry,'$.payload.gate.ticketId'))))
      `).get(accountId, sinceTs) as { c: number }
      amended = accountAmended.c
    }
    return r.c + amended
  }
  lastOpenTs(accountId: string): number | undefined {
    const r = this.db.prepare(`SELECT MAX(created_at) t FROM orders WHERE account_id=? AND opening=1 AND status NOT IN ('denied','rejected')`).get(accountId) as { t: number | null }
    return r.t ?? undefined
  }

  /** 成交去重插入；返回 false 表示已存在。 */
  fillWithId(f: Pick<Fill, 'accountId' | 'venueFillId' | 'fillId'>): Fill | undefined {
    const row = this.db.prepare('SELECT doc FROM fills WHERE (account_id=? AND venue_fill_id=?) OR fill_id=?')
      .get(f.accountId, f.venueFillId, f.fillId) as { doc: string } | undefined
    return row ? JSON.parse(row.doc) as Fill : undefined
  }

  insertFill(f: Fill): boolean {
    const r = this.db.prepare('INSERT INTO fills(fill_id,account_id,venue_fill_id,order_id,instrument_id,ts,doc) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,venue_fill_id) DO NOTHING')
      .run(f.fillId, f.accountId, f.venueFillId, f.orderId, f.instrumentId, f.ts, JSON.stringify(f))
    return Number(r.changes) > 0
  }
  fills(q: { accountId?: string; orderId?: string; limit?: number } = {}): Fill[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (q.accountId) { where.push('account_id=?'); args.push(q.accountId) }
    if (q.orderId) { where.push('order_id=?'); args.push(q.orderId) }
    const sql = `SELECT doc FROM fills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${Math.min(q.limit ?? 100, 1000)}`
    return (this.db.prepare(sql).all(...args) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Fill)
  }
  /** Complete local history for a single confirmed order; unlike the public page, this query has no row cap. */
  fillsForOrder(accountId: string, orderId: string): Fill[] {
    return (this.db.prepare('SELECT doc FROM fills WHERE account_id=? AND order_id=? ORDER BY ts, rowid').all(accountId, orderId) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Fill)
  }
  fillsSince(accountId: string, sinceTs: number): Fill[] {
    return (this.db.prepare('SELECT doc FROM fills WHERE account_id=? AND ts>=? ORDER BY ts').all(accountId, sinceTs) as { doc: string }[]).map((r) => JSON.parse(r.doc) as Fill)
  }

  /** 用全部已入账成交重建净仓归属；混合开仓者保持混合，不猜测部分减仓归谁。 */
  positionOwners(accountId: string, instrumentId: string): { net: string; actors: string[] } {
    const rows = this.db.prepare('SELECT f.doc AS fill, o.doc AS ord FROM fills f LEFT JOIN orders o ON o.order_id=f.order_id WHERE f.account_id=? AND f.instrument_id=? ORDER BY f.ts,f.rowid')
      .all(accountId, instrumentId) as { fill: string; ord: string | null }[]
    let net = d.ZERO
    const actors = new Set<string>()
    for (const row of rows) {
      const f = JSON.parse(row.fill) as Fill
      const actor = row.ord ? (JSON.parse(row.ord) as Order).origin.actor : 'unknown'
      const delta = f.side === 'buy' ? d.D(f.size) : d.neg(d.D(f.size))
      const next = d.add(net, delta)
      if (d.isZero(net) || (d.isNeg(net) !== d.isNeg(next) && !d.isZero(next))) { actors.clear(); actors.add(actor) }
      else if (d.isNeg(net) === d.isNeg(delta)) actors.add(actor)
      if (d.isZero(next)) actors.clear()
      net = next
    }
    return { net: d.str(net), actors: [...actors] }
  }
}
