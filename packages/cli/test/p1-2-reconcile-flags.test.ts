// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { ReconcileFindingView, ReconcileResolutionInput } from '@gitrader/protocol'
import { FakeConnector } from '../../kernel/test/helpers/fake-connector'
import { fileProvider } from '../../kernel/src/device-key'
import { main, runServe } from '../src/index'
import type { CliIo, ServeHandle } from '../src/index'

const PIN = '482916'
let home: string
let service: ServeHandle | undefined
let output: string[]
let errors: string[]
let prompts = 0

const io = (): CliIo => ({
  out: value => output.push(value),
  err: value => errors.push(value),
  env: { GITRADER_HOME: home },
  interactive: true,
  deviceKey: fileProvider,
  readSecret: async () => { prompts++; return PIN },
})

const run = (args: string[]): Promise<number> => main(args, io())

async function seedReview(blocking = true): Promise<{ accountId: string; itemId: string }> {
  const accountId = service!.kernel.accounts.find('paper')!.accountId
  const finding: ReconcileFindingView = { id: `finding_${randomUUID().replaceAll('-', '')}`, code: 'position_size_mismatch', severity: blocking ? 'blocker' : 'warn',
    detail: 'Captured position sizes differ.', advice: { action: 'review', requiresHuman: true, why: 'Review captured evidence.' },
    evidence: [{ report: 'positions', id: 'position-1', field: 'size', value: '1' }] }
  const item = service!.kernel.trading.reconcileReviews.record({ accountId, kind: 'known_difference', observedAt: service!.kernel.clock.now(),
    summary: 'Captured position difference.', blocking, finding })
  return { accountId, itemId: item.itemId }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-p1-2-reconcile-'))
  output = []; errors = []; prompts = 0
  expect(await run(['init'])).toBe(0)
  service = await runServe(home, { port: 0, io: io(), connectors: false, connect: kernel => {
    kernel.registerConnector(new FakeConnector({ id: 'kernel-sim', clock: kernel.clock }))
  } })
  const token = service.kernel.auth.mintBootToken()
  const secretQueue = [token]
  const loginIo = io()
  loginIo.readSecret = async () => secretQueue.shift() ?? PIN
  expect(await main(['session', 'login'], loginIo)).toBe(0)
  output = []; errors = []; prompts = 0
})

afterEach(async () => {
  try { await service?.stop() }
  finally { service = undefined; if (home) rmSync(home, { recursive: true, force: true }) }
})

describe('P1-2 reconcile CLI flags', () => {
  it('builds the resolution from the current review and keeps legacy JSON input', async () => {
    const seeded = await seedReview()
    const reason = '人工核对后标记已处理'
    expect(await run(['reconcile', 'resolve', '--item', seeded.itemId, '--action', 'acknowledge', '--reason', reason])).toBe(0)
    expect(prompts).toBe(1)
    const decision = JSON.parse(output[0] ?? 'null') as { decision: ReconcileResolutionInput }
    expect(decision.decision).toMatchObject({ accountId: seeded.accountId, itemId: seeded.itemId, action: 'acknowledge', reason })
    expect(decision.decision.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(decision.decision.requestId).toBeTruthy()

    const legacy = await seedReview(false)
    const input: ReconcileResolutionInput = { accountId: legacy.accountId as never, itemId: legacy.itemId,
      evidenceDigest: service!.kernel.trading.reconcileReviews.get(legacy.accountId as never, legacy.itemId)!.evidenceDigest,
      action: 'acknowledge', reason: '旧格式继续兼容', requestId: `legacy-${randomUUID()}` }
    output = []; errors = []
    expect(await run(['reconcile', 'resolve', JSON.stringify(input)])).toBe(0)
    expect(JSON.parse(output[0] ?? 'null')).toMatchObject({ decision: input })
    expect(await run(['reconcile', 'resolve', JSON.stringify(input)])).toBe(0)
    expect(JSON.parse(output.at(-1) ?? 'null')).toMatchObject({ alreadyRecorded: true })
  })

  it('rejects a missing item or a forbidden action in Chinese before requesting a PIN', async () => {
    const seeded = await seedReview()
    expect(await run(['reconcile', 'resolve', '--item', 'missing-review', '--action', 'acknowledge', '--reason', '人工核对'])).toBe(1)
    expect(errors.join('')).toContain('没有找到')
    expect(errors.join('')).toContain(seeded.itemId)
    expect(prompts).toBe(0)

    output = []; errors = []
    expect(await run(['reconcile', 'resolve', '--item', seeded.itemId, '--action', 'reject', '--reason', '人工核对'])).toBe(1)
    expect(errors.join('')).toContain('acknowledge')
    expect(prompts).toBe(0)
  })

  it('prints human status by default and preserves the raw JSON view with --json', async () => {
    const seeded = await seedReview()
    expect(await run(['reconcile', 'status'])).toBe(0)
    const human = output.join('')
    expect(human).toContain('待处理对账项')
    expect(human).toContain(seeded.itemId)
    expect(human).toContain('标记已处理（acknowledge）')
    expect(human).toContain('持仓数量不一致')

    output = []; errors = []
    expect(await run(['reconcile', 'status', '--json'])).toBe(0)
    const raw = JSON.parse(output.join('')) as Array<{ accountId: string; reviews?: Array<{ itemId: string }> }>
    expect(raw).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: seeded.accountId,
      reviews: expect.arrayContaining([expect.objectContaining({ itemId: seeded.itemId })]) })]))
  })
})
