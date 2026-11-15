// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Order } from '@gitrader/protocol'
import { openDb } from '../src/db'
import { makeHarness } from './helpers/harness'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('ledger amendment indexes', () => {
  it('openDb creates account and mandate time indexes for a new database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitrader-c1i-'))
    dirs.push(dir)
    const db = openDb(join(dir, 'fresh.sqlite'))
    try {
      const names = (db.prepare("PRAGMA index_list('ledger')").all() as { name: string }[]).map(row => row.name)
      expect(names).toEqual(expect.arrayContaining(['ledger_account_ts', 'ledger_mandate_ts']))
    } finally { db.close() }
  })

  it('upgrades an old version-two database and stays idempotent when reopened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitrader-c1i-old-'))
    dirs.push(dir)
    const path = join(dir, 'old.sqlite')
    const old = openDb(path)
    old.exec('DROP INDEX ledger_account_ts; DROP INDEX ledger_mandate_ts; PRAGMA user_version = 2')
    old.close()

    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openDb(path)
      try {
        const names = (db.prepare("PRAGMA index_list('ledger')").all() as { name: string }[]).map(row => row.name)
        expect(names).toEqual(expect.arrayContaining(['ledger_account_ts', 'ledger_mandate_ts']))
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
      } finally { db.close() }
    }
  })

  it('counts issued and legacy amendments by mandate or account with ticket de-duplication and time boundaries', async () => {
    const h = await makeHarness()
    try {
      const now = h.clock.now()
      const since = now - 1_000
      const mandateA = 'mandate_c1i_a'
      const mandateB = 'mandate_c1i_b'
      const mandateOtherAccount = 'mandate_c1i_other_account'
      const account = h.paper.accountId
      const otherAccount = h.liveAcct.accountId
      const addOrder = (id: string, accountId: string, mandateId: string, createdAt = 1) => {
        const order = {
          orderId: id as never, clientOrderId: `${id}_client` as never, accountId: accountId as Order['accountId'],
          instrumentId: 'BTC-PERP' as never, side: 'buy', type: 'limit', tif: 'gtc',
          size: '1' as never, filledSize: '0' as never, status: 'open', fee: '0' as never, mandateId: mandateId as never,
          origin: h.human().origin, createdAt, updatedAt: createdAt,
        } satisfies Order
        h.k.orders.upsert(order, '1', true)
        return order
      }
      const issued = (ticketId: string, accountId: string, mandateId: string, at: number, orderId = `issued_${ticketId}`) => {
        h.k.ledger.append({ type: 'annotation', origin: h.human().origin, ts: at,
          subject: { accountId: accountId as never, orderId: orderId as never, mandateId: mandateId as never },
          payload: { kind: 'amend.issued', ticketId } })
      }
      const legacy = (ticketId: string, order: Order, at: number, mandateId?: string) => {
        h.k.ledger.append({ type: 'order.amended', origin: h.human().origin, ts: at,
          subject: { accountId: order.accountId, orderId: order.orderId, ...(mandateId ? { mandateId: mandateId as never } : {}) },
          payload: { orderId: order.orderId, before: { size: '1' }, after: { size: '2' }, gate: { ticketId } } })
      }

      issued('ticket_direct', account, mandateA, now - 300)
      issued('ticket_other_mandate', account, mandateB, now - 300)
      issued('ticket_other_account', otherAccount, mandateOtherAccount, now - 300)
      issued('ticket_before_window', account, mandateA, now - 2_000)

      const fallback = addOrder('ord_c1i_fallback', account, mandateA)
      legacy('ticket_legacy_fallback', fallback, now - 250)
      const dedup = addOrder('ord_c1i_dedup', account, mandateA)
      issued('ticket_same', account, mandateA, now - 200, dedup.orderId)
      legacy('ticket_same', dedup, now - 150)
      const preferred = addOrder('ord_c1i_preferred', account, mandateB)
      legacy('ticket_preferred', preferred, now - 100, mandateA)

      expect(h.k.orders.countSince(account, since, mandateA)).toBe(4)
      expect(h.k.orders.countSince(account, since, mandateB)).toBe(1)
      expect(h.k.orders.countSince(account, since, mandateOtherAccount)).toBe(1)
      expect(h.k.orders.countSince(account, since)).toBe(5)
      expect(h.k.orders.countSince(account, now - 100, mandateA)).toBe(1)
    } finally { await h.cleanup() }
  })
})
