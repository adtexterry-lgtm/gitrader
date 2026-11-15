// SPDX-License-Identifier: CPAL-1.0
// 人面命令与 PIN 流程（假内核 + 真客户端 + 真宿主桥，无 DOM）：块只调 bridge.command；需要在场证明时内核回 ATTESTATION_REQUIRED，
// 壳的 attestor（这里用桩）给出 PIN 后客户端带证明重发一次；用户取消 = 命令没有发生；错误原文原样给到用户；桥的清单 / 一方 / 人点击规则照常生效。
import { KernelClient, LinkHub, createHostBridge, type BlockBridge, type BlockManifest, type Attestor } from '@gitrader/blocks-sdk'
import { startFakeKernel, type FakeKernel } from '@gitrader/blocks-sdk/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PIN, scenario } from '../fixtures/scenarios'
import { installScenario, type Stage } from '../fixtures/install'
import { approveProposal, rejectProposal, reconnectVenue, resumeTrading, runCommand, setKeyTier, setLlmLiveGuard, takeover } from '../src/actions'
import { queryRetry } from '../src/hooks'
import { keyTiers } from '../src/model-activity'
import { agentActivityBlock, riskBlock, statusBarBlock, positionsBlock } from '../src/index'

let kernel: FakeKernel
let stage: Stage
let client: KernelClient
let asked: Array<{ action: string; params: unknown }> = []
let answer: () => Promise<{ method: 'pin'; pin: string } | null> = async () => ({ method: 'pin', pin: PIN })

const bridgeOf = (manifest: BlockManifest, o: { trusted?: boolean; active?: boolean } = {}): BlockBridge =>
  createHostBridge({ manifest, instanceId: 'bi_test', kernel: client, hub: new LinkHub({ A: {} }), trusted: o.trusted ?? true, isUserActive: () => o.active ?? true, schedule: (fn) => fn() })

const agentBridge = () => bridgeOf(agentActivityBlock.manifest)
const riskBridge = () => bridgeOf(riskBlock.manifest)
const calls = (action: string) => stage.calls.filter((c) => c.action === action)

