// SPDX-License-Identifier: Apache-2.0
// v0.1.3：UI 通道线格式（壳 ↔ 内核）与连接器接口。
import { describe, expect, it } from 'vitest'
import {
  ATTESTATION_REQUIRED, PIN_PATTERN, PROBLEM_CODES, UI_COMMANDS, UI_LIMITS, UI_METHOD_NAMES, UI_SECRET_FIELD_EXEMPT, UI_SESSION_PATH, UI_WS_PATH, connector,
  findSecretFields, makeProblem, takeoverCommand, validateKeyInfo, validatePresenceProof, validateProblem, validateSessionExchangeRequest,
  validateSessionExchangeResult, validateSettingsSnapshot, validateUiAuthParams, validateUiCommandParams, validateUiEventParams, validateUiQueryParams,
  validateUiSubscribeParams, validateJsonRpcResponse, rpcError, TAKEOVER_LEVELS, type VenueCapabilities,
} from '../src'
import type { VenueConnector } from '@gitrader/protocol/connector'
import { sample } from './helpers'

describe('UI 通道线格式', () => {
  it('路径与方法', () => {
    expect(UI_WS_PATH).toBe('/ui')
    expect(UI_SESSION_PATH).toBe('/api/session')
    expect([...UI_METHOD_NAMES]).toEqual(['auth', 'subscribe', 'unsubscribe', 'query', 'command'])
    expect(UI_LIMITS.authTimeoutMs).toBe(5000)
  })
  it('换票：请求 {bootstrap} → 结果 {sessionToken, user, ws?}', () => {
    expect(validateSessionExchangeRequest({ bootstrap: 'b1' }).ok).toBe(true)
    expect(validateSessionExchangeRequest({ boot: 'b1' }).ok).toBe(false)
    expect(validateSessionExchangeRequest({ bootstrap: '' }).ok).toBe(false)
    expect(validateSessionExchangeResult({ sessionToken: 'ses_abc', user: 'usr_local' }).ok).toBe(true)
    expect(validateSessionExchangeResult({ sessionToken: 'ses_abc', user: 'usr_local', ws: '/ui' }).ok).toBe(true)
    expect(validateSessionExchangeResult({ sessionToken: 'ses_abc', user: 'usr_local', ws: 'ws://elsewhere/x' }).ok).toBe(false)
    expect(validateSessionExchangeResult({ user: 'usr_local' }).ok).toBe(false)
  })
  it('auth / subscribe / query / command / event 的参数', () => {
    expect(validateUiAuthParams({ token: 't', client: { name: 'workbench', instanceId: 'w1' } }).ok).toBe(true)
    expect(validateUiAuthParams({ token: 't' }).ok).toBe(false)
    expect(validateUiSubscribeParams({ topic: 'market.quote', filter: { instrumentId: 'hyperliquid:BTC' }, maxHz: 4, fromSeq: 10 }).ok).toBe(true)
    expect(validateUiSubscribeParams({ topic: 'market.quote', maxHz: 0 }).ok).toBe(false)
    expect(validateUiQueryParams({ method: 'settings.get', params: {} }).ok).toBe(true)
    const cmd = { action: 'order.cancel', params: { orderId: 'ord_01JAB7Z0Q4V2W8X9Y0Z1A2B3C4' }, origin: { tool: 'ui:order.cancel', via: 'ui' } }
    expect(validateUiCommandParams(cmd).ok).toBe(true)
    expect(validateUiCommandParams({ ...cmd, origin: { tool: 'x', via: 'mcp' } }).ok).toBe(false)
    expect(validateUiCommandParams({ action: 'x', origin: { tool: 'x', via: 'ui' } }).ok).toBe(true)
    expect(validateUiEventParams({ subscriptionId: 's1', topic: 'market.quote', events: [{ seq: 1, ts: 1, data: { a: 1 } }] }).ok).toBe(true)
    expect(validateUiEventParams({ subscriptionId: 's1', topic: 'market.quote', seq: 2, data: 5 }).ok).toBe(true)
    expect(validateUiEventParams({ topic: 'market.quote' }).ok).toBe(false)
  })
  it('在场证明：PIN 为 6–12 位数字，且 method=pin 时必须带 pin', () => {
    expect(PIN_PATTERN).toBe('^[0-9]{6,12}$')
    expect(validatePresenceProof({ method: 'pin', pin: '123456' }).ok).toBe(true)
    expect(validatePresenceProof({ method: 'pin', pin: '12345' }).ok).toBe(false)
    expect(validatePresenceProof({ method: 'pin', pin: '1234567890123' }).ok).toBe(false)
    expect(validatePresenceProof({ method: 'pin', pin: 'abcdef' }).ok).toBe(false)
    expect(validatePresenceProof({ method: 'pin' }).ok).toBe(false)
    expect(validatePresenceProof({ method: 'passkey', assertion: { id: 'x' } }).ok).toBe(true)
    expect(validatePresenceProof({ method: 'fingerprint' }).ok).toBe(false)
    const withProof = { action: 'trading_state.resume', params: {}, origin: { tool: 'ui:trading_state.resume', via: 'ui' }, attestation: { method: 'pin', pin: '654321' } }
    expect(validateUiCommandParams(withProof).ok).toBe(true)
  })
  it('ATTESTATION_REQUIRED 是错误码表里的正式条目，error.data 是合法 Problem', () => {
    expect(ATTESTATION_REQUIRED).toBe('ATTESTATION_REQUIRED')
    expect(PROBLEM_CODES.ATTESTATION_REQUIRED).toMatchObject({ code: 1010, category: 'REJECTED', retryable: false })
    const e = rpcError(9, 'ATTESTATION_REQUIRED', 'presence proof required for trading_state.resume')
    expect(e.error.data?.name).toBe('ATTESTATION_REQUIRED')
    expect(validateJsonRpcResponse(e).ok).toBe(true)
    expect(validateProblem(makeProblem('ATTESTATION_REQUIRED', 'x')).ok).toBe(true)
  })
  it('命令表：恢复 ACTIVE 要在场证明、改布局还原是人面、接管三档任何人可', () => {
    const by = (a: string) => UI_COMMANDS.find((c) => c.action === a)
    expect(by('trading_state.resume')?.presence).toBe('attested')
    expect(by('workspace.revert')?.presence).toBe('session')
    for (const l of TAKEOVER_LEVELS) expect(by(takeoverCommand(l))?.presence).toBe('none')
    expect(by('credential.import')?.presence).toBe('session')
    expect(new Set(UI_COMMANDS.map((c) => c.action)).size).toBe(UI_COMMANDS.length)
  })
  it('秘密字段规则：credential.import 的 secret 是唯一豁免；其他命令里的 secret 仍被 S1 拒收', () => {
    expect(UI_SECRET_FIELD_EXEMPT).toEqual({ 'credential.import': ['secret'] })
    expect(findSecretFields({ secret: 'x', label: 'k' })).toEqual(['$.secret'])
    expect(findSecretFields({ pin: '123456' })).toEqual([])
  })
  it('设置快照与钥匙元数据（钥匙永远没有私钥字段）', () => {
    const key = { id: 'key_1', label: 'testnet', address: '0x0000000000000000000000000000000000000003', venue: 'hyperliquid', network: 'testnet', createdAt: 1791549000000 }
    expect(validateKeyInfo(key).ok).toBe(true)
    expect(validateKeyInfo({ ...key, network: 'devnet' }).ok).toBe(false)
    const snap = { network: 'testnet', pinSet: true, agentLayout: false, keys: [key] }
    expect(validateSettingsSnapshot(snap).ok).toBe(true)
    expect(validateSettingsSnapshot({ ...snap, pinSet: 'yes' }).ok).toBe(false)
    expect(findSecretFields(snap)).toEqual([])
  })
})

