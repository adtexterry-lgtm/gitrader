// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import type { ReconcileConfirmInput } from '@gitrader/protocol'
import type { VenueFill, VenueOpenOrder } from '@gitrader/protocol/connector'
import { FakeConnector } from '../../kernel/test/helpers/fake-connector'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'

let home: string
let service: ServeHandle | undefined
let connector: FakeConnector | undefined
let out: string[]
let errors: string[]
let secrets: string[]
let accountId: string
let orderId: string
let clientOrderId: string
let venueOrderId: string
let venueFill: VenueFill | undefined

const io = (): CliIo => ({
  out: value => out.push(value),
  err: value => errors.push(value),
  env: { GITRADER_HOME: home },
  interactive: true,
  readSecret: async () => {
    const secret = secrets.shift()
    if (secret === undefined) throw new Error('missing test secret input')
    return secret
  },
})
const run = (args: string[]): Promise<number> => main(args, io())

const redact = (value: string): string => value
  .replace(/https?:\/\/[^\s"']+/gi, '<endpoint>')
  .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')

const captureEvidence = (label: string, value: unknown): void => {
  const directory = join(home, 'evidence')
  mkdirSync(directory, { recursive: true })
  const serialized = JSON.stringify(value, (key, item) => /(?:token|pin|secret)/i.test(key) ? '<redacted>' : item, 2)
  writeFileSync(join(directory, `B3-08C3-${label}-${randomUUID()}.result`), `${redact(serialized)}\n`, { encoding: 'utf8', flag: 'wx' })
}

const economicCounts = () => ({
  orders: service!.kernel.orders.list({ accountId, limit: 1000 }).length,
  fills: service!.kernel.orders.fills({ accountId, limit: 1000 }).length,
  ledger: service!.kernel.ledger.count(),
})

const configureVenueSnapshot = (kernel: ServeHandle['kernel']): void => {
  if (!orderId || !venueFill || !connector) return
  const order = kernel.orders.get(orderId)
  if (!order) throw new Error('fixture order is missing after service start')
  connector.openOrdersOverride = [{
    venueOrderId: venueOrderId as VenueOpenOrder['venueOrderId'],
    clientOrderId: clientOrderId as VenueOpenOrder['clientOrderId'],
    instrumentId: order.instrumentId,
    side: 'buy',
    type: 'limit',
    price: asDecimal('80000'),
    size: asDecimal('0.01'),
    origSize: asDecimal('0.012'),
    triggerPrice: null,
    reduceOnly: false,
    isTrigger: false,
    createdAt: order.createdAt,
  }]
  connector.accountSnapshotOverrides = { positions: [{
    accountId: order.accountId,
    instrumentId: order.instrumentId,
    side: 'long',
    size: asDecimal('0.002'),
    entryPrice: asDecimal('80000'),
    markPrice: asDecimal('80000'),
    notional: asDecimal('160'),
    unrealizedPnl: asDecimal('0'),
    realizedPnl: asDecimal('0'),
    leverage: 2,
    marginMode: 'cross',
    liquidationPrice: asDecimal('0'),
    fundingSinceOpen: asDecimal('0'),
    openedAt: kernel.clock.now(),
    updatedAt: kernel.clock.now(),
  }] }
  const nativeSnapshot = connector.startupSnapshot.bind(connector)
  connector.startupSnapshot = async (ref, since) => {
    const snapshot = await nativeSnapshot(ref, since)
    return { ...snapshot, fills: [...snapshot.fills, venueFill!] }
  }
}

const startService = async (): Promise<void> => {
  service = await runServe(home, {
    port: 0,
    io: io(),
    connectors: false,
    connect: (kernel) => {
      connector = new FakeConnector({ id: 'kernel-sim', clock: kernel.clock })
      kernel.registerConnector(connector)
      configureVenueSnapshot(kernel)
    },
  })
}

const runCaptured = async (label: string, args: string[]) => {
  out = []
  errors = []
  const before = economicCounts()
  const exit = await run(args)
  const stdout = [...out].map(redact)
  const stderr = [...errors].map(redact)
  const after = economicCounts()
  captureEvidence(label, { exit, stdout, stderr, economic: { before, after } })
  return { exit, stdout, stderr, before, after }
}

type ReconcileView = {
  accountId: ReconcileConfirmInput['accountId']
  offerId?: string
  reportId?: string
  state: string
  findings: Array<{ code: string }>
  suggestions: Array<{ id: string; orderId: string; size: string; price: string }>
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const waitForReadyOffer = async (): Promise<ReconcileView> => {
  const deadline = Date.now() + 45_000
  let attempt = 0
  while (Date.now() < deadline) {
    const status = await runCaptured(`status-ready-${attempt++}`, ['reconcile', 'status', '--account', 'paper', '--json'])
    expect(status.exit).toBe(0)
    const views = JSON.parse(status.stdout.join('')) as ReconcileView[]
    const view = views.find(candidate => candidate.accountId === accountId)
    if (view?.state === 'ready' && view.offerId && view.reportId && view.suggestions.some(item => item.orderId === orderId)) return view
    await delay(250)
  }
  throw new Error('timed out waiting for a real ready reconciliation offer')
}

const confirmInputFor = (view: ReconcileView): ReconcileConfirmInput => {
  const suggestion = view.suggestions.find(item => item.orderId === orderId)
  if (!view.offerId || !view.reportId || !suggestion) throw new Error('ready view is missing the fixture order offer')
  if (view.accountId !== accountId) throw new Error('ready view belongs to a different fixture account')
  return {
    accountId: view.accountId,
    offerId: view.offerId,
    reportId: view.reportId,
    suggestionId: suggestion.id,
    fee: asDecimal('0.0001'),
    feeCcy: 'USDC',
    liquidity: 'maker',
    realizedPnl: asDecimal('0'),
  }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-reconcile-human-'))
  out = []
  errors = []
  connector = undefined
  accountId = ''
  orderId = ''
  clientOrderId = ''
  venueOrderId = ''
  venueFill = undefined
  secrets = ['test-pin-only', 'test-pin-only']
  const initExit = await run(['init'])
  captureEvidence('setup-init', { exit: initExit, stdout: [...out].map(redact), stderr: [...errors].map(redact) })
  expect(initExit).toBe(0)
  await startService()
  const startedService = service
  if (!startedService) throw new Error('CLI fixture service did not start')
  const fixtureSession = startedService.kernel.auth.exchangeBoot(startedService.kernel.auth.mintBootToken())
  const account = startedService.kernel.accounts.find('paper')!
  accountId = account.accountId
  const fixtureBeforeOrder = economicCounts()
  const orderResponse = await fetch(new URL('/api/op/order.place', startedService.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${fixtureSession.sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params: { intent: { accountId, instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'limit', size: '0.012', price: '80000', leverage: 2, tif: 'gtc' } } }),
  })
  const orderBody = await orderResponse.json() as { result?: { order?: { orderId?: string } } }
  const placedOrder = startedService.kernel.orders.list({ accountId, limit: 1000 }).at(-1)
  const fixtureAfterOrder = economicCounts()
  captureEvidence('fixture-order', { status: orderResponse.status, responseOrderId: orderBody.result?.order?.orderId, storedOrderId: placedOrder?.orderId, economic: { before: fixtureBeforeOrder, after: fixtureAfterOrder } })
  if (!orderResponse.ok || !placedOrder || !orderBody.result?.order?.orderId) throw new Error('fixture order placement failed')
  expect(orderBody.result.order.orderId).toBe(placedOrder.orderId)
  expect(placedOrder.clientOrderId).toBeTruthy()
  expect(placedOrder.venueOrderId).toBeTruthy()
  expect(fixtureAfterOrder.orders).toBe(fixtureBeforeOrder.orders + 1)
  orderId = placedOrder.orderId
  clientOrderId = placedOrder.clientOrderId
  venueOrderId = placedOrder.venueOrderId!
  venueFill = {
    venueOrderId,
    clientOrderId: clientOrderId as VenueFill['clientOrderId'],
    venueFillId: `fixture-${randomUUID()}` as VenueFill['venueFillId'],
    instrumentId: placedOrder.instrumentId,
    side: 'buy',
    price: asDecimal('80000'),
    size: asDecimal('0.001'),
    fee: asDecimal('0.0001'),
    feeCcy: 'USDC',
    liquidity: 'maker',
    realizedPnl: asDecimal('0'),
    ts: startedService.kernel.clock.now(),
  }
  const fixtureBeforeFill = economicCounts()
  startedService.kernel.trading.onVenueFill(accountId, venueFill)
  const fixtureAfterFill = economicCounts()
  const partiallyFilledOrder = startedService.kernel.orders.get(orderId)
  captureEvidence('fixture-venue-fill', { orderId, venueOrderId, clientOrderId, venueFillId: venueFill.venueFillId, orderFilledSize: partiallyFilledOrder?.filledSize, economic: { before: fixtureBeforeFill, after: fixtureAfterFill } })
  expect(fixtureAfterFill.fills).toBe(fixtureBeforeFill.fills + 1)
  expect(fixtureAfterFill.ledger).toBeGreaterThan(fixtureBeforeFill.ledger)
  expect(partiallyFilledOrder).toMatchObject({ orderId, filledSize: asDecimal('0.001'), status: 'partially_filled' })
  configureVenueSnapshot(startedService.kernel)
  secrets = [startedService.kernel.auth.mintBootToken()]
  const login = await runCaptured('setup-login', ['session', 'login'])
  expect(login.exit).toBe(0)
  secrets = ['test-pin-only']
  out = []
  errors = []
})

afterEach(async () => {
  try {
    await service?.stop()
  } finally {
    service = undefined
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('ordinary CLI reconciliation entry', () => {
  it('shows the real ready offer through read-only status, then confirms once and replays after restart', async () => {
    expect(connector).toBeDefined()
    expect(connector!.startupSnapshotCalls).toBeGreaterThan(0)
    const preview = await waitForReadyOffer()
    expect(preview.findings.map(finding => finding.code)).toContain('fill_missing_inferred')
    const suggestion = preview.suggestions.find(item => item.orderId === orderId)
    expect(suggestion).toMatchObject({ size: '0.001', price: '80000' })
    const input = confirmInputFor(preview)
    await delay(10_100)
    const inputPath = join(home, 'confirm-review.json')
    writeFileSync(inputPath, JSON.stringify(input), 'utf8')
    secrets = ['test-pin-only']
    const confirmed = await runCaptured('confirm-file-first', ['reconcile', 'confirm', `@${inputPath}`])
    const review = JSON.parse(confirmed.stdout[0] ?? 'null') as unknown
    const receipt = JSON.parse(confirmed.stdout[1] ?? 'null') as { fillId: string; alreadyRecorded: boolean }
    expect(confirmed.exit).toBe(0)
    expect(review).toEqual(input)
    expect(receipt).toMatchObject({ alreadyRecorded: false })
    expect(confirmed.after.fills).toBe(confirmed.before.fills + 1)
    expect(confirmed.after.ledger).toBe(confirmed.before.ledger + 1)
    expect(confirmed.after.orders).toBe(confirmed.before.orders)
    const inferred = service!.kernel.orders.fills({ accountId, limit: 1000 }).find(fill => fill.fillId === receipt.fillId)
    expect(inferred).toMatchObject({ orderId, size: '0.001', fee: '0.0001', feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0' })
    expect(inferred?.inferred).toMatchObject({ suggestionId: input.suggestionId, reportId: input.reportId })
    expect(service!.kernel.trading.lookupConfirmedFill(input)).toEqual({ fillId: receipt.fillId, alreadyRecorded: true })

    await service!.stop()
    service = undefined
    await startService()
    secrets = [service!.kernel.auth.mintBootToken()]
    const login = await runCaptured('restart-login', ['session', 'login'])
    expect(login.exit).toBe(0)
    secrets = ['test-pin-only']
    const replay = await runCaptured('confirm-direct-json-replay', ['reconcile', 'confirm', JSON.stringify(input)])
    const replayReview = JSON.parse(replay.stdout[0] ?? 'null') as unknown
    const replayReceipt = JSON.parse(replay.stdout[1] ?? 'null') as { fillId: string; alreadyRecorded: boolean }
    expect(replay.exit).toBe(0)
    expect(replayReview).toEqual(input)
    expect(replayReceipt).toEqual({ fillId: receipt.fillId, alreadyRecorded: true })
    expect(replay.after).toEqual(replay.before)
  }, 90_000)

  it('refreshes the explicit account once without creating a financial record', async () => {
    const originalOffer = await waitForReadyOffer()
    await delay(10_100)
    const snapshotCallsBefore = connector!.startupSnapshotCalls
    const refresh = await runCaptured('refresh-explicit-account', ['reconcile', 'refresh', '--account', 'paper'])
    expect(refresh.exit).toBe(0)
    const view = JSON.parse(refresh.stdout.join('')) as ReconcileView
    const snapshotCallsAfter = connector!.startupSnapshotCalls
    const status = await runCaptured('refresh-explicit-account-readback', ['reconcile', 'status', '--account', 'paper', '--json'])
    const readbackViews = JSON.parse(status.stdout.join('')) as ReconcileView[]
    const readback = readbackViews.find(candidate => candidate.accountId === accountId)
    captureEvidence('refresh-explicit-account-readback', {
      originalOfferId: originalOffer.offerId,
      refreshOfferId: view.offerId,
      statusReadbackOfferId: readback?.offerId,
      snapshotCallsBefore,
      snapshotCallsAfter,
      snapshotCallDelta: snapshotCallsAfter - snapshotCallsBefore,
      economic: { before: refresh.before, after: refresh.after },
    })
    expect(status.exit).toBe(0)
    expect(snapshotCallsAfter).toBe(snapshotCallsBefore + 1)
    expect(view).toMatchObject({ accountId, state: 'ready' })
    expect(view.offerId).toBeTruthy()
    expect(view.offerId).toBe(originalOffer.offerId)
    expect(readback?.offerId).toBe(originalOffer.offerId)
    expect(view.suggestions.some(item => item.orderId === orderId)).toBe(true)
    expect(view.findings.map(finding => finding.code)).toContain('fill_missing_inferred')
    expect(refresh.after).toEqual(refresh.before)
  }, 40_000)

  it('rejects an expired offer once without financial changes', async () => {
    const view = await waitForReadyOffer()
    const input = confirmInputFor(view)
    await delay(31_000)
    secrets = ['test-pin-only']
    const expired = await runCaptured('confirm-expired-offer', ['reconcile', 'confirm', JSON.stringify(input)])
    expect(expired.exit).toBe(1)
    expect(expired.stderr.join('')).toMatch(/changed or expired/i)
    expect(expired.after).toEqual(expired.before)
  }, 100_000)

  it('rejects a changed venue offer without refreshing or writing finance', async () => {
    const view = await waitForReadyOffer()
    const input = confirmInputFor(view)
    connector!.openOrdersOverride = []
    await delay(10_100)
    secrets = ['test-pin-only']
    const changed = await runCaptured('confirm-changed-offer', ['reconcile', 'confirm', JSON.stringify(input)])
    expect(changed.exit).toBe(1)
    expect(changed.stderr.join('')).toMatch(/changed or expired|review/i)
    expect(changed.after).toEqual(changed.before)
  }, 75_000)

  it('refuses confirmation when the local human session is absent', async () => {
    const logout = await runCaptured('logout-before-confirm', ['session', 'logout'])
    expect(logout.exit).toBe(0)
    secrets = []
    const refused = await runCaptured('confirm-without-login', ['reconcile', 'confirm', JSON.stringify({
      accountId, offerId: 'offer-test', reportId: 'report-test', suggestionId: 'suggestion-test',
      fee: '0', feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0',
    })])
    expect(refused.exit).toBe(1)
    expect(refused.stderr.join('')).toMatch(/session login/i)
    expect(refused.after).toEqual(refused.before)
  })

  it('refuses a server-revoked cached session without financial changes', async () => {
    service!.kernel.auth.revokeSessions()
    secrets = ['test-pin-only']
    const revoked = await runCaptured('confirm-revoked-session', ['reconcile', 'confirm', JSON.stringify({
      accountId, offerId: 'offer-test', reportId: 'report-test', suggestionId: 'suggestion-test',
      fee: '0', feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0',
    })])
    expect(revoked.exit).toBe(1)
    expect(revoked.stderr.join('')).toMatch(/session login|invalid/i)
    expect(revoked.after).toEqual(revoked.before)
  })

  it('refuses an incorrect PIN without financial changes', async () => {
    secrets = ['incorrect-test-pin']
    const refused = await runCaptured('confirm-wrong-pin', ['reconcile', 'confirm', JSON.stringify({
      accountId, offerId: 'offer-test', reportId: 'report-test', suggestionId: 'suggestion-test',
      fee: '0', feeCcy: 'USDC', liquidity: 'maker', realizedPnl: '0',
    })])
    expect(refused.exit).toBe(1)
    expect(refused.stderr.join('')).toMatch(/session login|invalid/i)
    expect(refused.after).toEqual(refused.before)
  })

  it('rejects unknown accounts and malformed or client-supplied confirmation proof', async () => {
    const unknown = await runCaptured('status-unknown-account', ['reconcile', 'status', '--account', 'missing-account'])
    expect(unknown.exit).toBe(1)
    expect(unknown.stderr.join('')).toContain('unknown account')

    const validShape = {
      accountId,
      offerId: 'offer-test',
      reportId: 'report-test',
      suggestionId: 'suggestion-test',
      fee: '0',
      feeCcy: 'USD',
      liquidity: 'maker',
      realizedPnl: '0',
    }
    const invalidInputs: Array<{ input: Record<string, unknown>; diagnostic: string }> = [
      { input: { ...validShape, fee: '-1' }, diagnostic: 'fee must be non-negative' },
      { input: { ...validShape, fee: '1.0' }, diagnostic: 'canonical decimal strings' },
      { input: { ...validShape, feeCcy: 'usd' }, diagnostic: 'feeCcy' },
      { input: { ...validShape, liquidity: 'unknown' }, diagnostic: 'liquidity' },
      { input: { ...validShape, pin: 'must-not-be-accepted' }, diagnostic: 'exactly the eight' },
      { input: { ...validShape, fillId: 'client-proof' }, diagnostic: 'exactly the eight' },
      { input: { ...validShape, inferred: {} }, diagnostic: 'exactly the eight' },
    ]
    for (const [index, { input, diagnostic }] of invalidInputs.entries()) {
      const invalid = await runCaptured(`confirm-invalid-${index}`, ['reconcile', 'confirm', JSON.stringify(input)])
      expect(invalid.exit).toBe(1)
      expect(invalid.stderr.join('')).toContain(diagnostic)
      expect(invalid.stdout).toEqual([])
      expect(invalid.after).toEqual(invalid.before)
    }
    const missingAccount = await runCaptured('refresh-missing-account', ['reconcile', 'refresh'])
    expect(missingAccount.exit).toBe(1)
    expect(missingAccount.stderr.join('')).toContain('requires --account')
    const strayPosition = await runCaptured('status-stray-position', ['reconcile', 'status', 'unexpected'])
    expect(strayPosition.exit).toBe(1)
    // fix-r3 P1-2：用法提示改中文（「用法」），英文旧词仍接受
    expect(strayPosition.stderr.join('')).toMatch(/usage|用法/i)
    expect(strayPosition.after).toEqual(strayPosition.before)
    const unknownFlag = await runCaptured('status-unknown-flag', ['reconcile', 'status', '--other', 'x'])
    expect(unknownFlag.exit).toBe(1)
    expect(unknownFlag.stderr.join('')).toContain('unknown flag')
  })

  it('reports a missing local service without attempting finance', async () => {
    const counts = economicCounts()
    await service!.stop()
    service = undefined
    out = []
    errors = []
    const exit = await run(['reconcile', 'status'])
    const stdout = [...out].map(redact)
    const stderr = [...errors].map(redact)
    captureEvidence('status-without-service', { exit, stdout, stderr, economic: { atStop: counts } })
    expect(exit).toBe(1)
    // fix-r3 P1-2：提示改中文（「请先启动本机服务」），英文旧句仍接受
    expect(stderr.join('')).toMatch(/start the local service|请先启动本机服务/i)
  })
})
