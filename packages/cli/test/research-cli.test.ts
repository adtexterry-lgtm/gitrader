// SPDX-License-Identifier: CPAL-1.0
// gitrader research …（第六轮 C 包）：参数 → 规格、默认等作业跑完、--json / --no-wait 的输出形状、退出码（0 / 1 / 2）。
// 内核用假的 liveService + callOp 代替；真实的端到端在 verify 的 R3-01-cli。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../src/index'
import type { Args, CliIo } from '../src/index'
import { buildFactorSpec, buildOptimizeSpec, cmdResearch, dataFromFile, parseSearch, parseSpace, parseTime, parseValidation } from '../src/research'

const parseArgv = (argv: string[]): Args => {
  const cmd: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t.startsWith('--')) { if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[t.slice(2)] = argv[++i]! ; else flags[t.slice(2)] = true } else cmd.push(t)
  }
  return { cmd, flags }
}
const io = (): CliIo & { out_: string[]; err_: string[] } => {
  const out_: string[] = []
  const err_: string[] = []
  return { out_, err_, out: (s) => { out_.push(s) }, err: (s) => { err_.push(s) }, env: {}, readSecret: async () => '', interactive: false }
}
const dirs: string[] = []
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gitrader-research-cli-')); dirs.push(d); return d }
const csv = (): string => {
  const f = join(tmp(), 'k.csv')
  writeFileSync(f, ['t,o,h,l,c,v', ...Array.from({ length: 40 }, (_, i) => `${1_700_000_000_000 + i * 3_600_000},1,2,0.5,1.5,10`)].join('\n'))
  return f
}
const SPACE = '{"fast":{"type":"integer","min":5,"max":15,"step":5}}'

describe('参数解析', () => {
  it('parseValidation / parseSearch / parseTime', () => {
    expect(parseValidation('holdout:300')).toEqual({ kind: 'holdout', holdoutBars: 300 })
    expect(parseValidation('wf:600:200')).toEqual({ kind: 'walk-forward', trainBars: 600, testBars: 200 })
    expect(parseValidation('wf:600:200:100')).toEqual({ kind: 'walk-forward', trainBars: 600, testBars: 200, step: 100 })
    expect(() => parseValidation('holdout')).toThrow()
    expect(() => parseValidation('wf:600')).toThrow()
    expect(parseSearch(undefined)).toEqual({ kind: 'grid' })
    expect(parseSearch('random:50')).toEqual({ kind: 'random', trials: 50 })
    expect(parseSearch('evolution')).toEqual({ kind: 'evolution' })
    expect(() => parseSearch('random:0')).toThrow()
    expect(parseTime('1700000000000', '--from')).toBe(1_700_000_000_000)
    expect(parseTime('2023-11-14T22:13:20.000Z', '--from')).toBe(1_700_000_000_000)
    expect(() => parseTime('yesterday', '--from')).toThrow()
  })
  it('--space 内联 JSON 或 @文件；--data 自己算 sha256 并给出文件首尾时间', () => {
    expect(parseSpace(SPACE)).toEqual({ fast: { type: 'integer', min: 5, max: 15, step: 5 } })
    const f = join(tmp(), 'space.json')
    writeFileSync(f, SPACE)
    expect(parseSpace(`@${f}`)).toEqual(parseSpace(SPACE))
    expect(() => parseSpace('not json')).toThrow()
    const d = dataFromFile(csv())
    expect(d.data).toMatchObject({ source: 'files', files: [{ format: 'csv', sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }] })
    expect(d.first).toBe(1_700_000_000_000)
    expect(d.last).toBe(1_700_000_000_000 + 39 * 3_600_000)
  })
  it('buildOptimizeSpec：默认值、--data 时 from/to 取文件首尾（to 多一根）、walk-forward 必须 wf:', () => {
    const f = csv()
    const spec = buildOptimizeSpec(parseArgv(['research', 'optimize', '--strategy', 'ema-cross', '--space', SPACE, '--validation', 'holdout:10', '--data', f]), 'optimize') as any // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(spec).toMatchObject({ subject: { strategy: { id: 'ema-cross', params: {} } }, instruments: ['hyperliquid:BTC'], interval: '1h', from: 1_700_000_000_000, to: 1_700_000_000_000 + 40 * 3_600_000, seed: 42, search: { kind: 'grid' }, validation: { kind: 'holdout', holdoutBars: 10 } })
    expect(spec.assumptions).toMatchObject({ fees: { taker: '0.0005' }, slippageBps: 3, fillModel: 'next-bar-open' })
    expect(spec.account).toMatchObject({ initialBalance: '10000', leverage: 1 })
    expect(() => buildOptimizeSpec(parseArgv(['research', 'walk-forward', '--strategy', 's', '--space', SPACE, '--validation', 'holdout:10', '--data', f]), 'walk-forward')).toThrow(/wf:/)
    expect(() => buildOptimizeSpec(parseArgv(['research', 'optimize', '--strategy', 's', '--space', SPACE, '--validation', 'holdout:10']), 'optimize')).toThrow(/--from and --to/)
    expect(() => buildOptimizeSpec(parseArgv(['research', 'optimize', '--strategy', 's']), 'optimize')).toThrow(/--space/)
    const fs = buildFactorSpec(parseArgv(['research', 'factors', '--instrument', 'hyperliquid:BTC', '--interval', '1h', '--from', '1', '--to', '2000000', '--horizon', '11', '--window', '60'])) as any // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(fs).toMatchObject({ instruments: ['hyperliquid:BTC'], interval: '1h', data: { source: 'host' }, horizon: 11, window: 60 })
  })
})

