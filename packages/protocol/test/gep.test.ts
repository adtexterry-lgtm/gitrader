// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import {
  ENGINE_METHOD_NAMES, GEP_METHODS, GEP_STREAMS, GEP_STREAM_NAMES, HOST_METHOD_NAMES, PROBLEM_CODES, categoryOfCode, checkBindingAgainstDescribe,
  checkEngineLaunch, checkEventSequence, engineMethodSupported, findSecretFields, isKnownCapability, isRemoteEngineLaunch, makeProblem, majorMinor,
  negotiateVersion, rejectSecretFields, rpcError, transportOfLaunch, validateEngineLaunch, validateGepParams, validateGepResult, validateProblem,
  validateJsonRpcResponse, type EngineLaunch, type GepEvent,
} from '../src'
import { clone, contract } from './helpers'

describe('版本协商（§2.9，只看 MAJOR.MINOR）', () => {
  it('选中双方都支持的最高版本；没有交集返回 null（调用方回 5001）', () => {
    expect(negotiateVersion(['0.1'])).toBe('0.1')
    expect(negotiateVersion(['0.1.0'])).toBe('0.1')
    expect(negotiateVersion(['0.2', '0.1'])).toBe('0.1')
    expect(negotiateVersion(['9.9'])).toBeNull()
    expect(negotiateVersion([])).toBeNull()
    expect(negotiateVersion(['0.1', '0.3'], ['0.1', '0.2', '0.3'])).toBe('0.3')
    expect(negotiateVersion(['garbage'])).toBeNull()
    expect(majorMinor('1.12.3')).toBe('1.12')
    expect(majorMinor('x')).toBeNull()
  })
})

describe('错误码表（§2.8）', () => {
  it('每个码的类别与码段一致，名字唯一，码唯一', () => {
    const names = new Set<string>()
    const codes = new Set<number>()
    for (const [key, info] of Object.entries(PROBLEM_CODES)) {
      expect(info.name, key).toBe(key)
      expect(categoryOfCode(info.code), key).toBe(info.category)
      expect(names.has(info.name)).toBe(false)
      expect(codes.has(info.code)).toBe(false)
      names.add(info.name)
      codes.add(info.code)
    }
  })
  it('契约点名的码都在', () => {
    expect(PROBLEM_CODES.INSTRUMENT_UNKNOWN.code).toBe(1001)
    expect(PROBLEM_CODES.CONFIRM_TOKEN_INVALID.code).toBe(1008)
    expect(PROBLEM_CODES.RULE_DENIED.code).toBe(2001)
    expect(PROBLEM_CODES.NEEDS_APPROVAL.code).toBe(2009)
    expect(PROBLEM_CODES.VENUE_OUTCOME_UNKNOWN.code).toBe(3006)
    expect(PROBLEM_CODES.SESSION_GAP.code).toBe(5004)
    expect(PROBLEM_CODES.SECRET_FIELD_REJECTED.code).toBe(5006)
    expect(PROBLEM_CODES.METHOD_NOT_FOUND.code).toBe(-32601)
  })
  it('可重试性：2007 / 2008 / 3002 / 3003 可重试；3006 不得盲目重发', () => {
    expect(PROBLEM_CODES.STALE_PRICE.retryable).toBe(true)
    expect(PROBLEM_CODES.RATE_BUDGET.retryable).toBe(true)
    expect(PROBLEM_CODES.VENUE_RATE_LIMITED.retryable).toBe(true)
    expect(PROBLEM_CODES.VENUE_UNAVAILABLE.retryable).toBe(true)
    expect(PROBLEM_CODES.VENUE_OUTCOME_UNKNOWN.retryable).toBe(false)
    expect(PROBLEM_CODES.RULE_DENIED.retryable).toBe(false)
  })
  it('rpcError 把 Problem 放进 error.data，code 一致，且是合法响应', () => {
    const e = rpcError(77, 'CAPABILITY_UNSUPPORTED', 'replay is not declared in engine.describe')
    expect(e.error.code).toBe(5002)
    expect(e.error.data?.category).toBe('PROTOCOL')
    expect(validateJsonRpcResponse(e).ok).toBe(true)
    expect(validateProblem(e.error.data).ok).toBe(true)
  })
  it('makeProblem 不改写上游报错原文', () => {
    const p = makeProblem('VENUE_REJECTED', 'venue rejected the order', { venue: { id: 'hyperliquid', message: 'Order must have minimum value of $10. asset=4' } })
    expect(p.venue?.message).toBe('Order must have minimum value of $10. asset=4')
    expect(validateProblem(p).ok).toBe(true)
  })
})

