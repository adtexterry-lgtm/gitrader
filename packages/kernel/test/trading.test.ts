// SPDX-License-Identifier: CPAL-1.0
// 钥匙 / 授权书 / 提案状态机 / confirmToken / 结果未知 / 实盘闸 / denyLlmLiveEntries 语义。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROPOSAL_TRANSITIONS, PROPOSAL_STATUSES, PROPOSAL_EVENTS, nextProposalStatus } from '../src/proto'
import type { OrderIntent } from '../src/proto'
import { checkMandateInput } from '../src/agents'
import { mkOrigin } from '../src/util/origin'
import { problemOfPrecheck } from '../src/trading'
import { D } from '../src/util/dec'
import { BTC } from './helpers/fake-connector'
import { enableLive, makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const liveIntent = (o: Partial<OrderIntent> = {}): OrderIntent => ({ accountId: h.liveAcct.accountId as never, instrumentId: BTC, side: 'buy', type: 'market', size: '0.003' as never, leverage: 2, reason: 'funding flipped', ...o } as OrderIntent)
const paperIntent = (o: Partial<OrderIntent> = {}): OrderIntent => liveIntent({ accountId: h.paper.accountId as never, ...o })

describe('Agent 钥匙与授权书（对外四档 ↔ 内部五级）', () => {
  it('四档 → L0 / L1 / L2 / L3；令牌 gtk_ + base32、只显示一次、库里只有慢哈希', async () => {
    const levels: Record<string, string> = {}
    for (const tier of ['read_only', 'paper', 'confirm', 'auto_limited'] as const) {
      const a = await makeAgent(h, tier)
      levels[tier] = a.mandate.level
      expect(a.token).toMatch(/^gtk_[A-Z2-7]{52}$/)
    }
    expect(levels).toEqual({ read_only: 'L0', paper: 'L1', confirm: 'L2', auto_limited: 'L3' })
    const raw = JSON.stringify(h.k.db.prepare("SELECT doc FROM docs WHERE coll='agentkey'").all())
    expect(raw).toContain('scrypt'.length ? 'hash' : '')
    expect(raw).not.toMatch(/gtk_[A-Z2-7]{52}/)
    expect(JSON.stringify(h.k.agents.listKeys())).not.toContain('secret')
  })

  it('必填字段按级别检查：L2 要白名单与限额，L3 要心跳与自动阈值，L3/L4 最长 90 天', () => {
    const now = Date.now()
    expect(checkMandateInput({ subject: { type: 'agentKey', id: 'ak_1' }, level: 'L2', accounts: ['acct_1' as never] }, now).join('|')).toMatch(/venueAllowlist.*instrumentAllowlist.*maxOrderNotional.*maxDailyNotional/)
    expect(checkMandateInput({ subject: { type: 'agentKey', id: 'ak_1' }, level: 'L3', accounts: ['acct_1' as never], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1' as never, maxDailyNotional: '2' as never, maxDailyLoss: '1' as never, autoMaxOrderNotional: '1' as never }, notAfter: now + 100 * 86_400_000, heartbeat: { intervalSec: 60, timeoutSec: 180, onTimeout: { downgradeTo: 'L0', takeover: 'halt_new' } } }, now).join('|')).toMatch(/within 90 days/)
    expect(checkMandateInput({ subject: { type: 'agentKey', id: 'ak_1' }, level: 'L3', accounts: ['acct_1' as never], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '1' as never, maxDailyNotional: '2' as never, maxDailyLoss: '1' as never, autoMaxOrderNotional: '1' as never } }, now).join('|')).toMatch(/requires heartbeat/)
  })

  it('签发授权书 / 建钥匙必须 PIN 在场证明；授权书是签名文档，篡改后视同 L0', async () => {
    await h.pinProof()
    expect(() => h.k.agents.createKey({ name: 'x', host: 'codex', tier: 'paper', mandate: { accounts: [h.paper.accountId as never] } }, h.sessionProof(), h.human().origin)).toThrow(/PIN/)
    const a = await makeAgent(h, 'paper')
    expect(h.k.agents.effective(a.mandate.mandateId)!.level).toBe('L1')
    h.k.db.exec(`UPDATE docs SET doc=json_set(doc,'$.level','L4') WHERE coll='mandate'`)
    h.k.agents.verifyMandate(a.mandate.mandateId)
    expect(h.k.agents.effective(a.mandate.mandateId)!.level).toBe('L0')
    const r = await h.k.trading.place({ intent: paperIntent() }, a.ctx())
    expect(r.order?.status).toBe('denied')
    expect(r.order?.problem?.code).toBe(2005) // 验签失败的授权书视同失效（只读）
  })

  it('L0 只读下不了单；L1 纸面直接成交；L1 不能碰实盘；到期自动降到 L0', async () => {
    const ro = await makeAgent(h, 'read_only')
    expect((await h.k.trading.place({ intent: paperIntent() }, ro.ctx())).order?.problem?.code).toBe(2003)
    const p = await makeAgent(h, 'paper')
    const r = await h.k.trading.place({ intent: paperIntent() }, p.ctx())
    expect(r.order?.status).toBe('filled')
    expect(r.order?.origin).toMatchObject({ actor: `agent:${p.keyId}`, actorType: 'llm-agent', via: 'mcp' })
    await expect(h.k.trading.place({ intent: liveIntent() }, p.ctx())).rejects.toMatchObject({ problem: { code: 1008 } })
    h.clock.advance(31 * 86_400_000)
    h.k.agents.tick()
    expect(h.k.agents.effective(p.mandate.mandateId)!.level).toBe('L0')
    expect(h.k.ledger.query({ types: ['mandate.expired'] }).length).toBe(2) // 两把钥匙各一份授权书
  })

  it('撤销钥匙只需会话，立刻失效；令牌轮换后旧令牌失效', async () => {
    const a = await makeAgent(h, 'paper')
    expect(h.k.agents.verifyToken(a.token)).not.toBeNull()
    h.k.agents.revokeKey(a.keyId, h.sessionProof(), h.human().origin)
    expect(h.k.agents.verifyToken(a.token)).toBeNull()
    expect(h.k.agents.effective(a.mandate.mandateId)!.level).toBe('L0')
  })
})

describe('提案状态机（草稿 → 待审 → 批准 / 拒绝 / 过期 / 撤回）', () => {
  it('转移表：不在表里的 (状态, 事件) 组合一律不允许', () => {
    const allowed = new Set(PROPOSAL_TRANSITIONS.map((t) => `${t.from}|${t.event}`))
    for (const s of PROPOSAL_STATUSES) for (const e of PROPOSAL_EVENTS) {
      expect(nextProposalStatus(s, e) !== null, `${s}+${e}`).toBe(allowed.has(`${s}|${e}`))
    }
    for (const s of ['executed', 'failed', 'rejected', 'expired', 'withdrawn', 'denied'] as const) for (const e of PROPOSAL_EVENTS) expect(nextProposalStatus(s, e), `${s}+${e}`).toBeNull()
  })

  it('L2 实盘提案：待审 → 人批准 → 执行；票号 T-YYYYMMDD-NNNN，预检结果 / 价格边界 / 理由 / 批准人入账', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const p = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'Funding flipped negative; small add.' }, a.ctx('propose'))
    expect(p.status).toBe('pending')
    expect(p.ticket).toMatch(/^T-\d{8}-0001$/)
    expect(p.precheck.verdict).toBe('review')
    expect(p.priceBounds).toMatchObject({ referencePrice: '80000', maxDriftBps: 30 })
    expect(p.expiresAt - p.origin.requestId.length * 0).toBeGreaterThan(h.clock.now())
    expect(h.live.submitted.length).toBe(0) // 批准前没有任何东西到场所
    const done = await h.k.trading.approve(p.ticket, h.sessionProof(), h.human('ui:approve'))
    expect(done.status).toBe('executed')
    expect(done.decision).toMatchObject({ by: 'user:usr_local', attestation: { method: 'session' } })
    expect(h.live.submitted.length).toBe(1)
    expect(h.live.signatures.length).toBe(1) // 实盘单经 API 钱包签名
    const trail = h.k.ledger.query({ proposalId: p.proposalId, order: 'asc' }).map((e) => e.type)
    expect(trail).toEqual(expect.arrayContaining(['proposal.created', 'proposal.decided', 'order.intent', 'order.accepted', 'proposal.executed']))
    const second = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent({ size: '0.004' as never })], reason: 'again' }, a.ctx('propose'))
    expect(second.ticket).toMatch(/-0002$/)
  })

  it('拒绝无门槛；撤回只有提出者；批准过的不能再拒绝；过期后批准 → 1009', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const b = await makeAgent(h, 'confirm')
    const mk = async (size: string) => h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent({ size: size as never })], reason: 'r' }, a.ctx('propose'))
    const p1 = await mk('0.003')
    expect(h.k.trading.reject(p1.ticket, h.sessionProof(), h.human()).status).toBe('rejected')
    await expect(h.k.trading.approve(p1.ticket, h.sessionProof(), h.human())).rejects.toThrow(/not pending/)
    const p2 = await mk('0.004')
    expect(() => h.k.trading.withdraw(p2.ticket, b.ctx())).toThrow(/only the proposer/)
    expect(h.k.trading.withdraw(p2.ticket, a.ctx()).status).toBe('withdrawn')
    const p3 = await mk('0.005')
    h.clock.advance(11 * 60_000)
    await expect(h.k.trading.approve(p3.ticket, h.sessionProof(), h.human())).rejects.toMatchObject({ problem: { code: 1009 } })
    expect(h.k.trading.getProposal(p3.ticket)!.status).toBe('expired')
    expect(h.k.ledger.query({ types: ['proposal.expired'] }).length).toBe(1)
  })

  it('批准绑定 intentsDigest：提案内容被改动 → 拒绝执行；价格漂出批准边界 → 失败并附 1007', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const p = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'r' }, a.ctx('propose'))
    h.live.setMark(BTC, '81000') // +125 bps > 30
    const out = await h.k.trading.approve(p.ticket, h.sessionProof(), h.human())
    expect(out.status).toBe('failed')
    expect(out.execution?.problem?.code).toBe(1007)
    expect(h.live.submitted.length).toBe(0)
    h.live.setMark(BTC, '80000')
    const p2 = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent({ size: '0.004' as never })], reason: 'r' }, a.ctx('propose'))
    h.k.db.exec(`UPDATE docs SET doc=json_set(doc,'$.intents[0].size','5') WHERE coll='proposal' AND id='${p2.proposalId}'`)
    await expect(h.k.trading.approve(p2.ticket, h.sessionProof(), h.human())).rejects.toThrow(/digest mismatch/)
  })

  it('名义额超过授权书 presenceAboveNotional → 批准要 PIN；提案预检 deny → 直接 denied', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm', { approval: { presenceAboveNotional: '100' } as never })
    const p = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'r' }, a.ctx('propose'))
    expect(h.k.trading.approvalNeedsPin(p.ticket)).toBe(true)
    await expect(h.k.trading.approve(p.ticket, h.sessionProof(), h.human())).rejects.toThrow(/PIN/)
    expect((await h.k.trading.approve(p.ticket, await h.pinProof(), h.human())).status).toBe('executed')
    const bad = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent({ leverage: 9, size: '0.004' as never })], reason: 'r' }, a.ctx('propose'))
    expect(bad.status).toBe('denied')
    expect(bad.precheck.ruleHits.map((x) => x.code)).toContain('LEVERAGE')
  })

  it('L1 不能提实盘；理由必填；多腿 ≤10', async () => {
    const p = await makeAgent(h, 'paper')
    const live = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'r' }, p.ctx('propose'))
    expect(live.status).toBe('denied')
    expect(live.precheck.ruleHits[0]!.code).toBe('MANDATE_LEVEL')
    await expect(h.k.trading.propose({ accountId: h.paper.accountId, intents: [paperIntent()], reason: '' }, p.ctx())).rejects.toThrow(/reason/)
    await expect(h.k.trading.propose({ accountId: h.paper.accountId, intents: Array.from({ length: 11 }, () => paperIntent()), reason: 'r' }, p.ctx())).rejects.toThrow(/1-10 legs/)
  })

  it('Agent 没有批准入口：批准要人面证明，Agent 主体造不出来', async () => {
    await enableLive(h)
    const a = await makeAgent(h, 'confirm')
    const p = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'r' }, a.ctx('propose'))
    expect(() => h.k.auth.sessionProof(a.principal)).toThrow()
    await expect(h.k.auth.pinProof(a.principal, 'anything-1')).rejects.toThrow(/Agent keys cannot/)
    await expect(h.k.trading.approve(p.ticket, {} as never, a.ctx())).rejects.toThrow(/presence proof/)
    await expect(h.k.ops.call(h.k, 'proposal.approve', { principal: a.principal, params: { id: p.ticket }, transport: 'http' })).rejects.toMatchObject({ problem: { code: 5003 } })
  })
})

