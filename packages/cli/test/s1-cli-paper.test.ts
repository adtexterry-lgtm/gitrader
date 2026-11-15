// SPDX-License-Identifier: CPAL-1.0
// fix-r2 S1 / S3（CLI 面）：纸面状态坏了 → doctor（服务没跑）亮红；`gitrader paper rebuild-from-ledger --yes` 按账本重建 → doctor 转绿、内核再起能用。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel, fileProvider, judgePaperStateOffline, mkOrigin } from '@gitrader/kernel'
import { PaperVenue } from '@gitrader/venue-paper'
import { BTC, TestMarket } from '../../venue-paper/test/helpers/test-market'
import { FakeConnector } from '../../kernel/test/helpers/fake-connector'
import { cmdDoctor, doctorDeps } from '../src/doctor'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

let home = ''
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = '' })

function io(lines: string[], interactive = false): CliIo {
  return { out: (s) => { lines.push(s) }, err: (s) => { lines.push(s) }, env: { GITRADER_HOME: home }, interactive, readSecret: async () => '', deviceKey: fileProvider }
}

async function boot(market: TestMarket): Promise<{ k: Kernel; paper: PaperVenue }> {
  const k = await Kernel.create({ home, clock: { now: () => market.now }, deviceKeyProvider: fileProvider, scrypt: { N: 1024, r: 8, p: 1 }, timers: false })
  const source = new FakeConnector({ id: 'hyperliquid', clock: { now: () => market.now } })
  source.quote = market.quote.bind(market); source.context = market.context.bind(market)
  const paper = new PaperVenue({ market, clock: () => market.now })
  k.registerConnector(source); k.registerConnector(paper)
  return { k, paper }
}

describe('S1 CLI: doctor offline and rebuild-from-ledger', () => {
  it('corrupt paper state is red offline, rebuild-from-ledger fixes it', async () => {
    home = mkdtempSync(join(tmpdir(), 'gr-s1-cli-'))
    const market = new TestMarket()
    let { k } = await boot(market)
    const human = { principal: k.auth.authenticateToken(k.auth.exchangeBoot(k.auth.mintBootToken()).sessionToken)!, origin: mkOrigin('user:usr_local', 'order', 'ui') }
    const acct = k.accounts.find('paper')!.accountId
    const r = await k.trading.place({ intent: { accountId: acct, instrumentId: BTC, side: 'buy', type: 'market', size: '0.001', reason: 'cli s1', tpsl: { grouping: 'order', stopLoss: { triggerPrice: '78000' } } } as never }, human)
    expect(r.order?.status).toBe('filled')
    await k.stop()
    const file = join(home, 'paper-state.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/"cash":\{"\$b":"(\d)/, (_m, x: string) => `"cash":{"$b":"${(Number(x) + 1) % 10}`))
    expect(judgePaperStateOffline(home, [acct]).state).toBe('corrupt')

    const out: string[] = []
    Object.assign(doctorDeps, { liveService: async () => null })
    expect(await cmdDoctor(home, { cmd: ['doctor'], flags: { json: true } }, io(out))).toBe(0) // --json 退出码恒 0，结论在内容里
    expect(await cmdDoctor(home, { cmd: ['doctor'], flags: {} }, io([]))).toBe(2)
    expect(out.join('')).toMatch(/"id":"paper","ok":false,"level":"block"/)

    const nonInteractive: string[] = []
    expect(await main(['paper', 'rebuild-from-ledger'], io(nonInteractive))).toBe(2)
    const rebuilt: string[] = []
    expect(await main(['paper', 'rebuild-from-ledger', '--yes'], io(rebuilt))).toBe(0)
    expect(rebuilt.join('')).toMatch(/已按账本重建/)
    expect(judgePaperStateOffline(home, [acct]).state).toBe('ok')

    ;({ k } = await boot(market))
    try {
      expect(k.paperStateHealth().state).toBe('ok')
      const snap = await k.bus.snapshot(k.accounts.get(acct), { maxAgeMs: 0 })
      expect(Number(snap.positions[0]?.size)).toBeCloseTo(0.001, 9)
      expect(k.paperAudit().accounts[0]).toMatchObject({ ok: true })
    } finally { await k.stop() }
  }, 60_000)
})
