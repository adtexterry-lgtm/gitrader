// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  formatIssues, listSchemaIds, validateAccount, validateAccountGroup, validateBacktestResult, validateBacktestSpec, validateBalance, validateBinding,
  validateBlockManifest, validateDecisionRecord, validateEngineDescribe, validateEventsPush, validateExperiment, validateFill, validateFundingPayment,
  validateGepHelloParams, validateGepHelloResult, validateInstrument, validateJsonRpcNotification, validateJsonRpcResponse, validateLedgerEntry,
  validateMandate, validateMarginSnapshot, validateOrder, validateOrderIntent, validateOrderResult, validateOrg, validateOrigin, validatePluginManifest,
  validatePosition, validatePrecheckResult, validateProblem, validateProposal, validateRiskPolicy, validateRuleHit, validateSignal,
  validateSimVenueDeclaration, validateTakeoverRequest, validateAgentKey, validateVenueCapabilities, validateWorkflow, validateWorkspace,
  validateBySchemaId, type ValidationResult,
} from '../src'
import { generateSchemas } from '../scripts/build-schemas.mjs'
import { PKG_ROOT, clone, contract, sample } from './helpers'

function expectOk(r: ValidationResult<unknown>, label: string): void {
  expect(r.ok, `${label}: ${r.ok ? '' : formatIssues(r.issues)}`).toBe(true)
}

describe('schema 注册表', () => {
  it('每个 schema 都能被 ajv 编译、$id 唯一、都有层标记', () => {
    const ids = listSchemaIds()
    expect(ids.length).toBeGreaterThanOrEqual(60)
    expect(new Set(ids).size).toBe(ids.length)
    const dir = join(PKG_ROOT, 'schemas')
    for (const f of readdirSync(dir)) {
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(doc.$id, f).toMatch(/^urn:gitrader:schema:/)
      expect(doc.$comment, f).not.toContain('FSL')
      expect(doc.$comment, f).toContain('SPDX-License-Identifier: Apache-2.0')
    }
  })
  it('schemas/*.json 与生成器输出一致（没有手改，也没有忘了重新生成）', async () => {
    const files = await generateSchemas()
    for (const [name, text] of files) {
      expect(readFileSync(join(PKG_ROOT, 'schemas', name), 'utf8'), name).toBe(text)
    }
  })
  it('schemas 目录里除手工维护的 workflow.json 外没有多余文件', async () => {
    const files = await generateSchemas()
    const extra = readdirSync(join(PKG_ROOT, 'schemas')).filter((f) => !files.has(f))
    expect(extra).toEqual(['workflow.json'])
  })
})

describe('契约示例夹具（§1.7、§2、§3.8、§4、§5、§6.6）全部通过对应 schema', () => {
  const table: [string, (d: unknown) => ValidationResult<unknown>][] = [
    ['sim-declaration', validateSimVenueDeclaration],
    ['instrument-xyz-tsla', validateInstrument],
    ['order-denied', validateOrder],
    ['engine-describe', validateEngineDescribe],
    ['binding', validateBinding],
    ['precheck-allow', validatePrecheckResult],
    ['plugin-nautilus', validatePluginManifest],
    ['workspace-default', validateWorkspace],
    ['mandate-l3', validateMandate],
    ['proposal-pending', validateProposal],
    ['decision-fast', validateDecisionRecord],
    ['ledger-risk-denied', validateLedgerEntry],
    ['ledger-takeover-applied', validateLedgerEntry],
  ]
  it.each(table)('%s', (name, validator) => {
    expectOk(validator(contract(name)), name)
  })
  it('events-push（JSON-RPC 通知 + params）', () => {
    const msg = contract('events-push')
    expectOk(validateJsonRpcNotification(msg), 'notification envelope')
    expectOk(validateEventsPush(msg.params), 'params')
  })
  it('rpc-error（JSON-RPC 错误响应，error.data 是 Problem）', () => {
    const msg = contract('rpc-error')
    expectOk(validateJsonRpcResponse(msg), 'response')
    expectOk(validateProblem(msg.error.data), 'Problem')
    expect(msg.error.code).toBe(msg.error.data.code)
  })
  it('§5.9 工作流 schema 本身可用：手写示例工作流通过', () => {
    expectOk(validateWorkflow(sample('Workflow')), 'workflow')
  })
})

