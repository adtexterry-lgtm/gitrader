// SPDX-License-Identifier: CPAL-1.0
// 文件夹即安装：把一个策略文件（TS / JS，ESM）校验成可用的策略。校验失败给出「写给 Agent 看」的可读错误：
// 哪条规则、哪里不对、怎么改。校验分两层：
//   1. 结构与静态规则（字段、参数定义、不许碰 IO / 环境 / 运行时 import），在主线程做；
//   2. 动态规则（在工作线程里真的跑一遍，带超时，死循环也拖不垮引擎）：形状、取值范围、确定性、不改入参、
//      空 / 短序列不抛错、极端参数不抛错、前视偏差（用截断后的 K 线重算，已有信号不得改变）。
// 策略文件在引擎进程里运行，引擎不持有任何密钥（模式 A），但策略仍是「用户自己的代码」：这里的静态规则是写给 Agent 的护栏，
// 不是沙箱——不要把来路不明的文件丢进策略文件夹。
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { basename, extname, join } from 'node:path'
import * as nodeModule from 'node:module'
import { Worker } from 'node:worker_threads'

// Node >= 22.13 才有；老版本给出可读错误而不是链接期崩溃
const stripTypeScriptTypes = (nodeModule as unknown as { stripTypeScriptTypes?: (code: string, o: { mode: 'strip' }) => string }).stripTypeScriptTypes
import type { Candle } from '../types'
import type { Sha256Digest } from '../proto'
import { sha256Digest } from '../util/hash'
import { synthCandles } from '../util/synth'
import { defaultsOf } from './schema'
import type { ParamDef, Params, SignalSeries, StrategyDef } from './types'
import type { StrategyRegistry } from './registry'

export interface LoadIssue { rule: string; message: string; hint?: string }
export interface FileReport {
  file: string
  status: 'loaded' | 'error' | 'removed'
  id?: string
  version?: string
  errors: LoadIssue[]
  warnings: LoadIssue[]
  at: number
}

export const STRATEGY_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'] as const
const MAX_SOURCE_BYTES = 512 * 1024
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
const KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/
const SEMVER_RE = /^\d+\.\d+\.\d+$/
/** 与协议 S1 一致：策略参数里不许出现这些名字（它们会被引擎当作秘密字段拒收）。`size` 是引擎的通用实例参数，策略不能占用。 */
const RESERVED_KEYS = new Set(['privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase', 'size'])
const VALIDATION_BARS = 600
const CALL_BUDGET_MS = 2000
const WORKER_BUDGET_MS = 15_000

/** Node 把 stripTypeScriptTypes 标成实验性并往 stderr 打警告；这里是有意使用，压掉这一条。 */
function quietly<T>(fn: () => T): T {
  const orig = process.emitWarning
  process.emitWarning = ((w: string | Error, ...a: unknown[]) => (String(w).includes('stripTypeScriptTypes') ? undefined : (orig as (...x: unknown[]) => void).call(process, w, ...a))) as typeof process.emitWarning
  try { return fn() } finally { process.emitWarning = orig }
}

const issue = (rule: string, message: string, hint?: string): LoadIssue => ({ rule, message, ...(hint ? { hint } : {}) })

// ───────────── 静态规则 ─────────────

/** 去掉注释和字符串里的内容后再扫，避免注释里写了 "fetch" 就报错。 */
function codeOnly(js: string): string {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, '""')
}