beforeAll(async () => {
  kernel = await startFakeKernel()
  stage = installScenario(kernel, 'pending')
  const boot = await fetch(`${kernel.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: kernel.bootstrapToken }) }).then((r) => r.json() as Promise<{ sessionToken: string }>)
  const attestor: Attestor = async (req) => { asked.push({ action: req.action, params: req.params }); return answer() }
  client = new KernelClient({ url: kernel.wsUrl, getToken: () => boot.sessionToken, WebSocketCtor: (await import('ws')).WebSocket as never, reconnect: false })
  client.setAttestor(attestor)
  await client.connect()
})
afterAll(async () => { client.close(); await kernel.close() })
beforeEach(() => {
  stage.load('pending')
  stage.calls.length = 0
  asked = []
  answer = async () => ({ method: 'pin', pin: PIN })
})

describe('批准提案：走 PIN', () => {
  it('第一次不带证明 → 内核要在场证明 → 弹 PIN → 带证明重发 → 成功，提案离开待审', async () => {
    const p = stage.sc.proposals[0]!
    const r = await approveProposal(agentBridge(), p.proposalId)
    expect(r.ok).toBe(true)
    expect(asked).toEqual([{ action: 'proposal.approve', params: { id: p.proposalId } }])
    expect(calls('proposal.approve').map((c) => c.attested)).toEqual([false, true])
    expect(stage.sc.proposals.find((x) => x.proposalId === p.proposalId)!.status).toBe('approved')
  })

  it('PIN 不对：上游原文原样给用户，不改写，也不再重试', async () => {
    answer = async () => ({ method: 'pin', pin: '000000' })
    const r = await approveProposal(agentBridge(), stage.sc.proposals[0]!.proposalId)
    expect(r).toMatchObject({ ok: false, cancelled: false, message: 'PIN 不对', problem: 'AUTH_FAILED' })
    expect(calls('proposal.approve')).toHaveLength(2)
    expect(stage.sc.proposals[0]!.status).toBe('pending')
  })

  it('用户关掉 PIN 层 = 取消：命令没发生，界面不报错', async () => {
    answer = async () => null
    const r = await approveProposal(agentBridge(), stage.sc.proposals[0]!.proposalId)
    expect(r).toMatchObject({ ok: false, cancelled: true })
    expect(calls('proposal.approve')).toHaveLength(1)
    expect(stage.sc.proposals[0]!.status).toBe('pending')
  })

  it('拒绝提案无门槛：不弹 PIN', async () => {
    const r = await rejectProposal(agentBridge(), stage.sc.proposals[1]!.proposalId)
    expect(r.ok).toBe(true)
    expect(asked).toHaveLength(0)
    expect(calls('proposal.reject').map((c) => c.attested)).toEqual([false])
  })

  it('找不到的提案：内核的话原样带出', async () => {
    const r = await rejectProposal(agentBridge(), 'prop_nope')
    expect(r).toMatchObject({ ok: false, message: '没有这张提案：prop_nope' })
  })
})

describe('桥的规则对这些命令照常生效', () => {
  it('批准 / 拒绝只给一方签名块：第三方（trusted=false）被桥拒绝，命令根本没到内核', async () => {
    const r = await approveProposal(bridgeOf(agentActivityBlock.manifest, { trusted: false }), stage.sc.proposals[0]!.proposalId)
    expect(r).toMatchObject({ ok: false, problem: 'FIRST_PARTY_ONLY' })
    expect(stage.calls).toHaveLength(0)
  })
  it('有副作用的命令必须来自人的点击：没有用户激活就被桥拒绝', async () => {
    const r = await approveProposal(bridgeOf(agentActivityBlock.manifest, { active: false }), stage.sc.proposals[0]!.proposalId)
    expect(r).toMatchObject({ ok: false, problem: 'USER_ACTIVATION_REQUIRED' })
    expect(stage.calls).toHaveLength(0)
  })
  it('没在清单里声明的命令发不出去：持仓块发不了清单外的命令，状态条不能批准，待批块不能接管', async () => {
    expect(positionsBlock.manifest.actions ?? []).not.toContain('note.add')
    expect(await runCommand(bridgeOf(positionsBlock.manifest), 'note.add', {})).toMatchObject({ ok: false, problem: 'ACTION_NOT_DECLARED' })
    expect(await approveProposal(bridgeOf(statusBarBlock.manifest), 'prop_x')).toMatchObject({ ok: false, problem: 'ACTION_NOT_DECLARED' })
    expect(await takeover(agentBridge(), 'halt_new')).toMatchObject({ ok: false, problem: 'ACTION_NOT_DECLARED' })
    expect(stage.calls).toHaveLength(0)
  })
  it('块读不了没申请的权限：状态条没有 ledger.read，查账本被桥拒绝', async () => {
    await expect(bridgeOf(statusBarBlock.manifest).query('ledger.query', {})).rejects.toMatchObject({ code: 'QUERY_NOT_ALLOWED' })
  })
})

describe('接管三档 / 恢复 / 大模型保护', () => {
  it('停止新开仓与撤销挂单不要证明；全部平仓要 PIN；状态随之变化', async () => {
    expect((await takeover(riskBridge(), 'halt_new')).ok).toBe(true)
    expect(asked).toHaveLength(0)
    expect(stage.tradingState).toBe('REDUCING')
    stage.load('pending')
    expect((await takeover(riskBridge(), 'cancel_all')).ok).toBe(true)
    expect(asked).toHaveLength(0)
    const r = await takeover(riskBridge(), 'flatten_all')
    expect(r.ok).toBe(true)
    expect(asked.map((a) => a.action)).toEqual(['takeover.flatten_all'])
    expect(stage.tradingState).toBe('HALTED')
    expect(calls('takeover.flatten_all').map((c) => c.attested)).toEqual([false, true])
  })

  it('接管命令带原因与作用域（org），状态条的接管走同一条命令', async () => {
    await takeover(bridgeOf(statusBarBlock.manifest), 'halt_new')
    expect(calls('takeover.halt_new')[0]!.params).toEqual({ reason: '人在检阅面触发', scope: { type: 'org' } })
  })

  it('恢复交易：只有人，要 PIN；已停止 → 正常', async () => {
    stage.tradingState = 'HALTED'
    const r = await resumeTrading(riskBridge())
    expect(r.ok).toBe(true)
    expect(asked.map((a) => a.action)).toEqual(['trading_state.resume'])
    expect(stage.tradingState).toBe('ACTIVE')
  })

  it('恢复交易 PIN 取消：仍然是已停止', async () => {
    stage.tradingState = 'HALTED'
    answer = async () => null
    expect(await resumeTrading(riskBridge())).toMatchObject({ ok: false, cancelled: true })
    expect(stage.tradingState).toBe('HALTED')
  })

  it('大模型实盘开仓保护：打开（收紧）不要证明，关闭（放宽）要 PIN', async () => {
    expect((await setLlmLiveGuard(riskBridge(), true)).ok).toBe(true)
    expect(asked).toHaveLength(0)
    expect((await setLlmLiveGuard(riskBridge(), false)).ok).toBe(true)
    expect(asked.map((a) => a.action)).toEqual(['risk.setLlmLiveEntries'])
    expect(stage.sc.risk.denyLlmLiveEntries).toBe(false)
    answer = async () => null
    expect(await setLlmLiveGuard(riskBridge(), true)).toMatchObject({ ok: true })
  })

  it('大模型保护关闭被取消：保护仍是开', async () => {
    answer = async () => null
    expect(await setLlmLiveGuard(riskBridge(), false)).toMatchObject({ ok: false, cancelled: true })
    expect(stage.sc.risk.denyLlmLiveEntries).toBe(true)
  })

  it('重连场所：命令经桥发出，作用到指定场所', async () => {
    const r = await reconnectVenue(bridgeOf(statusBarBlock.manifest), 'hyperliquid')
    expect(r.ok).toBe(true)
  })
})

describe('改 Agent 权限档位：走 PIN，额度与白名单沿用原授权书', () => {
  const keys = () => keyTiers(stage.sc.keys, stage.sc.mandates)

  it('需确认 → 纸面：用 L1 重签，带 PIN，授权书版本 +1', async () => {
    const k = keys()[0]!
    const r = await setKeyTier(agentBridge(), k, 'paper')
    expect(r.ok).toBe(true)
    expect(asked.map((a) => a.action)).toEqual(['mandate.update'])
    const sent = calls('mandate.update').at(-1)!.params as { mandateId: string; input: Record<string, unknown> }
    expect(sent.mandateId).toBe(k.mandateId)
    expect(sent.input).toMatchObject({ level: 'L1', accounts: k.mandate!.accounts, limits: k.mandate!.limits, instrumentAllowlist: k.mandate!.instrumentAllowlist })
    expect(keyTiers(stage.sc.keys, stage.sc.mandates)[0]!.tier).toBe('paper')
    expect(keyTiers(stage.sc.keys, stage.sc.mandates)[0]!.mandate!.version).toBe(k.mandate!.version + 1)
  })

  it('升到限额自动：授权书缺心跳等必填项，内核的话原样显示（不替它翻译）', async () => {
    const r = await setKeyTier(agentBridge(), keys()[0]!, 'auto_limited')
    expect(r).toMatchObject({ ok: false, cancelled: false, message: 'L3 requires heartbeat' })
    expect(keyTiers(stage.sc.keys, stage.sc.mandates)[0]!.tier).toBe('confirm')
  })

  it('PIN 取消：档位不变；找不到授权书：明确说找不到', async () => {
    answer = async () => null
    expect(await setKeyTier(agentBridge(), keys()[0]!, 'read_only')).toMatchObject({ ok: false, cancelled: true })
    expect(keyTiers(stage.sc.keys, stage.sc.mandates)[0]!.tier).toBe('confirm')
    const orphan = keyTiers(scenario('pending').keys, [])[0]!
    expect(await setKeyTier(agentBridge(), orphan, 'paper')).toMatchObject({ ok: false, message: '找不到「Claude Code」的授权，无法改成纸面' })
  })
})

describe('查询：连接还没建好时退避重试，其他错误立刻抛出', () => {
  it('连接丢失重试到成功', async () => {
    let n = 0
    const b = { query: async () => { n += 1; if (n < 3) { const { KernelError } = await import('@gitrader/blocks-sdk'); throw new KernelError(-32001, '内核未连接') } return 'ok' } } as unknown as BlockBridge
    expect(await queryRetry(b, 'x')).toBe('ok')
    expect(n).toBe(3)
  })

  it('内核给的错误不重试，原样抛出', async () => {
    let n = 0
    const { KernelError } = await import('@gitrader/blocks-sdk')
    const b = { query: async () => { n += 1; throw new KernelError(-32603, '读不到', { name: 'INTERNAL' }) } } as unknown as BlockBridge
    await expect(queryRetry(b, 'x')).rejects.toMatchObject({ message: '读不到' })
    expect(n).toBe(1)
  })

  it('块卸载后（alive=false）不再重试', async () => {
    let n = 0
    const { KernelError } = await import('@gitrader/blocks-sdk')
    const b = { query: async () => { n += 1; throw new KernelError(-32001, '内核未连接') } } as unknown as BlockBridge
    await expect(queryRetry(b, 'x', undefined, () => false)).rejects.toMatchObject({ code: -32001 })
    expect(n).toBe(1)
  })

  it('读取失败场景：内核的错误文案原样到块', async () => {
    stage.load('error')
    await expect(riskBridge().query('risk.state')).rejects.toMatchObject({ message: expect.stringContaining('读不到这份数据') })
  })
})
