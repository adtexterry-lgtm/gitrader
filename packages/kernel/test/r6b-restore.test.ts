// SPDX-License-Identifier: CPAL-1.0
// R6 B 包 R2-REL-01：策略实例恢复等「标的已知」再做；可重试的失败按退避重试且不计入崩溃保护；实盘一律不自动恢复；交易状态不是 ACTIVE 只标记一次。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreInstances } from '../src/instance-restore'
import type { RestoreOptions } from '../src/instance-restore'
import type { InstanceOwner } from '../src/strategy-instances'
import { makeProblem } from '../src/proto'
import { KernelError } from '../src/util/errors'
import { mkOrigin } from '../src/util/origin'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness | undefined
afterEach(async () => { await h?.cleanup(); h = undefined })

const HUMAN: InstanceOwner = { kind: 'human', actor: 'user:usr_local' }
const ENGINE = 'core'
const SOL = 'hyperliquid:SOL'
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const FAST: RestoreOptions = { backoffMinMs: 5, backoffMaxMs: 10 }
const retryable = (name: 'INSTRUMENT_UNKNOWN' | 'VENUE_UNAVAILABLE' | 'BUSY'): KernelError => new KernelError(makeProblem(name, `${name} from the engine`))

async function setup() {
  h = await makeHarness()
  const k = h.k
  vi.spyOn(k.gep, 'bindingOf').mockReturnValue({ accounts: [{ accountId: h.paper.accountId, mandateId: 'mdt_x' }, { accountId: h.liveAcct.accountId, mandateId: 'mdt_x' }], instruments: [BTC] } as never)
  const starts: Array<Record<string, any>> = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  let script: (params: Record<string, any>) => Promise<unknown> | unknown = (p) => ({ instanceId: p.instanceId }) // eslint-disable-line @typescript-eslint/no-explicit-any
  k.gep.callEngine = vi.fn(async (_e: string, method: string, params: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (method !== 'strategy.start') throw new Error(`unexpected engine call ${method}`)
    starts.push(params)
    const r = await script(params)
    k.gep.instances.recordStart(ENGINE, params, { instanceId: params.instanceId }, undefined)
    return r
  }) as never
  const seed = (instanceId: string, accountId: string, instruments: string[] = [BTC]): string => {
    k.gep.instances.recordStart(ENGINE, { strategyId: 'ema-trend', accountId, instruments, interval: '1m', params: { fast: 5 }, mandateId: 'mdt_x' }, { instanceId },
      { owner: HUMAN, origin: mkOrigin('user:usr_local', 'test', 'ui') })
    return instanceId
  }
  const rpc = vi.fn(async (method: string) => { if (method === 'strategy.status') return { instances: [] }; throw new Error(`unexpected rpc ${method}`) })
  const run = (o: RestoreOptions = FAST) => restoreInstances(k.gep, { rpc: { call: rpc } }, ENGINE, o)
  const row = (id: string) => k.gep.instances.get(id)!
  const addSol = (): void => { h!.live.instrumentsList.push({ ...h!.live.instrumentsList[0]!, instrumentId: SOL as never, symbol: 'SOL', displaySymbol: 'SOL', base: 'SOL' }) }
  const restoreEntries = () => k.ledger.query({ types: ['engine.event'] }).filter((e) => (e.payload as { action?: unknown } | undefined)?.action === 'strategy.restore')
  return { starts, seed, run, row, rpc, addSol, restoreEntries, setScript: (f: typeof script) => { script = f } }
}

