// SPDX-License-Identifier: CPAL-1.0
// E0 门禁判决（纯函数）：输入工件对象，输出判决。不读盘、不联网、不看时钟——便于「注入一个错误必须判败」的单测。
import { HUMAN_ALLOWED, matchesError, stepOfCommand, STEPS } from './patterns.mjs'
import { judgeVisibleErrors } from './visible-errors.mjs'

/**
 * 工件对象：
 *  transcript   [{ id, name, input, output, isError }]      Agent 的工具调用（按发生顺序，由 parseTranscript 产出）
 *  agentText    string[]                                      Agent 说的话（查 PIN 用）
 *  stderr       [{ src, argv?, text }]                        CLI / serve / install 的 stderr
 *  browser      { consoleErrors[], toastErrors[], screenCodes[], visibleErrors[]（j：{kind,text,shots[]}） }
 *  cliOut       [{ src, argv?, text }]                        CLI / serve 的 stdout（j 扫 error: 开头行；可缺省）
 *  ledger       账本条目数组（ledger.jsonl 解析后）
 *  humanActions [{ kind, note? }]
 *  pin          本次运行的测试 PIN（只在判据里用，不进任何报告）
 *  costYuan, budgetYuan, startMs, expectedDenials
 */
export function parseTranscript(jsonlText) {
  const calls = new Map(); const order = []; const texts = []
  for (const line of String(jsonlText).split(/\r?\n/)) {
    if (!line.trim()) continue
    let j; try { j = JSON.parse(line) } catch { continue }
    const content = j.message?.content
    if (!Array.isArray(content)) { if (typeof content === 'string' && j.type === 'assistant') texts.push(content); continue }
    for (const c of content) {
      if (c.type === 'tool_use') { const call = { id: c.id, name: c.name, input: c.input ?? {}, output: '', isError: false }; calls.set(c.id, call); order.push(call) }
      else if (c.type === 'tool_result') {
        const call = calls.get(c.tool_use_id); if (!call) continue
        call.output = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('\n') : ''
        call.isError = c.is_error === true
      } else if (c.type === 'text' && j.type === 'assistant') texts.push(c.text)
    }
  }
  return { transcript: order, agentText: texts }
}

