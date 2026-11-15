// SPDX-License-Identifier: Apache-2.0
// attestor 只加不改：旧签名 / 不开重试 = 旧行为（只问一次）；开重试（setAttestor(fn, { retry: true })）时 PIN 错带内核原文与剩余次数再问，最多 5 次；
// 第二参数 { tool, blockId, title } 让 PIN 弹层能写「动作 + 对象」并标出插件来源。
// 修复轮 1：Attestor 第二参数在类型上可选（单参调用能编译）；onCommand / onSettled 观察命令进出（壳的 PIN 弹层与接管跟踪用，不登记 = 旧行为）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATTEST_MAX_TRIES, ATTESTATION_REQUIRED, AUTH_FAILED, KernelClient, type AttestRequest, type Attestation, type Attestor } from '../src'
import { startFakeKernel, type FakeKernel } from '../src/testing/fake-kernel'

let k: FakeKernel
let c: KernelClient | null = null
const RIGHT = '246810'

const connect = async (): Promise<KernelClient> => {
  const r = await fetch(`${k.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: k.bootstrapToken }) })
  const tok = ((await r.json()) as { sessionToken: string }).sessionToken
  c = new KernelClient({ url: k.wsUrl, getToken: () => tok })
  await c.connect()
  return c
}
// 假内核：没证明 → ATTESTATION_REQUIRED；PIN 不对 → AUTH_FAILED（第 4 次起带 retryAfterMs，学 pin.ts 的锁定）
const guard = (action: string) => {
  let wrong = 0
  k.onCommand(action, (_p, ctx) => {
    const att = ctx.attestation as { pin?: string } | undefined
    if (!att) throw Object.assign(new Error('a presence proof (PIN) is required'), { code: 2009, data: { name: ATTESTATION_REQUIRED } })
    if (att.pin !== RIGHT) {
      wrong += 1
      throw Object.assign(new Error('invalid PIN'), { code: 2010, data: { name: AUTH_FAILED, message: 'invalid PIN', ...(wrong > 3 ? { retryAfterMs: 1000 * 2 ** (wrong - 4) } : {}) } })
    }
    return { ok: true }
  })
}
const pins = (action: string) => k.commands.filter((x) => x.action === action).map((x) => (x.attestation as { pin?: string } | undefined)?.pin ?? null)
const answers = (...seq: Array<string | null>) => vi.fn(async (_req: AttestRequest): Promise<Attestation | null> => {
  const pin = seq.shift()
  return pin == null ? null : { method: 'pin', pin }
})

beforeEach(async () => { k = await startFakeKernel() })
afterEach(async () => { c?.close(); c = null; await k.close() })

describe('attestor · 旧签名不开重试 = 旧行为', () => {
  it('PIN 错：只问一次，AUTH_FAILED 原样抛出', async () => {
    await connect()
    guard('trading_state.resume')
    const attest = answers('111111', RIGHT)
    c!.setAttestor(attest)
    await expect(c!.command('trading_state.resume', {})).rejects.toMatchObject({ problemName: AUTH_FAILED, message: 'invalid PIN' })
    expect(attest).toHaveBeenCalledOnce()
    expect(pins('trading_state.resume')).toEqual([null, '111111'])
  })
})

describe('attestor · 开重试', () => {
  it('错两次再对：同一次命令里问三次，后两次带内核原文与剩余次数', async () => {
    await connect()
    guard('trading_state.resume')
    const attest = answers('111111', '222222', RIGHT)
    c!.setAttestor(attest, { retry: true })
    expect(await c!.command('trading_state.resume', { scope: 'org' })).toEqual({ ok: true })
    expect(pins('trading_state.resume')).toEqual([null, '111111', '222222', RIGHT])
    const reqs = attest.mock.calls.map((a) => a[0])
    expect(reqs[0]).toEqual({ action: 'trading_state.resume', params: { scope: 'org' }, reason: 'a presence proof (PIN) is required' })
    expect(reqs[1]).toMatchObject({ error: 'invalid PIN', remaining: ATTEST_MAX_TRIES - 1, reason: 'a presence proof (PIN) is required' })
    expect(reqs[1]).not.toHaveProperty('retryAfterMs')
    expect(reqs[2]).toMatchObject({ error: 'invalid PIN', remaining: ATTEST_MAX_TRIES - 2 })
  })

  it('重试中取消：抛 ATTESTATION_REQUIRED（调用方当作取消，不报错）', async () => {
    await connect()
    guard('takeover.flatten_all')
    c!.setAttestor(answers('111111', null), { retry: true })
    await expect(c!.command('takeover.flatten_all', {})).rejects.toMatchObject({ problemName: ATTESTATION_REQUIRED })
    expect(pins('takeover.flatten_all')).toEqual([null, '111111'])
  })

  it('一直错：最多问 5 次，锁定时带 retryAfterMs，最后抛 AUTH_FAILED', async () => {
    await connect()
    guard('mandate.update')
    const attest = answers('1', '2', '3', '4', '5', '6')
    c!.setAttestor(attest, { retry: true })
    await expect(c!.command('mandate.update', {})).rejects.toMatchObject({ problemName: AUTH_FAILED })
    expect(attest).toHaveBeenCalledTimes(ATTEST_MAX_TRIES)
    expect(pins('mandate.update')).toEqual([null, '1', '2', '3', '4', '5'])
    const last = attest.mock.calls[ATTEST_MAX_TRIES - 1]![0]
    expect(last).toMatchObject({ remaining: 1, retryAfterMs: 1000 })
  })

  it('证明之后的别的错误（不是 AUTH_FAILED）不再问，原样抛出', async () => {
    await connect()
    k.onCommand('proposal.approve', (_p, ctx) => {
      if (!ctx.attestation) throw Object.assign(new Error('need PIN'), { code: 2009, data: { name: ATTESTATION_REQUIRED } })
      throw Object.assign(new Error('proposal T-1 is approved, not pending'), { code: 2001, data: { name: 'CONFLICT' } })
    })
    const attest = answers(RIGHT, RIGHT)
    c!.setAttestor(attest, { retry: true })
    await expect(c!.command('proposal.approve', {})).rejects.toMatchObject({ message: 'proposal T-1 is approved, not pending' })
    expect(attest).toHaveBeenCalledOnce()
  })
})

describe('attestor · 第二参数 { tool, blockId, title }', () => {
  it('块桥发的命令带 blockId；壳直接发的只有 tool；title 原样透传', async () => {
    await connect()
    guard('takeover.flatten_all')
    const seen: unknown[] = []
    c!.setAttestor(async (_req, ctx) => { seen.push(ctx); return { method: 'pin', pin: RIGHT } })
    await c!.command('takeover.flatten_all', {}, { tool: 'block:block.gitrader.risk:takeover.flatten_all', title: '全部平仓' })
    await c!.command('takeover.flatten_all', {})
    expect(seen).toEqual([
      { tool: 'block:block.gitrader.risk:takeover.flatten_all', blockId: 'block.gitrader.risk', title: '全部平仓' },
      { tool: 'ui:takeover.flatten_all' },
    ])
  })

  it('Attestor 类型的第二参数可选：拿到一个 Attestor 只传 req 调用也能编译（typecheck 覆盖这一条）', async () => {
    const a: Attestor = async (req) => (req.action === 'x' ? { method: 'pin', pin: RIGHT } : null)
    expect(await a({ action: 'x', params: {} })).toEqual({ method: 'pin', pin: RIGHT })
  })
})

describe('onCommand / onSettled · 命令进出（只加不改）', () => {
  it('每条命令发出一次、落定一次：带证明的重发与重试算同一条，params 是调用方的同一个对象；取消在场证明也算落定（ok=false）；退订后不再收到', async () => {
    await connect()
    guard('trading_state.resume')
    const seen: string[] = []
    const params = { scope: 'org' }
    const offA = c!.onCommand((x) => { seen.push(`发 ${x.action} ${x.tool} ${x.params === params}`) })
    const offB = c!.onSettled((x) => { seen.push(`落 ${x.action} ${x.ok} ${x.params === params}`) })
    c!.setAttestor(answers('111111', RIGHT), { retry: true })
    expect(await c!.command('trading_state.resume', params)).toEqual({ ok: true })
    expect(seen).toEqual(['发 trading_state.resume ui:trading_state.resume true', '落 trading_state.resume true true'])
    c!.setAttestor(answers(null))
    await expect(c!.command('trading_state.resume', params, { tool: 'block:block.gitrader.risk:trading_state.resume' })).rejects.toMatchObject({ problemName: ATTESTATION_REQUIRED })
    expect(seen.slice(2)).toEqual(['发 trading_state.resume block:block.gitrader.risk:trading_state.resume true', '落 trading_state.resume false true'])
    offA()
    offB()
    c!.setAttestor(answers(RIGHT))
    await c!.command('trading_state.resume', params)
    expect(seen).toHaveLength(4)
  })

  it('观察者抛错不影响命令结果；没有观察者时命令照旧', async () => {
    await connect()
    k.onCommand('venue.reconnect', () => ({ ok: true }))
    expect(await c!.command('venue.reconnect', { venue: 'hyperliquid' })).toEqual({ ok: true })
    c!.onCommand(() => { throw new Error('观察者坏了') })
    c!.onSettled(() => { throw new Error('观察者坏了') })
    expect(await c!.command('venue.reconnect', { venue: 'hyperliquid' })).toEqual({ ok: true })
  })
})