/** 假内核：记录每次 research.call；状态依次 queued → running → done。 */
function fakeKernel(opts: { failAt?: 'status' | 'result'; finalState?: string } = {}) {
  const calls: { action: string; args: any }[] = [] // eslint-disable-line @typescript-eslint/no-explicit-any
  let polls = 0
  const deps = {
    liveService: async () => ({ port: 1, pid: 1, token: 't', startedAt: 1, version: 'x', baseUrl: 'http://x' }),
    sleep: async () => undefined,
    callOp: async (_h: string, _s: unknown, name: string, access: string, params: Record<string, unknown>) => {
      expect(name).toBe('research.call')
      expect(access).toBe('write')
      const { action, ...args } = params
      calls.push({ action: action as string, args })
      switch (action) {
        case 'optimize': case 'walk_forward': case 'factor_report': return { jobId: 'rsh_1', kind: action, state: 'queued' }
        case 'status': polls++; return { jobId: 'rsh_1', state: polls < 2 ? 'running' : (opts.finalState ?? 'done'), progress: { done: polls, total: 3 } }
        case 'result': if (opts.failAt === 'result') throw Object.assign(new Error('research.call: boom (4003)'), {}); return args.part ? { items: [{ i: 1 }, { i: 2 }, { i: 3 }], total: 9, next: '3' } : { jobId: 'rsh_1', strategy: { id: 'ema-cross' }, instrumentId: 'x', interval: '1h', bars: 10, searchKind: 'grid', trialCount: 9, best: { params: { fast: 15 }, score: 1, sharpe: 1 }, overfit: { pbo: 0.8, dsr: 0.1, trials: 9 }, validation: { kind: 'holdout', folds: 0, oosScore: -0.1 }, tMethod: 'newey-west', counts: { trials: 9 } }
        case 'backtest_report': return { jobId: args.jobId, headline: 'h', metrics: { sharpe: 1 }, markdown: '# 报告\n\n正文', truncated: false, assumptions: {} }
        case 'portfolio': return { accountId: 'acct_1', ccy: 'USDC', valuation: { total: '1', positions: [] }, exposure: {}, concentration: {}, missing: [] }
        case 'search': return { items: [{ instrumentId: 'hyperliquid:BTC' }], total: 1 }
        case 'cancel': return { jobId: args.jobId, state: 'cancelled' }
        default: throw new Error(`unexpected ${String(action)}`)
      }
    },
  }
  return { calls, deps }
}
const run = async (argv: string[], k = fakeKernel()) => { const i = io(); const code = await cmdResearch('/h', parseArgv(argv), i, k.deps as never); return { code, out: i.out_.join(''), err: i.err_.join(''), calls: k.calls } }