describe('方法清单（§2.4）', () => {
  it('每个方法与通知都有 params schema；每个非通知方法有 result schema', () => {
    for (const name of [...ENGINE_METHOD_NAMES, ...HOST_METHOD_NAMES]) {
      const p = validateGepParams(name, {})
      if (!p.ok) expect(p.issues.map((i) => i.keyword), `${name} params`).not.toContain('unknownMethod')
      const r = validateGepResult(name, {})
      if (!r.ok) expect(r.issues.map((i) => i.keyword), `${name} result`).not.toContain('unknownMethod')
    }
    for (const n of ['events.push', 'gep.heartbeat', 'events.ack', 'gep.overflow', 'host.events.ack']) {
      const p = validateGepParams(n, {})
      if (!p.ok) expect(p.issues.map((i) => i.keyword)).not.toContain('unknownMethod')
    }
  })
  it('未知方法返回 unknownMethod', () => {
    const r = validateGepParams('engine.teleport', {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]?.keyword).toBe('unknownMethod')
  })
  it('方法数量与契约一致', () => {
    expect(ENGINE_METHOD_NAMES.length).toBe(32)
    expect(HOST_METHOD_NAMES.length).toBe(22)
    expect(HOST_METHOD_NAMES.filter((name) => name.startsWith('paper.replay.'))).toEqual([
      'paper.replay.start', 'paper.replay.status', 'paper.replay.stop',
    ])
    expect(ENGINE_METHOD_NAMES).toContain('engine.halt')
    expect(HOST_METHOD_NAMES).toContain('host.risk.precheck')
  })
  it('必选方法 / 能力位门', () => {
    const modeAOnly = { 'execution.modeA': true, strategy: true, 'market.useHost': true } as const
    expect(engineMethodSupported('engine.health', {})).toBe(true)
    expect(engineMethodSupported('backtest.run', modeAOnly)).toBe(false)
    expect(engineMethodSupported('strategy.start', modeAOnly)).toBe(true)
    expect(engineMethodSupported('strategy.update', modeAOnly)).toBe(false)
    expect(engineMethodSupported('strategy.update', { ...modeAOnly, 'strategy.hotUpdate': true })).toBe(true)
    expect(engineMethodSupported('order.place', modeAOnly)).toBe(false)
    expect(engineMethodSupported('order.place', { 'execution.modeB': true })).toBe(true)
    expect(GEP_METHODS['engine.resume'].requirement).toBe('always')
    expect(GEP_METHODS['host.order.place'].requirement).toBe('modeA')
  })
  it('请求 / 结果示例通过 schema', () => {
    expect(validateGepParams('host.order.place', { accountId: 'acct_01JABAPAPER000000000000001', clientOrderId: '9f1c3b5e7a2d4c6e8f0a1b2c3d4e5f60', intent: { accountId: 'acct_01JABAPAPER000000000000001', instrumentId: 'hyperliquid:BTC', side: 'buy', type: 'market', size: '0.001', maxSlippageBps: 50 } }).ok).toBe(true)
    expect(validateGepParams('host.order.place', { accountId: 'acct_01JABAPAPER000000000000001' }).ok).toBe(false)
    expect(validateGepResult('engine.halt', { ack: true, appliedAt: 1791549157661 }).ok).toBe(true)
    expect(validateGepParams('engine.halt', { takeoverId: 'tko_01JABE0T2', level: 'halt_new', scope: {}, reason: 'x', deadlineMs: 200 }).ok).toBe(true)
    expect(validateGepParams('engine.halt', { takeoverId: 'tko_01JABE0T2', level: 'panic', scope: {}, reason: 'x', deadlineMs: 200 }).ok).toBe(false)
    expect(validateGepParams('host.market.history', { instrumentId: 'hyperliquid:BTC', interval: '1m', limit: 6000 }).ok).toBe(false)
    expect(validateGepParams('host.market.history', { instrumentId: 'hyperliquid:BTC', interval: '1m', limit: 5000 }).ok).toBe(true)
  })
})