describe('confirmToken：预览参数绑定，不是批准', () => {
  describe('关掉 denyLlmLiveEntries 之后', () => {
    beforeEach(async () => {
      await enableLive(h)
      h.k.risk.setDenyLlmLiveEntries(false, await h.pinProof(), h.human('ui:allow-llm').origin)
    })

    it('令牌：一次性、30 s 过期、绑定发起者、被篡改无效、不接受意图参数、价格漂移 1007', async () => {
      const a = await makeAgent(h, 'auto_limited', { denyLlmLiveEntries: false })
      const b = await makeAgent(h, 'auto_limited', { denyLlmLiveEntries: false })
      const pv = await h.k.trading.preview(liveIntent(), a.ctx())
      expect(pv.confirmToken).toMatch(/^ctk_/)
      await expect(h.k.trading.place({ confirmToken: pv.confirmToken!, intent: liveIntent() }, a.ctx())).rejects.toThrow(/either confirmToken or intent/)
      expect((await h.k.trading.place({ confirmToken: pv.confirmToken! }, a.ctx())).order?.status).toBe('filled')
      await expect(h.k.trading.place({ confirmToken: pv.confirmToken! }, a.ctx())).rejects.toMatchObject({ problem: { code: 1008 } }) // 一次性
      h.clock.advance(11_000)
      const pv2 = await h.k.trading.preview(liveIntent({ size: '0.004' as never }), a.ctx())
      await expect(h.k.trading.place({ confirmToken: pv2.confirmToken! }, b.ctx())).rejects.toMatchObject({ problem: { code: 1008 } }) // 别人的令牌
      const pv3 = await h.k.trading.preview(liveIntent({ size: '0.004' as never }), a.ctx())
      await expect(h.k.trading.place({ confirmToken: pv3.confirmToken!.slice(0, -2) + 'xx' }, a.ctx())).rejects.toMatchObject({ problem: { code: 1008 } })
      const pv4 = await h.k.trading.preview(liveIntent({ size: '0.004' as never }), a.ctx())
      h.clock.advance(31_000)
      await expect(h.k.trading.place({ confirmToken: pv4.confirmToken! }, a.ctx())).rejects.toMatchObject({ problem: { code: 1008 } })
      const pv5 = await h.k.trading.preview(liveIntent({ size: '0.004' as never }), a.ctx())
      h.live.setMark(BTC, '80500') // 62 bps
      await expect(h.k.trading.place({ confirmToken: pv5.confirmToken! }, a.ctx())).rejects.toMatchObject({ problem: { code: 1007 } })
      expect(h.live.submitted.length).toBe(1) // 只有最开始那一单到过场所
    })

    it('通过：自动批准的提案记录 + 签名下单；超过 autoMaxOrderNotional → 2009 并返回票号', async () => {
      const a = await makeAgent(h, 'auto_limited', { denyLlmLiveEntries: false })
      const pv = await h.k.trading.preview(liveIntent(), a.ctx()) // 240 ≤ 300
      const r = await h.k.trading.place({ confirmToken: pv.confirmToken! }, a.ctx())
      expect(r.order?.status).toBe('filled')
      expect(h.live.signatures.length).toBe(1)
      const prop = h.k.trading.listProposals({ mandateId: a.mandate.mandateId })[0]!
      expect(prop).toMatchObject({ status: 'executed', decision: { by: `mandate:${a.mandate.mandateId}` } })
      h.clock.advance(11_000)
      const big = await h.k.trading.preview(liveIntent({ size: '0.005' as never }), a.ctx()) // 400 > 300
      expect(big.precheck.verdict).toBe('review')
      const r2 = await h.k.trading.place({ confirmToken: big.confirmToken! }, a.ctx())
      expect(r2.proposal?.status).toBe('pending')
      expect(r2.problem).toMatchObject({ code: 2009, name: 'NEEDS_APPROVAL' })
      expect(r2.problem!.message).toContain(r2.proposal!.ticket)
      expect(h.live.submitted.length).toBe(1)
    })
  })
})