describe('子命令与退出码', () => {
  const f = csv()
  const base = ['research', 'optimize', '--strategy', 'ema-cross', '--space', SPACE, '--validation', 'holdout:10', '--data', f]
  it('optimize --json：默认等作业跑完，stdout 只有一个 JSON（含 jobId）', async () => {
    const r = await run([...base, '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ jobId: 'rsh_1', trialCount: 9 })
    expect(r.calls.map((c) => c.action)).toEqual(['optimize', 'status', 'status', 'result'])
    expect(r.calls[0]!.args.spec.validation).toEqual({ kind: 'holdout', holdoutBars: 10 })
  })
  it('optimize --no-wait --json：只打印 {jobId, kind, state}，不轮询', async () => {
    const r = await run([...base, '--no-wait', '--json'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toEqual({ jobId: 'rsh_1', kind: 'optimize', state: 'queued' })
    expect(r.calls).toHaveLength(1)
  })
  it('不带 --json：人读摘要（最优参数、PBO / DSR、样本外分数）', async () => {
    const r = await run(base)
    expect(r.out).toMatch(/best params: \{"fast":15\}/)
    expect(r.out).toMatch(/PBO 0.8/)
    expect(r.out).toMatch(/gitrader research result rsh_1 --part/)
  })
  it('walk-forward 走 walk_forward 动作；factors 走 factor_report，--json 摘要里有 tMethod', async () => {
    expect((await run(['research', 'walk-forward', '--strategy', 's', '--space', SPACE, '--validation', 'wf:20:10', '--data', f, '--no-wait', '--json'])).calls[0]!.action).toBe('walk_forward')
    const r = await run(['research', 'factors', '--instrument', 'hyperliquid:BTC', '--interval', '1h', '--data', f, '--horizon', '11', '--window', '60', '--json'])
    expect(r.calls[0]).toMatchObject({ action: 'factor_report', args: { spec: { horizon: 11, window: 60 } } })
    expect(JSON.parse(r.out).tMethod).toBe('newey-west')
  })
  it('用法错误退出码 2、不连内核；作业失败 / 被取消退出码 1', async () => {
    const u = await run(['research', 'optimize', '--strategy', 'ema-cross'])
    expect(u.code).toBe(2)
    expect(u.calls).toHaveLength(0)
    expect((await run(['research', 'bogus'])).code).toBe(2)
    expect((await run(['research', 'status'])).code).toBe(2)
    expect((await run(['research'])).code).toBe(2)
    expect((await run([...base, '--json'], fakeKernel({ finalState: 'failed', failAt: 'result' }))).code).toBe(1)
    expect((await run([...base, '--json'], fakeKernel({ finalState: 'cancelled' }))).code).toBe(1)
  })
  it('服务没起：退出码 1 和提示', async () => {
    const i = io()
    const code = await cmdResearch('/h', parseArgv(['research', 'status', 'rsh_1']), i, { liveService: async () => null })
    expect(code).toBe(1)
    expect(i.err_.join('')).toMatch(/gitrader serve/)
  })
  it('report：--out 写文件（markdown），不带 --out 打到 stdout；--format json 写 JSON', async () => {
    const out = join(tmp(), 'r.md')
    const w = await run(['research', 'report', 'job_1', '--format', 'md', '--out', out])
    expect(w.code).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('# 报告\n\n正文\n')
    expect((await run(['research', 'report', 'job_1'])).out).toBe('# 报告\n\n正文\n')
    const jf = join(tmp(), 'r.json')
    await run(['research', 'report', 'job_1', '--format', 'json', '--out', jf])
    expect(JSON.parse(readFileSync(jf, 'utf8')).metrics.sharpe).toBe(1)
    expect((await run(['research', 'report'])).code).toBe(2)
  })
  it('portfolio / search / status / result / cancel', async () => {
    expect(JSON.parse((await run(['research', 'portfolio', '--account', 'acct_1', '--json'])).out).accountId).toBe('acct_1')
    expect((await run(['research', 'portfolio', '--account', 'acct_1'])).calls[0]).toEqual({ action: 'portfolio', args: { accountId: 'acct_1' } })
    expect((await run(['research', 'search', 'BTC', '--limit', '5', '--json'])).calls[0]).toEqual({ action: 'search', args: { query: 'BTC', limit: 5 } })
    expect(JSON.parse((await run(['research', 'status', 'rsh_1', '--json'])).out).state).toBe('running')
    const res = await run(['research', 'result', 'rsh_1', '--part', 'trials', '--limit', '3', '--cursor', '0', '--json'])
    expect(res.calls[0]).toEqual({ action: 'result', args: { jobId: 'rsh_1', part: 'trials', limit: 3, cursor: '0' } })
    expect(JSON.parse(res.out)).toMatchObject({ total: 9, next: '3' })
    expect(JSON.parse((await run(['research', 'cancel', 'rsh_1'])).out).state).toBe('cancelled')
  })
})

describe('help', () => {
  it('gitrader help 列出九条 research 子命令；research --help 只列 research 的行', async () => {
    const i = io()
    await main(['help'], i)
    const text = i.out_.join('')
    for (const sub of ['research optimize', 'research walk-forward', 'research factors', 'research report', 'research portfolio', 'research search', 'research status', 'research result', 'research cancel']) expect(text, sub).toContain(sub)
    const j = io()
    await main(['research', '--help'], j)
    expect(j.out_.join('')).toContain('research optimize')
    expect(j.out_.join('')).not.toContain('gitrader serve')
  })
})