describe('连接器接口', () => {
  it('子路径入口与根入口命名空间是同一份', async () => {
    const sub = await import('@gitrader/protocol/connector')
    expect(sub.supportsScheduleCancel).toBe(connector.supportsScheduleCancel)
  })
  it('scheduleCancel 能力位：由 VenueCapabilities.deadman 声明', () => {
    const caps = sample('VenueCapabilities') as VenueCapabilities
    expect(connector.supportsScheduleCancel(caps)).toBe(true)
    const { deadman: _d, ...none } = caps
    expect(connector.supportsScheduleCancel(none as VenueCapabilities)).toBe(false)
  })
  it('接口形状（编译期检查）：最小桩实现满足 VenueConnector，TradeContext 带签名器句柄', () => {
    const stub = {
      venue: 'x', environment: 'testnet',
      describe: () => sample('VenueCapabilities'),
    } as unknown as VenueConnector
    expect(stub.venue).toBe('x')
    const budget: connector.RateBudget = {
      acquire: async () => {}, charge: () => {}, penalize: () => {}, reportOk: () => {},
      usage: () => ({ used: 0, target: 720, limit: 1200, ratio: 0, windowMs: 60000, backoffUntil: 0 }),
    }
    expect(budget.usage().limit).toBe(1200)
    const signer: connector.SignerHandle = { address: '0x0000000000000000000000000000000000000003', signTypedData: async () => '0x00' }
    expect(typeof signer.signTypedData).toBe('function')
  })
})

