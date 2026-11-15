// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { OrderIntent, Position, ReconcileAccountView, ReconcileConfirmInput, ReconcileFindingView, ReconcileResolutionInput, ReconcileReviewItem } from '@gitrader/protocol'
import type { VenueFill } from '../../protocol/src/connector/trade'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { FakeConnector } from '../../kernel/test/helpers/fake-connector'
import { fileProvider } from '../../kernel/src/device-key'
import { newClientOrderId, newId } from '../../kernel/src/util/ids'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'

const PIN = '482916'
let home: string
let service: ServeHandle | undefined
let connector: FakeConnector | undefined
let output: string[]
let errors: string[]
let secretQueue: string[]
let prompts = 0

function io(readSecret?: (prompt: string) => Promise<string>): CliIo {
  return {
    out: (value) => output.push(value), err: (value) => errors.push(value), env: { GITRADER_HOME: home },
    interactive: true, deviceKey: fileProvider,
    readSecret: readSecret ?? (async () => { prompts++; const value = secretQueue.shift(); if (value === undefined) throw new Error('test secret input cancelled'); return value }),
  }
}

async function run(args: string[], readSecret?: (prompt: string) => Promise<string>): Promise<number> {
  output = []
  errors = []
  return main(args, io(readSecret))
}

async function start(): Promise<void> {
  service = await runServe(home, { port: 0, io: io(), connectors: false, connect: (kernel) => {
    connector = new FakeConnector({ id: 'kernel-sim', clock: kernel.clock })
    kernel.registerConnector(connector)
  } })
}

async function login(): Promise<void> {
  if (!service) throw new Error('test service is not running')
  secretQueue = [service.kernel.auth.mintBootToken()]
  expect(await run(['session', 'login'])).toBe(0)
}

async function seedKnownReview(): Promise<ReconcileReviewItem> {
  if (!service) throw new Error('test service is not running')
  const accountId = service.kernel.accounts.find('paper')!.accountId
  const finding: ReconcileFindingView = { id: `finding_${randomUUID().replaceAll('-', '')}`, code: 'position_difference', severity: 'warn',
    detail: 'The captured positions differ.', advice: { action: 'review', requiresHuman: true, why: 'Review the captured evidence.' }, evidence: [] }
  return service.kernel.trading.reconcileReviews.record({ accountId, kind: 'known_difference', observedAt: service.kernel.clock.now(),
    summary: 'Captured position difference.', blocking: false, finding })
}

function decision(item: ReconcileReviewItem, requestId = `cli-${randomUUID()}`): ReconcileResolutionInput {
  return { accountId: item.accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest, action: 'acknowledge',
    reason: 'Reviewed this exact captured item.', requestId }
}

async function latestStatus(accountAlias = 'paper'): Promise<ReconcileAccountView> {
  expect(await run(['reconcile', 'status', '--account', accountAlias, '--json'])).toBe(0)
  const views = JSON.parse(output.join('')) as ReconcileAccountView[]
  const view = views[0]
  if (!view) throw new Error('CLI reconciliation status returned no account view')
  return view
}

type ObservedOffer = { accountId: string; orderId: string; venueOrderId: string; clientOrderId: string; input: ReconcileConfirmInput; review: ReconcileReviewItem }