describe('能力位与绑定', () => {
  it('已知能力位或 x- 扩展', () => {
    expect(isKnownCapability('execution.modeB')).toBe(true)
    expect(isKnownCapability('x-acme.fastpath')).toBe(true)
    expect(isKnownCapability('fastpath')).toBe(false)
  })
  it('模式 B 需要 execution.modeB、risk.cooperative 与签名者声明；签名者不得重复', () => {
    const describe_ = contract('engine-describe')
    const binding = contract('binding')
    expect(checkBindingAgainstDescribe(binding, describe_)).toEqual([])
    const b = clone(binding)
    b.accounts[1].mode = 'B'
    expect(checkBindingAgainstDescribe(b, describe_).join()).toContain("execution.modeB")
    expect(checkBindingAgainstDescribe(b, describe_).join()).toContain("signer")
    const d2 = clone(describe_)
    d2.capabilities['execution.modeB'] = true
    d2.capabilities['risk.cooperative'] = true
    b.accounts[1].signer = { address: '0xabc' }
    expect(checkBindingAgainstDescribe(b, d2)).toEqual([])
    b.accounts[0].mode = 'B'
    b.accounts[0].signer = { address: '0xabc' }
    expect(checkBindingAgainstDescribe(b, d2).join()).toContain('shared')
  })
})

describe('事件流（§2.5）', () => {
  const ev = (seq: number, eventId: string, stream: GepEvent['stream'], type: string): GepEvent => ({ seq, eventId, stream, type, ts: 1, data: {} })
  it('流表：14 个流，order / fill / position / funding / strategy / signal / decision / takeover / policy 无损', () => {
    expect(GEP_STREAMS.length).toBe(14)
    expect(GEP_STREAM_NAMES).toContain('takeover')
    const lossless = GEP_STREAMS.filter((s) => s.loss === 'lossless').map((s) => s.stream)
    expect(lossless).toEqual(expect.arrayContaining(['order', 'fill', 'position', 'funding', 'strategy', 'signal', 'decision', 'takeover', 'policy']))
    expect(GEP_STREAMS.find((s) => s.stream === 'log')?.loss).toBe('lossy')
    expect(GEP_STREAMS.find((s) => s.stream === 'market')?.loss).toBe('conflatable')
  })
  it('seq 严格递增、eventId 不重复、type 属于其 stream', () => {
    expect(checkEventSequence([ev(1, 'a', 'order', 'order.created'), ev(2, 'b', 'fill', 'fill'), ev(3, 'c', 'position', 'position.opened')])).toEqual([])
    expect(checkEventSequence([ev(1, 'a', 'order', 'order.created'), ev(1, 'b', 'order', 'order.filled')]).length).toBe(1)
    expect(checkEventSequence([ev(1, 'a', 'order', 'order.created'), ev(2, 'a', 'order', 'order.filled')]).join()).toContain('duplicate eventId')
    expect(checkEventSequence([ev(1, 'a', 'order', 'fill.created')]).join()).toContain('does not belong')
    expect(checkEventSequence([ev(5, 'a', 'order', 'order.created')], 5).length).toBe(1)
    const pushed = contract('events-push').params.events as GepEvent[]
    expect(checkEventSequence(pushed)).toEqual([])
  })
})

describe('秘密字段拒收（S1）', () => {
  it('嵌套任意位置、任意大小写 / 下划线写法都能找到，只返回路径不返回值', () => {
    const hits = findSecretFields({ a: { privateKey: '0xdead' }, b: [{ API_SECRET: 'x' }, { ok: 1 }], seed: 'phrase', nested: { deep: { pass_phrase: 'p' } } })
    expect(hits).toEqual(['$.a.privateKey', '$.b[0].API_SECRET', '$.seed', '$.nested.deep.pass_phrase'])
    expect(JSON.stringify(hits)).not.toContain('0xdead')
    expect(findSecretFields({ credentialRef: 'keychain:x', tokenRef: 'ref' })).toEqual([])
    // BacktestSpec.seed 是数字随机种子，不是种子短语
    expect(findSecretFields({ spec: { seed: 42 } })).toEqual([])
    expect(findSecretFields({ spec: { seed: 'abandon abandon' } })).toEqual(['$.spec.seed'])
  })
  it('rejectSecretFields 返回 5006，消息里没有值', () => {
    const e = rejectSecretFields(5, { params: { mnemonic: 'abandon abandon abandon' } })
    expect(e?.error.code).toBe(5006)
    expect(JSON.stringify(e)).not.toContain('abandon')
    expect(rejectSecretFields(5, { fine: true })).toBeNull()
  })
})