describe('手写夹具（契约没有 JSON 示例的实体）', () => {
  const table: [string, (d: unknown) => ValidationResult<unknown>][] = [
    ['Org', validateOrg], ['AccountGroup', validateAccountGroup], ['Account', validateAccount], ['AccountLive', validateAccount],
    ['Balance', validateBalance], ['MarginSnapshot', validateMarginSnapshot], ['OrderIntent', validateOrderIntent], ['OrderIntentMarket', validateOrderIntent],
    ['Fill', validateFill], ['Position', validatePosition], ['FundingPayment', validateFundingPayment], ['RiskPolicy', validateRiskPolicy],
    ['Signal', validateSignal], ['Experiment', validateExperiment], ['AgentKey', validateAgentKey], ['TakeoverRequest', validateTakeoverRequest],
    ['BlockManifest', validateBlockManifest], ['VenueCapabilities', validateVenueCapabilities], ['GepHelloParams', validateGepHelloParams],
    ['GepHelloResult', validateGepHelloResult], ['BacktestSpec', validateBacktestSpec], ['BacktestResult', validateBacktestResult],
    ['OrderResultDenied', validateOrderResult],
  ]
  it.each(table)('%s', (name, validator) => {
    expectOk(validator(sample(name)), name)
  })
})

describe('反例：该拒绝的必须拒绝', () => {
  it('对账级数值用 number 而不是十进制字符串 → 拒绝', () => {
    const o = contract('order-denied')
    o.size = 0.1909
    expect(validateOrder(o).ok).toBe(false)
    const p = sample('Position')
    p.size = 1
    expect(validatePosition(p).ok).toBe(false)
    const f = sample('Fill')
    f.price = '83064.50'
    expect(validateFill(f).ok).toBe(false)
  })
  it('denied / rejected 订单必须带 problem', () => {
    const o = contract('order-denied')
    delete o.problem
    expect(validateOrder(o).ok).toBe(false)
    o.status = 'open'
    expect(validateOrder(o).ok).toBe(true)
  })
  it('RISK 类 Problem 必须带 ruleHits 与 precheckId；VENUE 类必须带 venue', () => {
    expect(validateProblem({ code: 2001, name: 'RULE_DENIED', category: 'RISK', message: 'x', retryable: false }).ok).toBe(false)
    expect(validateProblem({ code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: 'x', retryable: false }).ok).toBe(false)
    expect(validateProblem({ code: 3001, name: 'VENUE_REJECTED', category: 'VENUE', message: 'x', retryable: false, venue: { id: 'hyperliquid', message: 'Order has invalid size.' } }).ok).toBe(true)
  })
  it('RuleHit 的 limit / actual 必须是十进制字符串', () => {
    const hit = { ruleId: 'pol_01JAB1#maxLeverage', code: 'LEVERAGE', limit: 3, actual: '9', unit: 'x', action: 'deny', scope: 'account' }
    expect(validateRuleHit(hit).ok).toBe(false)
    expect(validateRuleHit({ ...hit, limit: '3' }).ok).toBe(true)
    expect(validateRuleHit({ ...hit, limit: '3', code: 'NOT_A_CODE' }).ok).toBe(false)
  })
  it('OrderIntent：size / notional 二选一必须有；限价类必须有 price；触发类必须有 triggerPrice', () => {
    const i = sample('OrderIntent')
    delete i.size
    expect(validateOrderIntent(i).ok).toBe(false)
    const j = sample('OrderIntent')
    delete j.price
    expect(validateOrderIntent(j).ok).toBe(false)
    const k = sample('OrderIntent')
    k.type = 'stop_limit'
    expect(validateOrderIntent(k).ok).toBe(false)
    k.triggerPrice = '82000'
    expect(validateOrderIntent(k).ok).toBe(true)
  })
  it('paper 账户必须有 paper.initialBalance', () => {
    const a = sample('Account')
    delete a.paper
    expect(validateAccount(a).ok).toBe(false)
  })
  it('signer.permissions.withdraw 只能是 false 或 "unknown"', () => {
    const a = sample('AccountLive')
    a.signer.permissions.withdraw = true
    expect(validateAccount(a).ok).toBe(false)
    a.signer.permissions.withdraw = 'unknown'
    expect(validateAccount(a).ok).toBe(true)
  })
  it('授权书：L3 缺心跳 / 缺必填额度 / 缺白名单 → 拒绝', () => {
    const m = contract('mandate-l3')
    const noHb = clone(m)
    delete noHb.heartbeat
    expect(validateMandate(noHb).ok).toBe(false)
    const noLoss = clone(m)
    delete noLoss.limits.maxDailyLoss
    expect(validateMandate(noLoss).ok).toBe(false)
    const noList = clone(m)
    delete noList.venueAllowlist
    expect(validateMandate(noList).ok).toBe(false)
    const l1 = clone(m)
    l1.level = 'L1'
    delete l1.heartbeat
    delete l1.venueAllowlist
    delete l1.instrumentAllowlist
    expect(validateMandate(l1).ok).toBe(true)
  })
  it('提案：下单类缺 priceBounds / intents 超过 10 条 / 已批准却没有 decision → 拒绝', () => {
    const p = contract('proposal-pending')
    const noBounds = clone(p)
    delete noBounds.priceBounds
    expect(validateProposal(noBounds).ok).toBe(false)
    const many = clone(p)
    many.intents = Array.from({ length: 11 }, () => clone(p.intents[0]))
    expect(validateProposal(many).ok).toBe(false)
    const approved = clone(p)
    approved.status = 'approved'
    expect(validateProposal(approved).ok).toBe(false)
    approved.decision = { by: 'user:usr_local', at: 1791549400000 }
    expect(validateProposal(approved).ok).toBe(true)
  })
  it('控制类提案的 intents 是 ControlIntent 对象', () => {
    const p = contract('proposal-pending')
    p.kind = 'control'
    delete p.accountId
    delete p.priceBounds
    expect(validateProposal(p).ok).toBe(false)
    p.intents = { controlKind: 'start_strategy', params: { strategyId: 'ema-trend' } }
    expect(validateProposal(p).ok).toBe(true)
  })
  it('Origin：actorType 必填，且必须与 actor 前缀一致', () => {
    const o = contract('order-denied').origin
    expect(validateOrigin(o).ok).toBe(true)
    const noType = clone(o)
    delete noType.actorType
    expect(validateOrigin(noType).ok).toBe(false)
    expect(validateOrigin({ ...o, actorType: 'human' }).ok).toBe(false)
    expect(validateOrigin({ ...o, actor: 'user:usr_local', actorType: 'human' }).ok).toBe(true)
    expect(validateOrigin({ ...o, actor: 'system:protector', actorType: 'system' }).ok).toBe(true)
    expect(validateOrigin({ ...o, actor: 'engine:gitrader-core', actorType: 'engine' }).ok).toBe(true)
    expect(validateOrigin({ ...o, requestId: 'tool_use_123' }).ok).toBe(false)
    expect(validateOrigin({ ...o, actorType: 'robot' }).ok).toBe(false)
  })
  it('账本：risk.denied 缺 precheck / ruleHits → 拒绝；seq=0 必须是创世 checkpoint', () => {
    const e = contract('ledger-risk-denied')
    const a = clone(e)
    delete a.ruleHits
    expect(validateLedgerEntry(a).ok).toBe(false)
    const b = clone(e)
    delete b.precheck
    expect(validateLedgerEntry(b).ok).toBe(false)
    const c = clone(e)
    c.seq = 0
    expect(validateLedgerEntry(c).ok).toBe(false)
    const noSubject = clone(e)
    noSubject.subject = {}
    expect(validateLedgerEntry(noSubject).ok).toBe(false)
  })
  it('describe：未知能力位 / halt.levels 缺 halt_new / 没有任何行情来源 → 拒绝；x- 扩展放行', () => {
    const d = contract('engine-describe')
    const unknown = clone(d)
    unknown.capabilities['mystery.feature'] = true
    expect(validateEngineDescribe(unknown).ok).toBe(false)
    const ext = clone(d)
    ext.capabilities['x-acme.fastpath'] = true
    expect(validateEngineDescribe(ext).ok).toBe(true)
    const noHalt = clone(d)
    noHalt.capabilities['halt.levels'] = ['cancel_all']
    expect(validateEngineDescribe(noHalt).ok).toBe(false)
    const noMarket = clone(d)
    noMarket.capabilities['market.useHost'] = false
    expect(validateEngineDescribe(noMarket).ok).toBe(false)
  })
  it('bind：模式 B 账户必须声明签名者；缺 bindingId → 拒绝', () => {
    const b = contract('binding')
    b.accounts[0].mode = 'B'
    expect(validateBinding(b).ok).toBe(false)
    b.accounts[0].signer = { address: '0x0000000000000000000000000000000000000009' }
    expect(validateBinding(b).ok).toBe(true)
    delete b.bindingId
    expect(validateBinding(b).ok).toBe(false)
  })
  it('hello：令牌或 mTLS 至少一个', () => {
    const h = sample('GepHelloParams')
    h.auth = {}
    expect(validateGepHelloParams(h).ok).toBe(false)
    h.auth = { mtls: true }
    expect(validateGepHelloParams(h).ok).toBe(true)
  })
  it('事件：stream 必须是已知流', () => {
    const msg = contract('events-push')
    msg.params.events[0].stream = 'telepathy'
    expect(validateEventsPush(msg.params).ok).toBe(false)
  })
  it('风控策略：maxSlippageBps、failClosed、attestation 必填；denyLlmLiveEntries 必须是布尔', () => {
    const p = sample('RiskPolicy')
    for (const k of ['failClosed', 'attestation', 'dailyResetAt']) {
      const q = clone(p)
      delete q[k]
      expect(validateRiskPolicy(q).ok, k).toBe(false)
    }
    const noSlip = clone(p)
    delete noSlip.limits.maxSlippageBps
    expect(validateRiskPolicy(noSlip).ok).toBe(false)
    expect(validateRiskPolicy({ ...p, denyLlmLiveEntries: false }).ok).toBe(true)
    expect(validateRiskPolicy({ ...p, denyLlmLiveEntries: 'no' }).ok).toBe(false)
    const badProtector = clone(p)
    badProtector.protectors.push({ kind: 'drawdown_pause' })
    expect(validateRiskPolicy(badProtector).ok).toBe(false)
  })
  it('授权书也可带 denyLlmLiveEntries', () => {
    const m = contract('mandate-l3')
    m.denyLlmLiveEntries = false
    expect(validateMandate(m).ok).toBe(true)
    m.denyLlmLiveEntries = 'off'
    expect(validateMandate(m).ok).toBe(false)
  })
  it('信号：strength / confidence 只有声明了 method 才允许；target 类必须有 target', () => {
    const s = sample('Signal')
    delete s.method
    expect(validateSignal(s).ok).toBe(false)
    const t = sample('Signal')
    delete t.target
    expect(validateSignal(t).ok).toBe(false)
  })
  it('实验：backtest 阶段必须有 assumptions', () => {
    const e = sample('Experiment')
    delete e.assumptions
    expect(validateExperiment(e).ok).toBe(false)
    e.stage = 'draft'
    expect(validateExperiment(e).ok).toBe(true)
  })
  it('回测结果：五项假设齐全', () => {
    const r = sample('BacktestResult')
    delete r.assumptions.liquidation
    expect(validateBacktestResult(r).ok).toBe(false)
  })
  it('块清单：inline / iframe 之外的隔离级别、未知权限 → 拒绝', () => {
    const b = sample('BlockManifest')
    b.isolation = 'none'
    expect(validateBlockManifest(b).ok).toBe(false)
    const c = sample('BlockManifest')
    c.permissions = ['proposal.approve']
    expect(validateBlockManifest(c).ok).toBe(false)
  })
  it('按 $id 校验未知 schema 会抛错而不是静默通过', () => {
    expect(() => validateBySchemaId('urn:gitrader:schema:model:0.1:Nope', {})).toThrow()
  })
})