async function makeObservedOffer(): Promise<ObservedOffer> {
  if (!service) throw new Error('test service is not running')
  const kernel = service.kernel
  const account = kernel.accounts.find('paper')!
  const session = kernel.auth.authenticateToken(kernel.auth.exchangeBoot(kernel.auth.mintBootToken()).sessionToken)
  if (!session || session.kind !== 'session') throw new Error('fixture could not issue session')
  const intent: OrderIntent = { accountId: account.accountId, instrumentId: 'hyperliquid:BTC' as never, side: 'buy', type: 'limit',
    size: asDecimal('0.012'), price: asDecimal('80000'), tif: 'gtc', clientOrderId: newClientOrderId() }
  const placed = await kernel.ops.call(kernel, 'order.place', { principal: session, transport: 'http', params: { intent } }) as { order?: { orderId: string } }
  const order = placed.order && kernel.orders.get(placed.order.orderId)
  if (!order?.venueOrderId) throw new Error('fixture order was not linked to a venue')
  const venueFill: VenueFill = { venueOrderId: order.venueOrderId, clientOrderId: order.clientOrderId,
    venueFillId: `fixture_${randomUUID().replaceAll('-', '')}`, instrumentId: order.instrumentId, side: 'buy',
    price: asDecimal('80000'), size: asDecimal('0.001'), fee: asDecimal('0.0001'), feeCcy: 'USDC',
    liquidity: 'maker', realizedPnl: asDecimal('0'), ts: kernel.clock.now() }
  kernel.trading.onVenueFill(account.accountId, venueFill)
  if (!connector) throw new Error('fixture connector was not registered')
  connector.openOrdersOverride = [{ instrumentId: order.instrumentId, venueOrderId: order.venueOrderId,
    clientOrderId: order.clientOrderId, side: 'buy', type: 'limit', price: asDecimal('80000'), triggerPrice: null,
    size: asDecimal('0.01'), origSize: asDecimal('0.012'), reduceOnly: false, isTrigger: false, createdAt: order.createdAt }]
  const position: Position = { accountId: account.accountId, instrumentId: order.instrumentId, side: 'long', size: asDecimal('0.002'),
    entryPrice: asDecimal('80000'), markPrice: asDecimal('80000'), notional: asDecimal('160'), unrealizedPnl: asDecimal('0'),
    realizedPnl: asDecimal('0'), leverage: 2, marginMode: 'cross', liquidationPrice: null, fundingSinceOpen: asDecimal('0'),
    openedAt: kernel.clock.now(), updatedAt: kernel.clock.now() }
  connector.accountSnapshotOverrides = { positions: [position] }
  const nativeSnapshot = connector.startupSnapshot.bind(connector)
  connector.startupSnapshot = async (ref, since) => {
    const snapshot = await nativeSnapshot(ref, since)
    return { ...snapshot, fills: [...snapshot.fills, venueFill] }
  }
  const deadline = Date.now() + 45_000
  let view: ReconcileAccountView | undefined
  do {
    const current = await latestStatus('paper')
    view = current
    if (view.state === 'ready' && view.offerId && view.reportId && view.suggestions.some((candidate) => candidate.orderId === order.orderId)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  const candidate = view?.suggestions.find((entry) => entry.orderId === order.orderId)
  if (view?.state !== 'ready' || !view.offerId || !view.reportId || !candidate) throw new Error('timed out waiting for a real ready reconciliation offer')
  const reviews = view.reviews ?? []
  const review = reviews.find((entry) => entry.kind === 'inferred_fill' && entry.suggestion?.id === candidate.id)
  if (!review) throw new Error('captured inference review is missing')
  return { accountId: account.accountId, orderId: order.orderId, venueOrderId: order.venueOrderId,
    clientOrderId: order.clientOrderId, review, input: { accountId: account.accountId, offerId: view.offerId, reportId: view.reportId,
      suggestionId: candidate.id, fee: asDecimal('0.0001'), feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0') } }
}

async function confirmObservedOffer(observed: ObservedOffer): Promise<{ fillId: string }> {
  await new Promise((resolve) => setTimeout(resolve, 10_100))
  expect(await run(['reconcile', 'confirm', JSON.stringify(observed.input)], async () => { prompts++; return PIN })).toBe(0)
  const result = JSON.parse(output.at(-1) ?? 'null') as { fillId: string; alreadyRecorded: boolean }
  expect(result.alreadyRecorded).toBe(false)
  expect(result.fillId).toBeTruthy()
  return result
}

async function acknowledgeBlockingKnownFindings(): Promise<void> {
  const view = await latestStatus()
  const known = (view.reviews ?? []).filter((item) => item.kind === 'known_difference' && item.blocking && item.resolution === undefined)
  for (const [index, item] of known.entries()) {
    const input: ReconcileResolutionInput = { accountId: item.accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest,
      action: 'acknowledge', reason: 'Reviewed this captured known difference.', requestId: `known-${index}-${randomUUID()}` }
    expect(await run(['reconcile', 'resolve', JSON.stringify(input)], async () => { prompts++; return PIN })).toBe(0)
  }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-cli-reconcile-'))
  output = []; errors = []; secretQueue = [PIN, PIN]; prompts = 0; connector = undefined
  expect(await run(['init'])).toBe(0)
  await start()
  await login()
})

afterEach(async () => {
  try { await service?.stop() }
  finally { service = undefined; if (home) rmSync(home, { recursive: true, force: true }) }
})

describe('ordinary CLI reconciliation decisions', () => {
  it('documents local-session resolution and separate account resume commands', async () => {
    expect(await run(['help'])).toBe(0)
    const help = output.join('')
    expect(help).toContain('gitrader reconcile resolve <@file|json>')
    expect(help).toContain('gitrader reconcile resume --account <alias|id> --reason <text>')
    expect(help).toContain('current cached human session')
    expect(help).not.toContain('uses the service token')
    expect(help).not.toContain('any same-user local process can then mint a session')
  })

  it('resolves a full captured snapshot only after PIN, rejects bad input/cancellation, and retries after restart', async () => {
    const item = await seedKnownReview()
    const input = decision(item, 'cli-review-request-1')
    const inputPath = join(home, 'decision.json')
    writeFileSync(inputPath, JSON.stringify(input), 'utf8')
    const invalid: unknown[] = [[], { ...input, accountId: 42 }, { ...input, extra: 'canary-cli-value' },
      { ...input, evidenceDigest: 'sha256:bad' }, { ...input, reason: '' }]
    for (const value of invalid) {
      const before = prompts
      expect(await run(['reconcile', 'resolve', JSON.stringify(value)])).toBe(1)
      expect(prompts).toBe(before)
      expect(errors.join('')).not.toContain(JSON.stringify(value))
    }

    await run(['session', 'logout'])
    const noSessionPrompts = prompts
    expect(await run(['reconcile', 'resolve', `@${inputPath}`])).toBe(1)
    expect(errors.join('')).toContain('gitrader session login')
    expect(prompts).toBe(noSessionPrompts)
    await login()

    const beforeCancel = service!.kernel.ledger.head()
    expect(await run(['reconcile', 'resolve', `@${inputPath}`], async () => { prompts++; throw new Error('cancelled') })).toBe(1)
    expect(service!.kernel.trading.reconcileReviews.get(item.accountId, item.itemId)?.resolution).toBeUndefined()
    expect(service!.kernel.ledger.head()).toEqual(beforeCancel)

    const wrongPin = await run(['reconcile', 'resolve', `@${inputPath}`], async () => { prompts++; return '000000' })
    expect(wrongPin).toBe(1)
    expect(errors.join('')).toContain('gitrader session login')
    expect(output.join('')).not.toContain('000000')
    expect(service!.kernel.trading.reconcileReviews.get(item.accountId, item.itemId)?.resolution).toBeUndefined()
    await login()

    let shownAtPrompt = false
    const first = await run(['reconcile', 'resolve', `@${inputPath}`], async () => {
      prompts++
      shownAtPrompt = output.join('').includes(item.itemId) && output.join('').includes(input.reason)
      return PIN
    })
    expect(first).toBe(0)
    expect(shownAtPrompt).toBe(true)
    const firstResult = JSON.parse(output.at(-1) ?? 'null') as { receipt: { input: ReconcileResolutionInput }; alreadyRecorded: boolean }
    expect(firstResult).toMatchObject({ alreadyRecorded: false, receipt: { input } })

    const preservedLedgerPrefix = service!.kernel.db.prepare('SELECT seq, entry FROM ledger ORDER BY seq').all() as Array<{ seq: number; entry: string }>
    const preservedFinancialRows = service!.kernel.ledger.query({ accountId: item.accountId, types: ['fill'] })
    const preservedFills = service!.kernel.orders.fills({ accountId: item.accountId, limit: 1000 })
    await service!.stop()
    service = undefined
    await start()
    await login()
    const ledgerAfterRestart = service!.kernel.db.prepare('SELECT seq, entry FROM ledger ORDER BY seq').all() as Array<{ seq: number; entry: string }>
    expect(ledgerAfterRestart.slice(0, preservedLedgerPrefix.length)).toEqual(preservedLedgerPrefix)
    expect(service!.kernel.ledger.query({ accountId: item.accountId, types: ['fill'] })).toEqual(preservedFinancialRows)
    expect(service!.kernel.orders.fills({ accountId: item.accountId, limit: 1000 })).toEqual(preservedFills)
    const retryHead = service!.kernel.ledger.head()
    expect(await run(['reconcile', 'resolve', `@${inputPath}`], async () => { prompts++; return PIN })).toBe(0)
    const replay = JSON.parse(output.at(-1) ?? 'null') as { receipt: unknown; alreadyRecorded: boolean }
    expect(replay).toEqual({ alreadyRecorded: true, receipt: firstResult.receipt })
    expect(service!.kernel.ledger.head()).toEqual(retryHead)
    expect(await run(['reconcile', 'resolve', JSON.stringify({ ...input, reason: 'Changed request payload.' })], async () => { prompts++; return PIN })).toBe(1)
    expect(service!.kernel.trading.reconcileReviews.get(item.accountId, item.itemId)?.resolution).toEqual(firstResult.receipt)
  })

  it('rejects an inferred offer through the CLI while retaining its original finding and no financial record', async () => {
    const observed = await makeObservedOffer()
    const beforeFills = service!.kernel.orders.fillsForOrder(observed.accountId, observed.orderId)
    const beforeLedgerFills = service!.kernel.ledger.query({ types: ['fill'], accountId: observed.accountId })
    const reject: ReconcileResolutionInput = { accountId: observed.review.accountId, itemId: observed.review.itemId,
      evidenceDigest: observed.review.evidenceDigest, action: 'reject', reason: 'Do not book this inferred candidate.', requestId: `reject-${randomUUID()}` }
    expect(await run(['reconcile', 'resolve', JSON.stringify(reject)], async () => { prompts++; return PIN })).toBe(0)
    const afterReject = await latestStatus()
    expect(afterReject.findings.map((finding) => finding.code)).toContain('fill_missing_inferred')
    expect(afterReject.reviews?.find((item) => item.itemId === observed.review.itemId)?.resolution).toMatchObject({ input: reject })
    expect(await run(['reconcile', 'confirm', JSON.stringify(observed.input)], async () => { prompts++; return PIN })).toBe(1)
    expect(service!.kernel.orders.fillsForOrder(observed.accountId, observed.orderId)).toEqual(beforeFills)
    expect(service!.kernel.ledger.query({ types: ['fill'], accountId: observed.accountId })).toEqual(beforeLedgerFills)
  }, 90_000)

  it('acknowledges late items individually and requires a separate public resume without changing fills', async () => {
    const observed = await makeObservedOffer()
    const confirmed = await confirmObservedOffer(observed)
    await acknowledgeBlockingKnownFindings()
    const order = service!.kernel.orders.get(observed.orderId)!
    const financialBefore = { fills: service!.kernel.orders.fillsForOrder(observed.accountId, observed.orderId).length,
      ledgerFills: service!.kernel.ledger.query({ types: ['fill'], accountId: observed.accountId }).length,
      filledSize: order.filledSize, fee: order.fee }
    const lateBase: VenueFill = { venueOrderId: observed.venueOrderId, clientOrderId: observed.clientOrderId,
      venueFillId: `late_${randomUUID()}`, instrumentId: order.instrumentId, side: order.side, price: asDecimal('80001'), size: asDecimal('0.0002'), fee: asDecimal('0'),
      feeCcy: 'USDC', liquidity: 'maker', realizedPnl: asDecimal('0'), ts: service!.kernel.clock.now() + 1 }
    service!.kernel.trading.onVenueFill(observed.accountId, { ...lateBase, venueFillId: `late_${randomUUID()}` })
    service!.kernel.trading.onVenueFill(observed.accountId, { ...lateBase, price: asDecimal('80002'), venueFillId: `late_${randomUUID()}`, ts: service!.kernel.clock.now() + 2 })
    const view = await latestStatus('paper')
    const pending = (view.reviews ?? []).filter((item) => item.kind === 'late_real_fill' && item.resolution === undefined)
    expect(pending).toHaveLength(2)
    const resolveItem = async (item: ReconcileReviewItem, requestId: string) => {
      const input: ReconcileResolutionInput = { accountId: item.accountId, itemId: item.itemId, evidenceDigest: item.evidenceDigest,
        action: 'acknowledge', reason: 'Reviewed this retained late fill.', requestId }
      writeFileSync(join(home, `${requestId}.json`), JSON.stringify(input), 'utf8')
      expect(await run(['reconcile', 'resolve', `@${join(home, `${requestId}.json`)}`], async () => { prompts++; return PIN })).toBe(0)
      return JSON.parse(output.at(-1) ?? 'null') as { alreadyRecorded: boolean }
    }
    const scope = { type: 'account', id: observed.accountId } as const
    const firstResult = await resolveItem(pending[0]!, 'late-item-first')
    expect(firstResult.alreadyRecorded).toBe(false)
    expect(await run(['reconcile', 'resume', '--account', 'paper', '--reason', 'resume after first ACK'], async () => { prompts++; return PIN })).toBe(1)
    expect(service!.kernel.tstate.get(scope)).toBe('HALTED')
    await resolveItem(pending[1]!, 'late-item-second')
    expect(service!.kernel.tstate.get(scope)).toBe('HALTED')
    expect(await run(['reconcile', 'resume', '--account', 'paper', '--reason', 'resume after both ACKs'], async () => { prompts++; return PIN })).toBe(0)
    expect(service!.kernel.tstate.get(scope)).toBe('ACTIVE')
    expect(service!.kernel.orders.fillsForOrder(observed.accountId, observed.orderId)).toHaveLength(financialBefore.fills)
    expect(service!.kernel.orders.fillsForOrder(observed.accountId, observed.orderId).map((fill) => fill.fillId)).toContain(confirmed.fillId)
    expect(service!.kernel.ledger.query({ types: ['fill'], accountId: observed.accountId })).toHaveLength(financialBefore.ledgerFills)
    expect(service!.kernel.orders.get(observed.orderId)).toMatchObject({ filledSize: financialBefore.filledSize, fee: financialBefore.fee })
  }, 90_000)

  it('requires login before PIN and refuses unknown or ambiguous resume accounts', async () => {
    await run(['session', 'logout'])
    const before = prompts
    expect(await run(['reconcile', 'resume', '--account', 'missing-alias', '--reason', 'test'])) .toBe(1)
    expect(errors.join('')).toContain('gitrader session login')
    expect(prompts).toBe(before)
    await login()
    expect(await run(['reconcile', 'resume', '--account', 'missing-alias', '--reason', 'test'])).toBe(1)
    expect(errors.join('')).toContain('unknown account')
    expect(prompts).toBe(before + 1)

    await service!.stop()
    service = undefined
    const configPath = join(home, 'gitrader.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { accounts: Array<{ alias: string; accountId: string; mode: string }> }
    const paper = config.accounts.find((account) => account.alias === 'paper')!
    config.accounts.push({ ...paper, alias: paper.accountId, accountId: newId('acct'), mode: 'paper' })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
    await start()
    await login()
    const beforeAmbiguous = prompts
    expect(await run(['reconcile', 'resume', '--account', paper.accountId, '--reason', 'ambiguous alias test'])).toBe(1)
    expect(errors.join('')).toContain('ambiguous account')
    expect(prompts).toBe(beforeAmbiguous)
  })
})