const FORBIDDEN: { re: RegExp; what: string }[] = [
  { re: /^\s*import\s/m, what: 'runtime `import` statements (use `import type` only; copy any helper functions into the file)' },
  { re: /\bimport\s*\(/, what: 'dynamic import()' },
  { re: /\brequire\s*\(/, what: 'require()' },
  { re: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/, what: 'network access' },
  { re: /\bprocess\s*\./, what: 'process / environment access' },
  { re: /\b(?:child_process|node:fs|node:net|node:http|node:https|node:os|node:vm|worker_threads)\b/, what: 'node built-in modules' },
  { re: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/, what: 'eval / Function constructor' },
  { re: /\bglobalThis\s*\./, what: 'globalThis access' },
  { re: /\bMath\.random\s*\(/, what: 'Math.random() (strategies must be deterministic)' },
  { re: /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/, what: 'the wall clock (use candle timestamps)' },
]

function staticChecks(js: string): LoadIssue[] {
  const out: LoadIssue[] = []
  const code = codeOnly(js)
  for (const f of FORBIDDEN) {
    if (f.re.test(code)) out.push(issue('no-io', `the file uses ${f.what}`, 'A strategy is a pure function of (candles, params). Remove it; if you need a value, derive it from the candles or add a parameter.'))
  }
  return out
}

// ───────────── 结构校验（来自工作线程的元数据）─────────────

interface Meta {
  keys: string[]
  id: unknown; name: unknown; nameZh: unknown; version: unknown; desc: unknown; tags: unknown; params: unknown
  hasAnchor: boolean; hasEvaluate: boolean
}

function structureChecks(m: Meta): LoadIssue[] {
  const out: LoadIssue[] = []
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) out.push(issue('id', `id must be a string matching ${ID_RE.source} (lowercase letters, digits and dashes, 2–40 chars)`, "Example: id: 'my-first-strategy'"))
  if (typeof m.name !== 'string' || m.name.trim() === '' || m.name.length > 80) out.push(issue('name', 'name must be a non-empty string of at most 80 characters (English display name)'))
  if (m.nameZh !== undefined && (typeof m.nameZh !== 'string' || m.nameZh.length > 80)) out.push(issue('nameZh', 'nameZh, when present, must be a string of at most 80 characters'))
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) out.push(issue('version', 'version must be a semantic version string like "0.1.0"', 'Bump it whenever the logic changes: backtests record it.'))
  if (typeof m.desc !== 'string' || m.desc.trim() === '' || m.desc.length > 2000) out.push(issue('desc', 'desc must be a non-empty string of at most 2000 characters: say in plain words what the rule does and when it fails'))
  if (!Array.isArray(m.tags) || !m.tags.every((t) => typeof t === 'string')) out.push(issue('tags', 'tags must be an array of strings (may be empty)'))
  if (!m.hasEvaluate) out.push(issue('evaluate', 'evaluate(candles, params) is missing or not a function', 'It must return { target, reasons, overlays, warmup }; see strategy-template/strategy.ts.'))
  if (!Array.isArray(m.params)) out.push(issue('params', 'params must be an array of parameter definitions'))
  else out.push(...paramChecks(m.params as unknown[]))
  const unknown = m.keys.filter((k) => !['id', 'name', 'nameZh', 'version', 'desc', 'tags', 'params', 'anchor', 'evaluate', 'defaults'].includes(k))
  if (unknown.length) out.push(issue('unknown-field', `unknown fields on the strategy object: ${unknown.join(', ')}`, 'Remove them, or check the spelling (allowed: id, name, nameZh, version, desc, tags, params, anchor, evaluate).'))
  return out
}

function paramChecks(params: unknown[]): LoadIssue[] {
  const out: LoadIssue[] = []
  const seen = new Set<string>()
  if (params.length > 40) out.push(issue('params', 'at most 40 parameters'))
  params.forEach((raw, i) => {
    const p = raw as Partial<ParamDef> | null
    const where = `params[${i}]${p && typeof p === 'object' && typeof p.key === 'string' ? ` ("${p.key}")` : ''}`
    if (!p || typeof p !== 'object') { out.push(issue('param', `${where} must be an object`)); return }
    if (typeof p.key !== 'string' || !KEY_RE.test(p.key)) { out.push(issue('param-key', `${where}.key must match ${KEY_RE.source} (camelCase, starts with a letter)`)); return }
    if (seen.has(p.key)) out.push(issue('param-key', `${where}: duplicate parameter key`))
    seen.add(p.key)
    if (RESERVED_KEYS.has(p.key.toLowerCase())) out.push(issue('param-key', `${where}: "${p.key}" is reserved`, p.key.toLowerCase() === 'size' ? '"size" is the engine-wide per-order size cap every instance accepts; pick another name.' : 'Names that look like secrets are rejected by the protocol.'))
    if (typeof p.label !== 'string' || p.label === '') out.push(issue('param-label', `${where}.label must be a non-empty string`))
    if (!['number', 'integer', 'boolean', 'select'].includes(p.type as string)) { out.push(issue('param-type', `${where}.type must be number, integer, boolean or select`)); return }
    if (p.type === 'boolean' && typeof p.default !== 'boolean') out.push(issue('param-default', `${where}.default must be a boolean`))
    if (p.type === 'select') {
      if (!Array.isArray(p.options) || p.options.length === 0 || !p.options.every((o) => typeof o === 'string')) out.push(issue('param-options', `${where}.options must be a non-empty array of strings`))
      else if (!p.options.includes(p.default as string)) out.push(issue('param-default', `${where}.default must be one of options`))
    }
    if (p.type === 'number' || p.type === 'integer') {
      if (typeof p.default !== 'number' || !Number.isFinite(p.default)) out.push(issue('param-default', `${where}.default must be a finite number`))
      else {
        if (p.type === 'integer' && !Number.isInteger(p.default)) out.push(issue('param-default', `${where}.default must be an integer`))
        if (p.min !== undefined && p.default < p.min) out.push(issue('param-range', `${where}.default is below min`))
        if (p.max !== undefined && p.default > p.max) out.push(issue('param-range', `${where}.default is above max`))
      }
      if (p.min !== undefined && p.max !== undefined && p.min > p.max) out.push(issue('param-range', `${where}: min is greater than max`))
    }
  })
  return out
}

// ───────────── 工作线程：把策略真的跑起来 ─────────────

interface CallSpec { id: string; fn: 'evaluate' | 'anchor'; len?: number; params: Params; frozen?: boolean; lastN?: number }
interface CallResult { id: string; ok: boolean; value?: unknown; error?: string; ms: number }

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const deepFreeze = (cs) => { for (const c of cs) Object.freeze(c); return Object.freeze(cs) }
;(async () => {
  let mod
  try {
    const url = 'data:text/javascript;base64,' + Buffer.from(workerData.code, 'utf8').toString('base64')
    mod = await import(url)
  } catch (e) {
    parentPort.postMessage({ type: 'fatal', error: String((e && e.message) || e), stack: String((e && e.stack) || '').split('\\n').slice(0, 4).join('\\n') })
    return
  }
  const def = mod.default !== undefined ? mod.default : mod.strategy
  if (!def || typeof def !== 'object') { parentPort.postMessage({ type: 'fatal', error: 'the file must export the strategy object as the default export (export default strategy)' }); return }
  const snap = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch { return undefined } }
  parentPort.postMessage({ type: 'meta', meta: {
    keys: Object.keys(def), id: snap(def.id), name: snap(def.name), nameZh: snap(def.nameZh), version: snap(def.version), desc: snap(def.desc), tags: snap(def.tags), params: snap(def.params),
    hasAnchor: typeof def.anchor === 'function', hasEvaluate: typeof def.evaluate === 'function' } })
  parentPort.once('message', (msg) => {
    const results = []
    for (const c of msg.calls) {
      const t0 = Date.now()
      try {
        let candles = c.len === undefined ? workerData.fixture : workerData.fixture.slice(0, c.len)
        if (c.lastN !== undefined) candles = candles.slice(-c.lastN)
        if (c.fn === 'evaluate' && c.len === 0) candles = []
        candles = candles.map((x) => ({ ...x }))
        if (c.frozen) deepFreeze(candles)
        const value = c.fn === 'anchor' ? def.anchor(candles, c.params) : def.evaluate(candles, c.params)
        results.push({ id: c.id, ok: true, value: snap(value), ms: Date.now() - t0 })
      } catch (e) {
        results.push({ id: c.id, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 })
      }
    }
    parentPort.postMessage({ type: 'results', results })
  })
})()
`

/** 在工作线程里加载并（分两步）运行策略。超时则终止线程。 */
async function runInWorker(code: string, fixture: Candle[], plan: (meta: Meta) => CallSpec[], budgetMs: number): Promise<{ meta?: Meta; results?: CallResult[]; fatal?: { error: string; stack?: string }; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { code, fixture } })
    let meta: Meta | undefined
    const done = (r: Awaited<ReturnType<typeof runInWorker>>): void => { clearTimeout(timer); void w.terminate(); resolve(r) }
    const timer = setTimeout(() => done({ ...(meta ? { meta } : {}), timedOut: true }), budgetMs)
    w.on('message', (m: { type: string; meta?: Meta; results?: CallResult[]; error?: string; stack?: string }) => {
      if (m.type === 'fatal') done({ fatal: { error: m.error ?? 'failed to load', ...(m.stack ? { stack: m.stack } : {}) } })
      else if (m.type === 'meta') {
        meta = m.meta!
        const structural = structureChecks(meta)
        if (structural.length > 0 || !meta.hasEvaluate) { done({ meta }); return }
        w.postMessage({ calls: plan(meta) })
      } else if (m.type === 'results') done({ ...(meta ? { meta } : {}), results: m.results! })
    })
    w.on('error', (e) => done({ fatal: { error: e.message } }))
  })
}

// ───────────── 动态规则 ─────────────

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function seriesChecks(label: string, out: unknown, n: number): { issues: LoadIssue[]; series?: SignalSeries } {
  const issues: LoadIssue[] = []
  const bad = (rule: string, message: string, hint?: string): void => { issues.push(issue(rule, `${label}: ${message}`, hint)) }
  if (!out || typeof out !== 'object') { bad('output', 'evaluate() must return an object { target, reasons, overlays, warmup }'); return { issues } }
  const o = out as Partial<SignalSeries>
  if (!Array.isArray(o.target) || o.target.length !== n) bad('output-length', `target must be an array with exactly one entry per candle (got ${Array.isArray(o.target) ? o.target.length : typeof o.target}, expected ${n})`)
  else {
    const i = o.target.findIndex((x) => !isNum(x))
    if (i >= 0) bad('output-target', `target[${i}] is not a finite number`, 'Use 0 when the indicator is still warming up; never NaN / undefined.')
    const j = o.target.findIndex((x) => isNum(x) && (x < -1 || x > 1))
    if (j >= 0) bad('output-target', `target[${j}] = ${String(o.target[j])} is outside [-1, 1]`, '+1 = fully long, -1 = fully short, 0 = flat, 0.5 = half long.')
  }
  if (!Array.isArray(o.reasons) || o.reasons.length !== n) bad('output-length', `reasons must be an array with exactly one string per candle (got ${Array.isArray(o.reasons) ? o.reasons.length : typeof o.reasons}, expected ${n}); use '' where the target did not change`)
  else {
    const i = o.reasons.findIndex((x) => typeof x !== 'string')
    if (i >= 0) bad('output-reasons', `reasons[${i}] is not a string`)
    else if (Array.isArray(o.target) && o.target.length === n) {
      let prev = 0
      for (let k = 0; k < n; k++) { const t = o.target[k] as number; if (Math.abs(t - prev) > 1e-9 && o.reasons[k] === '') { bad('reason-missing', `the target changed at index ${k} but reasons[${k}] is empty`, 'Every change of target needs a one-line human-readable reason; it is stored with the signal and the order.'); break } prev = t }
    }
  }
  if (o.overlays === undefined || typeof o.overlays !== 'object' || o.overlays === null || Array.isArray(o.overlays)) bad('output-overlays', 'overlays must be an object of name -> array (use {} when there is nothing to draw)')
  else {
    const names = Object.keys(o.overlays)
    if (names.length > 12) bad('output-overlays', 'at most 12 overlay lines')
    for (const name of names) {
      const arr = (o.overlays as Record<string, unknown>)[name]
      if (!Array.isArray(arr) || arr.length !== n || !arr.every((x) => x === null || isNum(x))) { bad('output-overlays', `overlay "${name}" must be an array of ${n} numbers or null`); break }
    }
  }
  if (!Number.isInteger(o.warmup) || (o.warmup as number) < 0) bad('output-warmup', 'warmup must be a non-negative integer: the index of the first bar with a valid signal (it may exceed n while the indicators are still warming up)')
  return { issues, ...(issues.length === 0 ? { series: o as SignalSeries } : {}) }
}

/** 用最小值 / 最大值构造极端参数（只动数值型参数）。 */
function extremeParams(defs: ParamDef[], which: 'min' | 'max'): Params {
  const p = defaultsOf(defs)
  for (const d of defs) if ((d.type === 'number' || d.type === 'integer') && d[which] !== undefined) p[d.key] = d[which]!
  return p
}

export interface LoadedStrategy { def: StrategyDef; warnings: LoadIssue[] }

const strategyDigests = new WeakMap<StrategyDef, Sha256Digest>()
const strategySources = new WeakMap<StrategyDef, string>()

export function getStrategySha256(def: StrategyDef): Sha256Digest | undefined {
  return strategyDigests.get(def)
}

export function getStrategySource(def: StrategyDef): string | undefined {
  return strategySources.get(def)
}

/** 校验并加载一个策略文件。成功返回 def，失败返回可读的错误列表。 */
export async function loadStrategyFile(path: string, opts: { budgetMs?: number } = {}): Promise<{ def?: StrategyDef; warnings: LoadIssue[]; errors: LoadIssue[] }> {
  const file = basename(path)
  const errors: LoadIssue[] = []
  const warnings: LoadIssue[] = []
  const ext = extname(file).toLowerCase()
  if (!(STRATEGY_EXTENSIONS as readonly string[]).includes(ext)) return { errors: [issue('extension', `unsupported file type ${ext || '(none)'}; use .ts, .mts, .js or .mjs (ES module)`)], warnings }
  let source: Buffer
  let text: string
  try {
    const st = await stat(path)
    if (st.size > MAX_SOURCE_BYTES) return { errors: [issue('size', `file is ${st.size} bytes; the limit is ${MAX_SOURCE_BYTES}`)], warnings }
    source = await readFile(path)
    text = source.toString('utf8')
  } catch (e) { return { errors: [issue('read', `cannot read the file: ${(e as Error).message}`)], warnings } }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  let js = text
  if (ext === '.ts' || ext === '.mts') {
    if (typeof stripTypeScriptTypes !== 'function') return { errors: [issue('typescript', `this Node.js (${process.version}) cannot strip TypeScript types`, 'Use Node >= 22.13, or write the strategy as a .mjs file.')], warnings }
    try { js = quietly(() => stripTypeScriptTypes(text, { mode: 'strip' })) } catch (e) {
      return { errors: [issue('syntax', `TypeScript could not be parsed: ${(e as Error).message}`, 'Only erasable TypeScript is supported (types, interfaces, `as`, `satisfies`). Do not use enums, namespaces or constructor parameter properties.')], warnings }
    }
  }
  errors.push(...staticChecks(js))
  if (errors.length > 0) return { errors, warnings }

  const fixture = synthCandles({ n: VALIDATION_BARS, seed: 7, intervalMs: 60_000 })
  const run = await runInWorker(js, fixture, (meta) => {
    const defs = meta.params as ParamDef[]
    const d = defaultsOf(defs)
    const full: CallSpec[] = [
      { id: 'full', fn: 'evaluate', params: d, frozen: true },
      { id: 'again', fn: 'evaluate', params: d },
      { id: 'empty', fn: 'evaluate', len: 0, params: d },
      { id: 'short', fn: 'evaluate', len: 5, params: d },
      { id: 'min', fn: 'evaluate', params: extremeParams(defs, 'min') },
      { id: 'max', fn: 'evaluate', params: extremeParams(defs, 'max') },
    ]
    for (const k of [150, 300, 450, 599]) full.push({ id: `prefix${k}`, fn: 'evaluate', len: k, params: d })
    if (meta.hasAnchor) full.push({ id: 'anchor', fn: 'anchor', lastN: 50, params: d })
    return full
  }, opts.budgetMs ?? WORKER_BUDGET_MS)
  if (run.fatal) return { errors: [issue('load', `the file failed to load: ${run.fatal.error}`, run.fatal.stack ? run.fatal.stack : 'Check the syntax; the file must `export default` the strategy object.')], warnings }
  if (run.timedOut) return { errors: [issue('timeout', `loading or validating took longer than ${(opts.budgetMs ?? WORKER_BUDGET_MS) / 1000} s`, 'Look for infinite loops or quadratic work in evaluate(); it runs on up to 800 candles per closed bar.')], warnings }
  const meta = run.meta!
  const structural = structureChecks(meta)
  if (structural.length > 0) return { errors: structural, warnings }
  const R = new Map((run.results ?? []).map((r) => [r.id, r]))
  const res = (id: string): CallResult | undefined => R.get(id)

  const full = res('full')
  if (!full?.ok) return { errors: [issue('evaluate-throws', `evaluate(candles, defaults) threw: ${full?.error ?? 'no result'}`, /read only|frozen|Cannot assign|Cannot add|Cannot delete/i.test(full?.error ?? '') ? 'evaluate() must not modify its inputs (candles are frozen during validation). Copy before sorting or mutating.' : 'Fix the error; it was run on 600 synthetic 1-minute candles with the default parameters.')], warnings }
  if (full.ms > CALL_BUDGET_MS) errors.push(issue('slow', `evaluate() took ${full.ms} ms on 600 candles (limit ${CALL_BUDGET_MS} ms)`, 'Avoid O(n²) loops; compute indicators in one pass.'))
  const fullCheck = seriesChecks('evaluate(600 candles, default params)', full.value, VALIDATION_BARS)
  errors.push(...fullCheck.issues)

  const again = res('again')
  if (again?.ok && JSON.stringify(again.value) !== JSON.stringify(full.value)) errors.push(issue('non-deterministic', 'calling evaluate() twice with the same input gave different output', 'Remove hidden state (module-level variables that change between calls); the result must depend only on (candles, params).'))

  const empty = res('empty')
  if (empty && !empty.ok) errors.push(issue('empty-input', `evaluate([], params) threw: ${empty.error}`, 'Return { target: [], reasons: [], overlays: {}, warmup: 0 } for an empty candle array.'))
  else if (empty?.ok) errors.push(...seriesChecks('evaluate([] candles)', empty.value, 0).issues)
  const short = res('short')
  if (short && !short.ok) errors.push(issue('short-input', `evaluate(5 candles) threw: ${short.error}`, 'Indicators must cope with fewer candles than their period: output null / 0 and set warmup.'))
  else if (short?.ok) errors.push(...seriesChecks('evaluate(5 candles)', short.value, 5).issues)
  for (const id of ['min', 'max'] as const) {
    const r = res(id)
    if (r && !r.ok) errors.push(issue('extreme-params', `evaluate() threw with every numeric parameter at its ${id}: ${r.error}`, `Every value between min and max must work. Tighten ${id === 'min' ? 'min' : 'max'} in the parameter definitions, or make evaluate() robust.`))
    else if (r?.ok) errors.push(...seriesChecks(`evaluate(params at ${id})`, r.value, VALIDATION_BARS).issues)
  }

  // 前视偏差：截断后重算，已有的 target 不得变化
  if (fullCheck.series) {
    for (const k of [150, 300, 450, 599]) {
      const p = res(`prefix${k}`)
      if (!p?.ok) { if (p) errors.push(issue('prefix-throws', `evaluate(first ${k} candles) threw: ${p.error}`)); continue }
      const part = (p.value as SignalSeries | undefined)?.target
      if (!Array.isArray(part) || part.length !== k) { errors.push(issue('output-length', `evaluate(first ${k} candles) returned ${Array.isArray(part) ? part.length : typeof part} targets`)); continue }
      const i = part.findIndex((x, idx) => !(Math.abs(x - fullCheck.series!.target[idx]!) <= 1e-9))
      if (i >= 0) {
        errors.push(issue('lookahead', `target[${i}] was ${fullCheck.series.target[i]} with 600 candles but ${part[i]} when only the first ${k} candles were given: the strategy looks at future candles`, `target[i] may only depend on candles[0..i]. Typical causes: using candles[i+1], a statistic over the whole array (mean/max of all closes), or normalising by the full-series range.`))
        break
      }
    }
    if (fullCheck.series.target.every((t) => t === 0)) warnings.push(issue('never-trades', 'the target stayed 0 on the 600-candle validation fixture', 'Fine for a blank template. A real strategy should produce a non-zero target somewhere; check the entry conditions.'))
  }
  const anchor = res('anchor')
  if (anchor) {
    if (!anchor.ok) errors.push(issue('anchor-throws', `anchor(candles, params) threw: ${anchor.error}`))
    else if (!anchor.value || typeof anchor.value !== 'object' || Array.isArray(anchor.value)) errors.push(issue('anchor-output', 'anchor() must return the (possibly completed) parameter object'))
    else {
      const known = new Set((meta.params as ParamDef[]).map((p) => p.key))
      const extra = Object.keys(anchor.value as object).filter((k) => !known.has(k))
      if (extra.length) errors.push(issue('anchor-output', `anchor() returned keys that are not declared parameters: ${extra.join(', ')}`))
    }
  }
  if (errors.length > 0) return { errors, warnings }

  // 通过：在主线程再加载一次拿到真正的函数（同一份代码，data: URL 的模块缓存按内容区分，改文件即热更新）
  let mod: { default?: unknown; strategy?: unknown }
  try { mod = (await import(`data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`)) as typeof mod } catch (e) {
    return { errors: [issue('load', `the file failed to load: ${(e as Error).message}`)], warnings }
  }
  const raw = (mod.default ?? mod.strategy) as { evaluate: StrategyDef['evaluate']; anchor?: StrategyDef['anchor'] }
  const params = meta.params as ParamDef[]
  const def: StrategyDef = {
    id: meta.id as string, name: meta.name as string, ...(typeof meta.nameZh === 'string' ? { nameZh: meta.nameZh } : {}), version: meta.version as string, desc: meta.desc as string,
    tags: meta.tags as string[], params, defaults: defaultsOf(params),
    evaluate: (c, p) => raw.evaluate(c, p),
    ...(typeof raw.anchor === 'function' ? { anchor: (c: Candle[], p: Params) => raw.anchor!(c, p) } : {}),
    file,
  }
  strategyDigests.set(def, sha256Digest(source))
  strategySources.set(def, js)
  return { def, warnings, errors }
}

// ───────────── 文件夹监视 ─────────────

export interface FolderHooks {
  now(): number
  /** 加载 / 失败 / 卸载时通知（引擎转成 strategy 流事件）。 */
  onChange?(r: FileReport): void
  log?(level: 'info' | 'warn', msg: string, fields?: Record<string, string | number | boolean | null>): void
}

export class StrategyFolder {
  private readonly known = new Map<string, { sig: string; report: FileReport }>()
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private busy: Promise<void> = Promise.resolve()
  private closed = false
  /** 第一次扫描完成。 */
  ready: Promise<void> = Promise.resolve()

  constructor(readonly dir: string, private readonly registry: StrategyRegistry, private readonly hooks: FolderHooks, private readonly opts: { pollMs?: number; debounceMs?: number } = {}) {}

  start(): Promise<void> {
    this.ready = (async () => {
      try { await mkdir(this.dir, { recursive: true }) } catch { /* 目录建不了就当它不存在 */ }
      await this.rescan()
      if (this.closed) return
      try {
        this.watcher = watch(this.dir, { persistent: false }, () => this.schedule())
        this.watcher.on('error', () => undefined)
      } catch { /* 靠轮询 */ }
      this.poll = setInterval(() => this.schedule(), this.opts.pollMs ?? 5000)
      this.poll.unref?.()
    })()
    return this.ready
  }

  stop(): void {
    this.closed = true
    this.watcher?.close()
    if (this.poll) clearInterval(this.poll)
    if (this.debounce) clearTimeout(this.debounce)
  }

  reports(): FileReport[] { return [...this.known.values()].map((k) => k.report).sort((a, b) => a.file.localeCompare(b.file)) }

  private schedule(): void {
    if (this.closed) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { this.debounce = null; void this.rescan() }, this.opts.debounceMs ?? 300)
    this.debounce.unref?.()
  }

  /** 扫描一遍文件夹：新增 / 改动的重新校验，消失的卸载。串行执行。 */
  rescan(): Promise<void> {
    this.busy = this.busy.then(() => this.scan()).catch(() => undefined)
    return this.busy
  }

  private async scan(): Promise<void> {
    let names: string[]
    try { names = await readdir(this.dir) } catch { names = [] }
    const files = names.filter((n) => !n.startsWith('.') && !n.startsWith('_') && !/\.(test|spec|d)\.[mc]?[jt]s$/.test(n) && (STRATEGY_EXTENSIONS as readonly string[]).includes(extname(n).toLowerCase())).sort()
    for (const file of [...this.known.keys()]) {
      if (files.includes(file)) continue
      const prev = this.known.get(file)!
      this.known.delete(file)
      if (prev.report.id && this.registry.get(prev.report.id)?.file === file) this.registry.remove(prev.report.id)
      this.emit({ file, status: 'removed', ...(prev.report.id ? { id: prev.report.id } : {}), errors: [], warnings: [], at: this.hooks.now() })
    }
    for (const file of files) {
      const path = join(this.dir, file)
      let sig: string
      try { const s = await stat(path); sig = `${s.mtimeMs}:${s.size}` } catch { continue }
      const prev = this.known.get(file)
      if (prev?.sig === sig) continue
      const r = await loadStrategyFile(path)
      // 同一个 id 不能由两个文件提供
      if (r.def) {
        const owner = this.registry.get(r.def.id)
        if (owner && owner.file !== file) r.errors.push(issue('duplicate-id', `id "${r.def.id}" is already provided by ${owner.file ?? 'another file'}`, 'Ids must be unique. Rename the id (and bump the version if this is a new variant).'))
      }
      if (r.def && r.errors.length === 0 && prev?.report.id && prev.report.id !== r.def.id && this.registry.get(prev.report.id)?.file === file) this.registry.remove(prev.report.id)
      const report: FileReport = r.def && r.errors.length === 0
        ? { file, status: 'loaded', id: r.def.id, version: r.def.version, errors: [], warnings: r.warnings, at: this.hooks.now() }
        : { file, status: 'error', errors: r.errors, warnings: r.warnings, at: this.hooks.now() }
      if (report.status === 'loaded') this.registry.set(r.def!)
      else if (prev?.report.id && this.registry.get(prev.report.id)?.file === file) {
        // 改坏了：旧版本继续可用（运行中的实例不受影响），但报告里标红
        report.id = prev.report.id
      }
      this.known.set(file, { sig, report })
      this.emit(report)
    }
  }

  private emit(r: FileReport): void {
    this.hooks.log?.(r.status === 'error' ? 'warn' : 'info', `strategy file ${r.file}: ${r.status}`, { id: r.id ?? null, errors: r.errors.length })
    this.hooks.onChange?.(r)
  }
}
