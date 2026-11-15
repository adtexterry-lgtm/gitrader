// SPDX-License-Identifier: CPAL-1.0
// GEP 方法与错误码：握手 / 版本 / 鉴权 / describe / bind / 能力诚实 / 秘密字段 / 策略生命周期。
import { afterEach, describe, expect, it } from 'vitest'
import { validateEngineDescribe, validateProblem, validateGepHelloResult } from '../../protocol/src/validate'
import { rig, bindPaper, TOKEN, BTC, PAPER_ACCOUNT, MANDATE_ID, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

describe('握手：版本协商与鉴权', () => {
  it('版本协商：["0.1"] 选中 0.1；["9.9"] 返回 5001；hello 结果符合 schema', async () => {
    r = await rig({ hello: false })
    const bad = await r.session.hello({ token: TOKEN, versions: ['9.9'] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) { expect(bad.error.code).toBe(5001); expect(validateProblem(bad.error.data).ok).toBe(true); expect(bad.error.data?.category).toBe('PROTOCOL') }
    const ok = await r.session.hello({ token: TOKEN, versions: ['0.1'] })
    expect(ok.ok).toBe(true)
    if (ok.ok) { expect(ok.result.version).toBe('0.1'); expect(ok.result.resumed).toBe(false); expect(validateGepHelloResult(ok.result).ok).toBe(true) }
  })

  it('错误令牌 → 5003，并在 1 秒内断开连接', async () => {
    r = await rig({ hello: false })
    const t0 = Date.now()
    const o = await r.session.hello({ token: 'wrong' })
    expect(o.ok).toBe(false)
    if (!o.ok) expect(o.error.code).toBe(5003)
    expect(await r.session.waitClosed(1000)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('没握手就调别的方法 → 5003', async () => {
    r = await rig({ hello: false })
    const e = await r.session.expectError('engine.describe', {})
    expect(e.code).toBe(5003)
  })
})

describe('engine.describe：能力声明', () => {
  it('过 describe schema；能力位诚实：只有模式 A、用工作台行情、回测假设写明资金费 / 强平为 false', async () => {
    r = await rig()
    const d = await r.session.call('engine.describe', {})
    const v = validateEngineDescribe(d)
    expect(v.ok, JSON.stringify(v)).toBe(true)
    expect(d.capabilities['execution.modeA']).toBe(true)
    expect(d.capabilities['execution.modeB']).toBe(false)
    expect(d.capabilities['market.useHost']).toBe(true)
    expect(d.capabilities['market.own']).toBe(false)
    expect(d.capabilities['halt.levels']).toEqual(['halt_new', 'cancel_all', 'flatten_all'])
    expect(d.capabilities['builder.attach']).toBe(false)
    expect(d.assumptions.backtest).toMatchObject({ fill: 'next-bar-open', funding: false, liquidation: false })
    expect(d.strategies.map((s: { id: string }) => s.id)).toEqual(['ema-trend']) // 引擎不带策略：只有文件夹里装的
    for (const s of d.strategies) expect(s.name).not.toMatch(/example|推荐/)
    for (const k of Object.keys(d.capabilities)) expect(k.startsWith('x-') || /^[a-z]+(\.[a-zA-Z]+)?$/.test(k)).toBe(true)
  })
})

describe('engine.bind', () => {
  it('回显生效配置；builder 由宿主附加；未知账户 1005；模式 B 与引擎自带行情 5002', async () => {
    r = await rig()
    const res = await r.session.call('engine.bind', {
      bindingId: 'bind_01JABA', accounts: [{ accountId: PAPER_ACCOUNT, mode: 'A', mandateId: MANDATE_ID }], data: { source: 'host', instruments: [BTC] },
      policies: [], builder: { attachedBy: 'engine' }, heartbeatMs: 9000,
    })
    expect(res.bindingId).toBe('bind_01JABA')
    expect(res.effective.heartbeatMs).toBe(5000) // 心跳周期不得超过 5 s
    expect(res.effective.builder).toEqual({ attachedBy: 'host' })
    expect(res.warnings.join('|')).toMatch(/builder/)

    const unknown = await r.session.expectError('engine.bind', { bindingId: 'bind_x', accounts: [{ accountId: 'acct_01JAB0UNKNOWN000000000009', mode: 'A', mandateId: MANDATE_ID }], data: { source: 'host', instruments: [] }, policies: [], heartbeatMs: 5000 })
    expect(unknown.code).toBe(1005)
    expect(unknown.data?.category).toBe('REJECTED')

    const modeB = await r.session.expectError('engine.bind', { bindingId: 'bind_y', accounts: [{ accountId: PAPER_ACCOUNT, mode: 'B', mandateId: MANDATE_ID, signer: { fingerprint: 'fp' } }], data: { source: 'host', instruments: [] }, policies: [], heartbeatMs: 5000 })
    expect(modeB.code).toBe(5002)
    const own = await r.session.expectError('engine.bind', { bindingId: 'bind_z', accounts: [{ accountId: PAPER_ACCOUNT, mode: 'A', mandateId: MANDATE_ID }], data: { source: 'engine', instruments: [] }, policies: [], heartbeatMs: 5000 })
    expect(own.code).toBe(5002)
  })
})

describe('能力诚实与错误模型', () => {
  it('未声明的方法：模式 B 的 order.* / account.snapshot / market.* → 5002；不存在的方法 → -32601；错误体是合法 Problem', async () => {
    r = await rig()
    for (const m of ['order.place', 'order.amend', 'order.cancel', 'order.cancelAll', 'account.snapshot', 'market.subscribe', 'market.snapshot', 'market.history']) {
      const e = await r.session.expectError(m, {})
      expect(e.code, m).toBe(5002)
      expect(validateProblem(e.data).ok, m).toBe(true)
      expect(e.data?.category).toBe('PROTOCOL')
    }
    const nf = await r.session.expectError('engine.nope', {})
    expect(nf.code).toBe(-32601)
    const hostSide = await r.session.expectError('host.order.place', {})
    expect(nf.data?.category).toBe('PROTOCOL')
    expect(hostSide.code).toBe(-32601)
  })

  it('参数无效 -32602；解析错误 -32700；批量请求按序回响应；通知不回', async () => {
    r = await rig()
    const e = await r.session.expectError('strategy.params', { strategyId: 'nope' })
    expect(e.code).toBe(-32602)
    r.session.sendRaw('{not json')
    expect(await r.session.waitFor(() => r!.session.raw.some((t) => t.includes('"code":-32700')), 1000)).toBe(true)
    const before = r.session.raw.length
    r.session.sendRaw(JSON.stringify([
      { jsonrpc: '2.0', id: 901, method: 'engine.health', params: {} },
      { jsonrpc: '2.0', method: 'gep.heartbeat', params: {} },
      { jsonrpc: '2.0', id: 902, method: 'strategy.list', params: {} },
    ]))
    expect(await r.session.waitFor(() => r!.session.raw.length > before, 1000)).toBe(true)
    const batch = JSON.parse(r.session.raw[r.session.raw.length - 1]!) as { id: number }[]
    expect(batch.map((x) => x.id)).toEqual([901, 902])
  })

  it('秘密字段一律 5006 拒收：bind / 策略参数 / 任意位置；消息不回显值；BacktestSpec.seed 不算', async () => {
    r = await rig()
    await bindPaper(r)
    const canary = 'CANARY-do-not-echo-9f8e7d6c5b4a'
    const a = await r.session.expectError('engine.bind', { bindingId: 'bind_s', accounts: [], data: { source: 'host', instruments: [] }, policies: [], heartbeatMs: 5000, privateKey: canary })
    expect(a.code).toBe(5006)
    const b = await r.session.expectError('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], params: { fast: 10, apiSecret: canary }, mandateId: MANDATE_ID })
    expect(b.code).toBe(5006)
    const c = await r.session.expectError('strategy.update', { instanceId: 'inst_x', params: { mnemonic: canary } })
    expect(c.code).toBe(5006)
    for (const e of [a, b, c]) { expect(JSON.stringify(e)).not.toContain(canary); expect(e.data?.category).toBe('PROTOCOL') }
    // seed 是回测种子：放过（参数本身会因别的原因失败，但不能是 5006）
    const s = await r.session.expectError('backtest.run', { spec: { seed: 1 } })
    expect(s.code).not.toBe(5006)
  })
})

describe('策略生命周期：list / params / start / update / status / stop', () => {
  it('参数 schema 合法；start 需要先绑定账户；超范围参数 -32602；flatten:true 被拒', async () => {
    r = await rig()
    const list = await r.session.call('strategy.list', {})
    expect(list.strategies.map((s: { id: string }) => s.id)).toEqual(['ema-trend'])
    const p = await r.session.call('strategy.params', { strategyId: 'ema-trend' })
    expect(p.schema.type).toBe('object')
    expect(p.schema.additionalProperties).toBe(false)
    expect(p.defaults).toEqual({ fast: 20, slow: 60, allowShort: true })
    expect(p.schema.properties.size.pattern).toBeTypeOf('string') // 实例通用参数：单笔数量上限

    const unbound = await r.session.expectError('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], params: {}, mandateId: MANDATE_ID })
    expect(unbound.code).toBe(1005)
    await bindPaper(r)
    const range = await r.session.expectError('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], params: { fast: 1 }, mandateId: MANDATE_ID })
    expect(range.code).toBe(-32602)
    const unknownInstrument = await r.session.expectError('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: ['hyperliquid:NOPE'], params: {}, mandateId: MANDATE_ID })
    expect(unknownInstrument.code).toBe(1001)

    const s = await r.session.call('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: { fast: 5, slow: 20 }, mandateId: MANDATE_ID })
    expect(s.status).toBe('running')
    expect(s.instanceId).toMatch(/^inst_/)
    // 幂等：同一个 instanceId 同样配置再 start → 同一个实例
    const again = await r.session.call('strategy.start', { strategyId: 'ema-trend', instanceId: s.instanceId, accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: { fast: 5, slow: 20 }, mandateId: MANDATE_ID })
    expect(again.instanceId).toBe(s.instanceId)
    // 同账户同标的同策略不能再起第二个
    const dup = await r.session.expectError('strategy.start', { strategyId: 'ema-trend', accountId: PAPER_ACCOUNT, instruments: [BTC], interval: '1m', params: {}, mandateId: MANDATE_ID })
    expect(dup.code).toBe(-32602)

    const u = await r.session.call('strategy.update', { instanceId: s.instanceId, params: { fast: 8 } })
    expect(u.status).toBe('running')
    const st = await r.session.call('strategy.status', { instanceId: s.instanceId })
    expect(st.instances[0].params).toMatchObject({ fast: 8, slow: 20 })
    const badUpdate = await r.session.expectError('strategy.update', { instanceId: s.instanceId, params: { fast: 'x' } })
    expect(badUpdate.code).toBe(-32602)

    const flat = await r.session.expectError('strategy.stop', { instanceId: s.instanceId, flatten: true })
    expect(flat.code).toBe(-32602)
    const stopped = await r.session.call('strategy.stop', { instanceId: s.instanceId, flatten: false })
    expect(stopped.status).toBe('stopped')
    const all = await r.session.call('strategy.status', {})
    expect(all.instances).toHaveLength(1)
    expect(all.instances[0].status).toBe('stopped')
  })
})