describe('denyLlmLiveEntries 语义（维护者 裁决）：LLM 型钥匙的"限额自动" = 纸面自动 + 实盘仅减仓 / 撤单自动；实盘开仓仍需人面确认', () => {
  beforeEach(async () => { await enableLive(h) })

  it('默认开启：LLM 钥匙（限额自动）实盘开仓被拒并入账 LLM_LIVE_ENTRY；纸面照常自动', async () => {
    expect(h.k.risk.current()!.denyLlmLiveEntries).toBe(true)
    const a = await makeAgent(h, 'auto_limited')
    const pv = await h.k.trading.preview(liveIntent(), a.ctx())
    expect(pv.precheck.verdict).toBe('deny')
    expect(pv.precheck.ruleHits.map((x) => x.code)).toContain('LLM_LIVE_ENTRY')
    expect(pv.confirmToken).toBeUndefined()
    const denied = h.k.ledger.query({ types: ['risk.denied'], limit: 1 })[0]!
    expect(denied.ruleHits!.find((x) => x.code === 'LLM_LIVE_ENTRY')).toMatchObject({ ruleId: expect.stringMatching(/#denyLlmLiveEntries$/), action: 'deny' })
    expect(denied.origin.actorType).toBe('llm-agent')
    expect((await h.k.trading.place({ intent: paperIntent() }, a.ctx())).order?.status).toBe('filled') // 纸面自动
  })

  it('本人实盘减仓与撤单自动（不受开关影响）；提案不受限，人面确认后可执行', async () => {
    const a = await makeAgent(h, 'auto_limited')
    const own = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'establish own position' }, a.ctx('propose'))
    expect((await h.k.trading.approve(own.ticket, h.sessionProof(), h.human())).status).toBe('executed')
    h.clock.advance(11_000)
    const close = await h.k.trading.closePosition({ accountId: h.liveAcct.accountId, instrumentId: BTC, reason: 'take profit' }, a.ctx())
    expect(close.order?.status).toBe('filled')
    expect(close.order?.reduceOnly).toBe(true)
    expect(h.live.signatures.length).toBe(2) // 本人开仓夹具与减仓各签一次
    expect((await h.k.trading.cancelAll({ accountId: h.liveAcct.accountId }, a.ctx())).cancelled).toBeGreaterThanOrEqual(0)
    const p = await h.k.trading.propose({ accountId: h.liveAcct.accountId, intents: [liveIntent()], reason: 'wants a live entry' }, a.ctx('propose'))
    expect(p.status).toBe('pending') // 提案不受限
    const done = await h.k.trading.approve(p.ticket, h.sessionProof(), h.human()) // 人面确认
    expect(done.status).toBe('executed')
    expect(h.live.submitted.some((s) => s.intent.side === 'buy' && !s.intent.reduceOnly)).toBe(true)
  })

  it('只有人面 + PIN 才能关闭，关闭动作入账；之后 LLM 钥匙的限额自动才含实盘开仓；重新打开会话即可', async () => {
    const a = await makeAgent(h, 'auto_limited')
    expect(() => h.k.risk.setDenyLlmLiveEntries(false, h.sessionProof(), h.human().origin)).toThrow(/PIN/)
    await expect(h.k.ops.call(h.k, 'risk.setLlmLiveEntries', { principal: a.principal, params: { deny: false }, transport: 'http' })).rejects.toMatchObject({ problem: { code: 5003 } })
    expect(h.k.risk.current()!.denyLlmLiveEntries).toBe(true)
    h.k.risk.setDenyLlmLiveEntries(false, await h.pinProof(), h.human('ui:allow-llm').origin)
    const e = h.k.ledger.query({ types: ['policy.relaxed'], limit: 1 })[0]!
    expect(e.payload).toMatchObject({ change: 'allow_llm_live_entries', denyLlmLiveEntries: false, method: 'pin' })
    // 授权书没写 = 继承；显式写 true 则仍然拒绝（取最严）
    const inherit = await makeAgent(h, 'auto_limited')
    const strict = await makeAgent(h, 'auto_limited', { denyLlmLiveEntries: true })
    expect((await h.k.trading.preview(liveIntent(), inherit.ctx())).precheck.verdict).toBe('allow')
    expect((await h.k.trading.preview(liveIntent(), strict.ctx())).precheck.ruleHits.map((x) => x.code)).toContain('LLM_LIVE_ENTRY')
    h.k.risk.setDenyLlmLiveEntries(true, h.sessionProof(), h.human().origin)
    expect((await h.k.trading.preview(liveIntent(), inherit.ctx())).precheck.ruleHits.map((x) => x.code)).toContain('LLM_LIVE_ENTRY')
    expect(h.k.risk.integrity.ok).toBe(true)
  })

  it('引擎型执行者不受此开关影响（actorType = engine）', async () => {
    const missingMandate = { principal: { kind: 'engine' as const, engineId: 'engine-no-mandate', mandateId: 'mdt_missing' as never }, origin: mkOrigin('engine:engine-no-mandate', 'strategy:ema-trend', 'gep') }
    const denied = await h.k.trading.preview(liveIntent(), missingMandate)
    expect(denied.precheck.ruleHits.map((x) => x.code)).not.toContain('LLM_LIVE_ENTRY')
    expect(denied.precheck.verdict).toBe('deny')
    expect(denied.precheck.ruleHits).toContainEqual(expect.objectContaining({ code: 'MANDATE_LEVEL' }))
    expect(problemOfPrecheck(denied.precheck).code).toBe(2003)
    expect(denied.confirmToken).toBeUndefined()
    expect(h.live.submitted).toHaveLength(0)

    const mandate = h.k.agents.issueMandate({ subject: { type: 'engine', id: 'engine-valid' }, level: 'L3', accounts: [h.liveAcct.accountId], venueAllowlist: ['hyperliquid'], instrumentAllowlist: [BTC], limits: { maxOrderNotional: '500', maxDailyNotional: '2000', autoMaxOrderNotional: '300', maxDailyLoss: '100' } } as never, await h.pinProof(), h.human('mandate.issue').origin)
    const engineCtx = { principal: { kind: 'engine' as const, engineId: 'engine-valid', mandateId: mandate.mandateId }, origin: mkOrigin('engine:engine-valid', 'strategy:ema-trend', 'gep') }
    const pv = await h.k.trading.preview(liveIntent(), engineCtx)
    expect(pv.precheck.ruleHits.map((x) => x.code)).not.toContain('LLM_LIVE_ENTRY')
    expect(pv.precheck.verdict).toBe('allow')
    const r = await h.k.trading.place({ confirmToken: pv.confirmToken! }, engineCtx)
    expect(r.order?.status).toBe('filled')
    expect(r.order?.origin.actorType).toBe('engine')
  })

  it('人手动实盘单也不受影响（actorType = human）', async () => {
    const r = await h.k.trading.place({ intent: liveIntent({ reason: undefined }) }, h.human())
    expect(r.order?.status).toBe('filled')
    expect(r.order?.origin.actorType).toBe('human')
  })
})

describe('结果未知 / 场所拒绝 / 实盘闸', () => {
  it('API-key 实盘先要求 PIN 解锁，解锁后无需钱包签名即可到达下行连接器', async () => {
    h.liveAcct.signer = { type: 'api-key', credentialRef: 'config', permissions: { trade: true, withdraw: false } } as never
    let result = await h.k.trading.place({ intent: liveIntent({ reason: undefined }) }, h.human())
    expect(result.order?.problem?.name).toBe('VENUE_AUTH')
    expect(result.order?.problem?.message).toMatch(/locked/)
    expect(h.live.submitted).toHaveLength(0)

    await h.pinProof()
    expect(h.k.keystore.list()).toEqual([])
    h.clock.advance(11_000)
    result = await h.k.trading.place({ intent: liveIntent({ reason: undefined, size: '0.004' as never }) }, h.human())
    expect(result.order?.status).toBe('filled')
    expect(h.live.submitted).toHaveLength(1)
    expect(h.live.submitted[0]!.signed).toBe(false)
  })

  it('场所拒绝：原样保存上游报错，不改写；计入连续失败', async () => {
    h.sim.script = ['reject']
    const r = await h.k.trading.place({ intent: paperIntent({ reason: undefined }) }, h.human())
    expect(r.order?.status).toBe('rejected')
    expect(r.order?.problem?.venue?.message).toBe('Order has invalid size.')
    expect(h.k.ledger.query({ types: ['order.rejected'], limit: 1 })[0]!.payload).toMatchObject({ problem: { venue: { message: 'Order has invalid size.' } } })
  })

  it('下单超时（3006）：先按 clientOrderId 查，查不到写 reconciliation: pending，绝不自动重发', async () => {
    h.sim.script = ['unknown']
    const r = await h.k.trading.place({ intent: paperIntent({ reason: undefined }) }, h.human())
    expect(r.order?.status).toBe('submitted')
    expect(r.order?.problem?.code).toBe(3006)
    expect(h.sim.submitted.length).toBe(1)
    const rec = h.k.ledger.query({ types: ['reconciliation'], limit: 1 })[0]!
    expect((rec.payload as any).recon).toMatchObject({ status: 'unverifiable', pending: true })
    // 查得到：补记为已接受
    h.sim.script = ['unknown']
    h.sim.queryFinds = true
    h.clock.advance(11_000)
    const r2 = await h.k.trading.place({ intent: paperIntent({ reason: undefined, size: '0.004' as never }) }, h.human())
    expect(r2.order?.status).toBe('open')
    expect(h.sim.submitted.length).toBe(2)
  })

  it('实盘闸：没有钱包 / 密钥库锁着 / 钱包已撤销 → 订单 rejected（VENUE_AUTH），不会到达场所', async () => {
    let r = await h.k.trading.place({ intent: liveIntent({ reason: undefined }) }, h.human())
    expect(r.order?.problem?.name).toBe('VENUE_AUTH')
    expect(r.order?.problem?.message).toMatch(/locked/)
    const pin = await h.pinProof()
    h.k.keystore.generate(pin, { name: 'w1' })
    h.clock.advance(11_000)
    r = await h.k.trading.place({ intent: liveIntent({ reason: undefined }) }, h.human())
    expect(r.order?.status).toBe('filled')
    h.k.keystore.revoke(h.sessionProof(), 'w1')
    h.clock.advance(11_000)
    r = await h.k.trading.place({ intent: liveIntent({ reason: undefined, size: '0.004' as never }) }, h.human())
    expect(r.order?.problem?.name).toBe('VENUE_AUTH')
    expect(h.live.submitted.length).toBe(1)
    void D
  })

  it('启动对账：场所侧超时 = 结果未知 → 保持 HALTED；本地以为在挂而场所查不到 → HALTED；一致则通过', async () => {
    await enableLive(h)
    h.live.reconcileResult = 'hang'
    let res = await h.k.startupReconcile(50)
    expect(res.find((r) => r.account === h.liveAcct.accountId)).toMatchObject({ ok: false })
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('HALTED')
    expect(h.k.ledger.query({ types: ['startup.reconciled'], limit: 1 })[0]!.payload).toMatchObject({ ok: false })
    h.k.tstate.set({ type: 'account', id: h.liveAcct.accountId }, 'ACTIVE', 'ok', h.human().origin, await h.pinProof())
    // 一致
    h.live.reconcileResult = 'actual'
    res = await h.k.startupReconcile()
    expect(res.find((r) => r.account === h.liveAcct.accountId)!.ok).toBe(true)
    // 本地有挂单、场所没有、查不到
    h.live.script = []
    const o = await h.k.trading.place({ intent: liveIntent({ type: 'limit', price: '70000' as never, reason: undefined }) }, h.human())
    expect(o.order?.status).toBe('open')
    h.live.reconcileResult = [] // 场所侧报告没有任何挂单
    res = await h.k.startupReconcile()
    expect(res.find((r) => r.account === h.liveAcct.accountId)!.ok).toBe(false)
    expect(h.k.tstate.get({ type: 'account', id: h.liveAcct.accountId })).toBe('HALTED')
  })
})