describe('引擎启动配置（v0.1.2：不限语言、不限跑在哪）', () => {
  const stdioGo: EngineLaunch = { command: './my-engine', args: ['--gep', 'stdio'], env: { RUST_LOG: 'info' }, cwd: '.' }
  const stdioPy: EngineLaunch = { command: 'python', args: ['-m', 'gitrader_nautilus'] }
  const stdioNode: EngineLaunch = { command: 'node', args: ['engine.mjs'] }
  const localWs: EngineLaunch = { url: 'ws://127.0.0.1:9100/gep', auth: { method: 'token', tokenRef: 'keychain:engine-local' } }
  const remote: EngineLaunch = { url: 'wss://engine.example.org/gep', auth: { method: 'mtls', clientCertRef: 'keychain:client-cert', caCertRef: 'keychain:ca' } }
  const remoteToken: EngineLaunch = { url: 'wss://engine.example.org/gep', auth: { method: 'token', tokenRef: 'keychain:remote' } }

  it.each([['Go / Rust 二进制', stdioGo], ['Python', stdioPy], ['Node', stdioNode], ['本地 ws', localWs], ['远程 wss + mTLS', remote], ['远程 wss + 令牌', remoteToken]])('%s 通过 schema 与语义检查', (_n, l) => {
    expect(validateEngineLaunch(l).ok).toBe(true)
    expect(checkEngineLaunch(l)).toEqual([])
  })
  it('传输推断与远程判定', () => {
    expect(transportOfLaunch(stdioGo)).toBe('stdio')
    expect(transportOfLaunch(localWs)).toBe('ws')
    expect(transportOfLaunch(remote)).toBe('wss')
    expect(isRemoteEngineLaunch(stdioGo)).toBe(false)
    expect(isRemoteEngineLaunch(localWs)).toBe(false)
    expect(isRemoteEngineLaunch(remote)).toBe(true)
    expect(isRemoteEngineLaunch({ url: 'wss://localhost:9100/gep', auth: { method: 'token', tokenRef: 'r' } })).toBe(false)
  })
  it('非 loopback 的 ws:// 被拒；令牌不许放在 URL 里；缺认证被拒', () => {
    expect(checkEngineLaunch({ url: 'ws://engine.example.org/gep', auth: { method: 'token', tokenRef: 'r' } }).join()).toContain('wss://')
    expect(checkEngineLaunch({ url: 'wss://engine.example.org/gep?token=abc', auth: { method: 'token', tokenRef: 'r' } }).join()).toContain('URL')
    expect(checkEngineLaunch({ url: `wss://user:pw${'@'}engine.example.org/gep`, auth: { method: 'token', tokenRef: 'r' } }).join()).toContain('URL')
    expect(validateEngineLaunch({ url: 'wss://engine.example.org/gep' }).ok).toBe(false)
    expect(validateEngineLaunch({ url: 'wss://engine.example.org/gep', auth: { method: 'token', token: 'plaintext' } }).ok).toBe(false)
    expect(validateEngineLaunch({ url: 'https://engine.example.org', auth: { method: 'token', tokenRef: 'r' } }).ok).toBe(false)
  })
  it('既有 command 又有 url 的混合配置无效；空 command 无效', () => {
    expect(validateEngineLaunch({ command: 'x', url: 'wss://a.example.org/gep', auth: { method: 'token', tokenRef: 'r' } }).ok).toBe(false)
    expect(validateEngineLaunch({ command: '  ' }).ok).toBe(false)
  })
  it('describe 可声明 wss；旧的 stdio / ws 仍有效', async () => {
    const { validateEngineDescribe } = await import('../src')
    const d = contract('engine-describe')
    d.protocol.transports = ['stdio', 'ws', 'wss']
    expect(validateEngineDescribe(d).ok).toBe(true)
    d.protocol.transports = ['carrier-pigeon']
    expect(validateEngineDescribe(d).ok).toBe(false)
  })
})