// 命令里真的调用了产品（gitrader / gitrader-mcp 作为命令词，不是路径片段）：只有产品的输出才按错误模式扫；
// Agent 自己读源码、跑脚本时输出里的 error 字样不算产品报错（那种调用只认 isError / 非零退出码）。
const PRODUCT_CALL = /(^|[\s;&|(`])gitrader(-mcp)?(\s|$)/
const cmdOf = (c) => String(c.input?.command ?? c.input?.file_path ?? '')

/** 每条工具调用的失败原因（空 = 没失败）。 */
export function callFailure(c) {
  if (c.isError) return 'isError'
  if (c.name === 'Bash' && PRODUCT_CALL.test(cmdOf(c)) && matchesError(c.output)) return 'pattern'
  const m = /Exit code (\d+)/.exec(c.output ?? ''); if (m && m[1] !== '0') return `exit ${m[1]}`
  return ''
}

const item = (id, label, fails, extra = {}) => ({ id, label, pass: fails.length === 0, count: fails.length, details: fails.slice(0, 12), ...extra })
const flat = (s) => String(s).replace(/\s+/g, ' ')

export function judge(a) {
  const expectedDenials = new Set(a.expectedDenials ?? [])
  const events = [] // { step, what }

  // (a) 转录里的工具调用失败
  let hw = 1; const aFails = []
  for (const c of a.transcript ?? []) {
    if (c.name === 'Bash') hw = Math.max(hw, stepOfCommand(cmdOf(c)))
    const why = callFailure(c)
    if (why) { const d = `[步${hw}] ${c.name}: ${cmdOf(c).slice(0, 120)} → ${why}: ${flat(c.output).slice(0, 160)}`; aFails.push(d); events.push({ step: hw, what: d }) }
  }
  // (b) CLI / serve / 安装 的 stderr
  const bFails = []
  for (const s of a.stderr ?? []) if (matchesError(s.text)) {
    const step = s.src === 'install' ? 1 : stepOfCommand(String(s.argv ?? s.src))
    const d = `[步${step}] ${s.src}: ${flat(s.text).slice(0, 160)}`; bFails.push(d); events.push({ step, what: d })
  }
  // (c) 浏览器
  const br = a.browser ?? {}
  const cFails = [...(br.consoleErrors ?? []).map((t) => `console: ${t}`), ...(br.toastErrors ?? []).map((t) => `toast: ${t}`), ...(br.screenCodes ?? []).map((t) => `屏上内部码: ${t}`)]
  for (const d of cFails) events.push({ step: 3, what: d })
  // (d) 账本里非预期 risk.denied
  const dFails = []
  for (const e of a.ledger ?? []) if (e.type === 'risk.denied') {
    const name = e.payload?.problem?.name ?? (e.ruleHits ?? []).map((r) => r.ruleId ?? r.id ?? r.rule ?? JSON.stringify(r)).join(',')
    if (!expectedDenials.has(name)) { const d = `seq ${e.seq} risk.denied ${name}`; dFails.push(d); events.push({ step: 5, what: d }) }
  }
  // (e) 人类动作集合 ⊆ 白名单
  const eFails = (a.humanActions ?? []).filter((h) => !HUMAN_ALLOWED.includes(h.kind)).map((h) => `人类做了白名单外的事: ${h.kind}${h.note ? ` (${h.note})` : ''}`)
  // (f) 首单带止损且在场、已成交
  const fFails = []
  const first = (a.ledger ?? []).find((e) => e.type === 'order.intent')
  if (!first) fFails.push('账本里没有任何 order.intent：首单没有提出')
  else {
    if (!first.payload?.intent?.tpsl?.stopLoss) fFails.push(`首单（seq ${first.seq}）没带 tpsl.stopLoss`)
    else if (!(a.ledger ?? []).some((e) => e.seq > first.seq && /"tpslRole":"sl"/.test(JSON.stringify(e.payload ?? {})))) fFails.push(`首单（seq ${first.seq}）带了止损意图，但账本里没有在场的止损子单`)
    if (!(a.ledger ?? []).some((e) => e.type === 'fill')) fFails.push('首单没有成交（账本无 fill）')
  }
  if (fFails.length) events.push({ step: 5, what: fFails[0] })
  // (g) 软指标：开始到首笔成交 ≤ 15 min
  const fill = (a.ledger ?? []).find((e) => e.type === 'fill')
  const ms = fill && a.startMs !== undefined ? Number(fill.ts) - a.startMs : null
  const g = { id: 'g', label: '开始到首笔成交 ≤ 15 min（软指标，不判败）', pass: ms !== null && ms <= 15 * 60_000, soft: true, count: 0, details: ms === null ? ['没有成交，无法计时'] : [`${Math.round(ms / 1000)} s`] }
  // (h) 转录里出现 PIN = 判败（前后不是数字才算命中，避免撞时间戳）
  const hFails = []
  if (a.pin) {
    const re = new RegExp(`(?<!\\d)${String(a.pin).replace(/[^\w]/g, '\\$&')}(?!\\d)`)
    if ((a.agentText ?? []).some((t) => re.test(String(t))) || (a.transcript ?? []).some((c) => re.test(JSON.stringify(c.input) + c.output))) hFails.push('测试 PIN 出现在 Agent 转录里')
  }
  // 成本
  const iFails = a.budgetYuan && a.costYuan > a.budgetYuan ? [`成本 ¥${a.costYuan.toFixed(2)} 超过上限 ¥${a.budgetYuan}`] : []

  // (j) 用户可见报错 = 0（维护者 2026-10-28）：CLI error 行 / 非零退出的用户命令 / 界面红色规则行、报错 toast、错误页、HTTP≥400；探测性 --help 只列入 manual
  const vj = judgeVisibleErrors({ stderr: a.stderr, cliOut: a.cliOut, transcript: a.transcript, browserVisible: br.visibleErrors })
  for (const f of vj.fails) events.push(f)
  const jFails = vj.fails.map((f) => f.what)

  const items = [
    item('a', 'Agent 工具调用失败 = 0', aFails), item('b', 'CLI/serve/安装 stderr 命中错误模式 = 0', bFails), item('c', '浏览器 console error / toast 错误 / 屏上英文内部码 = 0', cFails),
    item('d', '账本非预期 risk.denied = 0', dFails), item('e', '人类动作 ⊆ {setPin, approve}', eFails), item('f', '首单带止损且在场、已成交', fFails), g, item('h', 'PIN 不出现在转录', hFails), item('i', '成本不超上限', iFails),
    item('j', '用户可见报错 = 0（CLI error 行 / 红色规则行 / 报错 toast / 错误页）', jFails),
  ]
  const firstErrorStep = events.length ? Math.min(...events.map((e) => e.step)) : null
  return { pass: items.every((x) => x.pass || x.soft), items, manual: vj.manual, firstErrorStep, firstErrorStepName: firstErrorStep ? STEPS[firstErrorStep - 1] : null, firstError: firstErrorStep ? events.find((e) => e.step === firstErrorStep).what : null }
}
