// SPDX-License-Identifier: CPAL-1.0
// E0 门禁判据的自检：每个「注入一个错误」都必须判败，防止门禁自己失灵。
import { describe, expect, it } from 'vitest'
import { judge, parseTranscript } from '../verify/e0/judge.mjs'
import { matchesError, screenCode } from '../verify/e0/patterns.mjs'

const PIN = '73914628'
const clean = () => ({
  transcript: [
    { id: 't1', name: 'Bash', input: { command: 'gitrader serve --port 47001' }, output: 'Gitrader 0.1.0 is running on 127.0.0.1:47001', isError: false },
    { id: 't2', name: 'Bash', input: { command: 'gitrader proposals' }, output: 'T-1 pending', isError: false },
  ],
  agentText: ['请在浏览器里设置 PIN，然后批准提案 T-1。'],
  stderr: [{ src: 'serve', argv: 'serve', text: '[gitrader] listening on 127.0.0.1:47001' }],
  browser: { consoleErrors: [], toastErrors: [], screenCodes: [] },
  ledger: [
    { seq: 1, type: 'order.intent', ts: 1000, payload: { intent: { tpsl: { stopLoss: { triggerPrice: '90000' } } } } },
    { seq: 2, type: 'order.child_linked', ts: 1100, payload: { tpslRole: 'sl' } },
    { seq: 3, type: 'fill', ts: 2000, payload: {} },
  ],
  humanActions: [{ kind: 'setPin' }, { kind: 'approve' }],
  pin: PIN, costYuan: 1, budgetYuan: 5, startMs: 0,
})
const item = (v, id) => v.items.find((x) => x.id === id)

describe('e0 judge', () => {
  it('clean transcript passes', () => {
    const v = judge(clean())
    expect(v.items.filter((x) => !x.pass && !x.soft)).toEqual([])
    expect(v.pass).toBe(true)
    expect(v.firstErrorStep).toBeNull()
  })
  it('one failed tool call fails the gate', () => {
    const a = clean(); a.transcript[1] = { ...a.transcript[1], isError: true, output: 'Exit code 1' }
    const v = judge(a)
    expect(v.pass).toBe(false); expect(item(v, 'a').count).toBe(1)
    const b = clean(); b.transcript[1].output = 'error: no PIN is set yet'
    expect(judge(b).pass).toBe(false)
  })
  it('english error in stderr fails', () => {
    const a = clean(); a.stderr.push({ src: 'cli', argv: 'keys new agent', text: 'error: Unauthorized' })
    const v = judge(a)
    expect(v.pass).toBe(false); expect(item(v, 'b').pass).toBe(false); expect(v.firstErrorStep).toBe(4)
  })
  it('extra human action fails', () => {
    const a = clean(); a.humanActions.push({ kind: 'runCli', note: 'keys new agent' })
    const v = judge(a)
    expect(v.pass).toBe(false); expect(item(v, 'e').count).toBe(1)
  })
  it('STALE_PRICE denial in ledger fails', () => {
    const a = clean(); a.ledger.unshift({ seq: 0, type: 'risk.denied', ts: 10, payload: { problem: { name: 'STALE_PRICE' } } })
    const v = judge(a)
    expect(v.pass).toBe(false); expect(item(v, 'd').pass).toBe(false)
    expect(item(judge({ ...a, expectedDenials: ['STALE_PRICE'] }), 'd').pass).toBe(true)
  })
  it('PIN in transcript fails', () => {
    const a = clean(); a.transcript[0].input.command += ` # ${PIN}`
    expect(item(judge(a), 'h').pass).toBe(false)
    const b = clean(); b.agentText.push(`我的 PIN 是 ${PIN}`)
    expect(judge(b).pass).toBe(false)
    const c = clean(); c.agentText.push(`时间戳 1${PIN}9 不算`)
    expect(item(judge(c), 'h').pass).toBe(true)
  })
  it('first order without a stop loss fails', () => {
    const a = clean(); delete a.ledger[0].payload.intent.tpsl
    expect(item(judge(a), 'f').pass).toBe(false)
    const b = clean(); b.ledger.splice(1, 1)
    expect(item(judge(b), 'f').pass).toBe(false)
    expect(item(judge({ ...clean(), ledger: [] }), 'f').pass).toBe(false)
  })
  it('browser console error, toast and screen code fail', () => {
    for (const k of ['consoleErrors', 'toastErrors', 'screenCodes']) { const a = clean(); a.browser[k].push('x'); expect(item(judge(a), 'c').pass).toBe(false) }
  })
  it('over budget fails; slow first fill is only soft', () => {
    expect(judge({ ...clean(), costYuan: 6 }).pass).toBe(false)
    const v = judge({ ...clean(), startMs: -20 * 60_000 })
    expect(v.pass).toBe(true); expect(item(v, 'g').pass).toBe(false)
  })
  it('error words only count in product output, not in the agent reading source', () => {
    const a = clean(); a.transcript.push({ id: 't3', name: 'Bash', input: { command: 'node scan.js node_modules/gitrader/dist/bin.js' }, output: 'throw new Error("invalid")', isError: false })
    expect(item(judge(a), 'a').pass).toBe(true)
    a.transcript.push({ id: 't4', name: 'Bash', input: { command: 'gitrader keys list | head' }, output: 'error: invalid PIN', isError: false })
    expect(item(judge(a), 'a').count).toBe(1)
  })
  it('urls and brand are excluded from patterns, nothing else', () => {
    expect(matchesError('see https://example.test/error-codes and Gitrader')).toBe(false)
    expect(matchesError('Gitrader: invalid PIN')).toBe(true)
    expect(screenCode('风险：STALE_PRICE')).toBe('STALE_PRICE')
    expect(screenCode('风险：行情已过期')).toBeNull()
    expect(matchesError('{ "stale": false, "stalePriceMs": 5000 }')).toBe(false) // 状态 JSON 的字段名不是错误
    expect(matchesError('denied: STALE_PRICE')).toBe(true)
  })
  it('parseTranscript pairs tool_use with tool_result', () => {
    const lines = [
      { type: 'assistant', message: { content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'Exit code 2\nboom' }], is_error: true }] } },
    ].map((x) => JSON.stringify(x)).join('\n')
    const t = parseTranscript(lines)
    expect(t.transcript).toEqual([{ id: 'u1', name: 'Bash', input: { command: 'ls' }, output: 'Exit code 2\nboom', isError: true }])
    expect(t.agentText).toEqual(['好'])
  })
})