describe('R2-REL-01 策略实例恢复', () => {
  it('[R6B-RS1] 标的没到齐先等：不发 strategy.start、不提前标 needsRestart；认得之后按退避重试恢复成功', async () => {
    const t = await setup()
    t.seed('inst_W1', h!.paper.accountId, [SOL]) // 内核还不认得 SOL（场所目录没装完）
    const done = t.run()
    await wait(80)
    expect(t.starts).toHaveLength(0)
    expect(t.row('inst_W1').needsRestart).toBeUndefined()
    expect(t.restoreEntries()).toHaveLength(0)
    t.addSol() // 目录装完
    await done
    expect(t.starts.map((s) => s.instanceId)).toEqual(['inst_W1'])
    expect(t.row('inst_W1').needsRestart).toBeUndefined()
    expect(t.restoreEntries()).toHaveLength(1)
    expect(h!.k.gep.restartWarnings()).toHaveLength(0)
  })

  it('[R6B-RS1] 引擎侧报 INSTRUMENT_UNKNOWN（内核以为已知）也按退避重试；过了期限进 needsRestart（restore timed out）', async () => {
    const t = await setup()
    t.seed('inst_W2', h!.paper.accountId)
    let n = 0
    t.setScript(() => { if (++n <= 2) throw retryable('INSTRUMENT_UNKNOWN'); return {} })
    await t.run()
    expect(t.starts).toHaveLength(3)
    expect(t.row('inst_W2').needsRestart).toBeUndefined()

    t.seed('inst_W3', h!.paper.accountId)
    t.setScript(() => { h!.clock.advance(11 * 60_000); throw retryable('INSTRUMENT_UNKNOWN') }) // 一直认不得，且时间走过了期限
    await t.run()
    expect(t.row('inst_W3').needsRestart?.reason).toMatch(/^restore timed out: .*INSTRUMENT_UNKNOWN/)
  })

  it('[R6B-RS2] 可重试失败不计入 10 分钟 3 次的崩溃保护；不可重试的照旧计入并直接进 needsRestart', async () => {
    const t = await setup()
    t.seed('inst_R1', h!.paper.accountId)
    let n = 0
    t.setScript(() => { if (++n <= 5) throw retryable(n % 2 ? 'VENUE_UNAVAILABLE' : 'BUSY'); return {} }) // 5 次可重试失败，第 6 次成功
    await t.run()
    expect(t.starts).toHaveLength(6)
    expect(t.row('inst_R1').needsRestart).toBeUndefined()
    expect(t.row('inst_R1').restore?.attempts).toBe(1) // 只有成功的这一次计数；5 次重试没算
    expect(h!.k.gep.instances.restoreAttempts('inst_R1', h!.clock.now())).toBe(1)

    t.seed('inst_R2', h!.paper.accountId)
    t.setScript(() => { throw new Error('engine says no') })
    await t.run()
    expect(t.row('inst_R2').needsRestart?.reason).toMatch(/^restore failed: engine says no/)
    expect(t.row('inst_R2').restore?.attempts).toBe(1)
    expect(t.starts.filter((s) => s.instanceId === 'inst_R2')).toHaveLength(1) // 不可重试：只试一次
  })

  it('[R6B-RS3] 实盘账户的实例一律不自动恢复：原因含 live，重试期间也是零次 strategy.start', async () => {
    const t = await setup()
    t.seed('inst_L1', h!.liveAcct.accountId, [SOL])
    t.seed('inst_L2', h!.liveAcct.accountId) // 标的认得，也不恢复
    t.seed('inst_P1', h!.paper.accountId, [SOL]) // 纸面这条在等标的：整个等待期里都有重试在跑
    const done = t.run()
    await wait(80)
    t.addSol()
    await done
    expect(t.starts.map((s) => s.instanceId)).toEqual(['inst_P1'])
    for (const id of ['inst_L1', 'inst_L2']) {
      expect(t.row(id).needsRestart?.reason).toMatch(/live/)
      expect(t.row(id).needsRestart?.reason).toMatch(/实盘账户的策略不自动恢复/)
    }
    expect(t.row('inst_P1').needsRestart).toBeUndefined()
  })

  it('[R6B-RS4] 交易状态不是 ACTIVE：标记一次 needsRestart（含状态名），不排重试，不起策略', async () => {
    const t = await setup()
    t.seed('inst_T1', h!.paper.accountId, [SOL]) // 标的还不认得——如果会排重试，这里就是个重试的好机会
    h!.k.tstate.set({ type: 'account', id: h!.paper.accountId }, 'REDUCING', 'test hold', h!.human().origin)
    const mark = vi.spyOn(h!.k.gep.instances, 'markNeedsRestart')
    await t.run() // 不排重试 = 这个 await 马上返回，不会等到标的出现
    expect(t.row('inst_T1').needsRestart?.reason).toMatch(/REDUCING/)
    expect(t.row('inst_T1').needsRestart?.reason).toMatch(/交易状态/)
    expect(mark).toHaveBeenCalledTimes(1)
    t.addSol()
    await wait(60)
    expect(t.starts).toHaveLength(0)
    expect(t.rpc).toHaveBeenCalledTimes(1) // strategy.status 只读了一次：没有第二轮
    expect(mark).toHaveBeenCalledTimes(1)
  })
})
