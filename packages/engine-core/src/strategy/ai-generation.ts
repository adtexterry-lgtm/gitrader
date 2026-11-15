// SPDX-License-Identifier: CPAL-1.0
// 「写文件时」的助手，两件纯函数的事：
//   1. buildStrategyPrompt：把用户意图 + 我们的策略文件硬规则拼成给 Agent 的提示词；
//   2. validateGeneratedStrategy：对模型吐回的代码做静态校验（不执行、不联网、不调模型）。
// Gitrader 的策略在运行时是 (candles, params) 的纯函数，模型只在写文件时参与一次；真正的加载校验
// （结构 / 取值范围 / 确定性 / 前视偏差）由 strategy/loader.ts 负责，这里只是提前挡掉最明显的问题。
//
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_ai_generation.py:242; adapted (no runtime model calls).
// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/indicator_code_quality.py:146; adapted (no runtime model calls).
import type { ParamDef, ParamValue } from './types'
import { parseParamComments } from './schema'

export interface GenerationSpec {
  intent: string
  instrumentHint?: string
  interval?: string
  style?: 'trend' | 'mean-reversion' | 'breakout' | 'grid' | 'dca' | 'custom'
  constraints?: string[]
  idHint?: string
}

export interface StaticIssue { rule: string; message: string; line?: number }

// ───────────── 提示词 ─────────────

/** 风格只用来提示「从什么量出发」，不写具体参数：参数由生成的文件自己声明。 */
const STYLE_NOTE: Record<NonNullable<GenerationSpec['style']>, string> = {
  trend: 'trend following: derive the signal from breakouts, channel extremes or moving-average structure',
  'mean-reversion': 'mean reversion: derive the signal from the stretched distance to a baseline plus a re-entry condition',
  breakout: 'breakout: derive the signal from prior-window extremes; keep the exit rule separate from the entry rule',
  grid: 'grid: a bounded ladder around an anchor; the layer count and the step are declared parameters',
  dca: 'dca: a fixed schedule of adds; bound the number of layers and the per-step fraction',
  custom: 'as described in the intent; the rule must stay plain arithmetic over the candles',
}

const ROLE = `# Role
You write one Gitrader strategy file. Gitrader never runs a model at run time: you are called once, while the user is writing the file, and what you return is plain TypeScript that the engine validates and hot-loads.

# Output format
Return exactly one TypeScript strategy file and nothing else: no prose, no explanation, no markdown code fences, no second file. The file declares its own types, fills in \`evaluate\`, and ends with \`export default <strategy object>\`.`

const HARD_RULES = `# Hard rules (the loader enforces most of them)
- target[i] may use candles[0..i] ONLY. Never candles[i+1], never a statistic of the whole array (mean/max of all closes, normalising by the full range). The validator re-runs the function on truncated histories and fails it if an earlier signal changes ("lookahead").
- Deterministic: the same (candles, params) always produce the same output. No Math.random(), no Date.now(), no hidden state that survives between calls.
- Do not modify the arguments: candles are frozen during validation.
- No imports at run time (\`import type\` is fine and erased), no network, no files, no process/env access, no eval. Copy any helper you need into the file.
- Every change of target needs a short human-readable reason in reasons[i] ('' where the target did not change).
- evaluate() is plain arithmetic on the candles: never call a model, never make a "judgement" at run time.
- Never promise results in \`desc\`. Say what the rule does and when it tends to fail.
- Parameter keys must not look like secrets (privateKey, secret, apiSecret, mnemonic, seed, passphrase) and \`size\` is reserved by the engine.`

const CONTRACT = `# Interface and output contract
- evaluate(candles, params) returns { target, reasons, overlays, warmup }; n = candles.length.
- target: number[n], each in [-1, 1] and finite (+1 fully long, 0 flat, -1 fully short, 0.5 half long). Use 0 during warm-up.
- reasons: string[n], '' unless the target changed at that bar.
- overlays: Record<string, Array<number | null>>, lines for the price chart ({} is fine, at most 12).
- warmup: integer >= 0, the index of the first bar with a valid signal.
- It must cope with n = 0 and n < period (return empty / zero series, never throw) and with every numeric parameter at its min or max.
- The strategy object declares id (lowercase letters, digits and dashes, 2-40 chars), name, version (semantic version such as "0.1.0"), desc (plain words: what the rule does and when it fails), tags, and params.
- params: at most 40 entries, each { key (camelCase), label, type: number | integer | boolean | select, default }, plus optional min, max, step, options, help, hidden. Every default must satisfy its own type, min, max and options.`

const FORBIDDEN = `# Forbidden
- No imports (no \`import ... from\`, no \`require\`, no dynamic import()); \`import type\` is allowed and erased at load time.
- No IO: no fetch / XMLHttpRequest / WebSocket, no fs / path / process / env, no eval / new Function, no globalThis.
- No randomness and no wall clock: no Math.random(), no Date.now(), no new Date().
- No performance promises anywhere and especially in \`desc\`: state the rule and the situations where it fails.`

/** 给 Agent 的提示词：角色与产出格式 → 硬规则 → 接口与输出契约 → 用户意图 / 风格 / 约束 → 禁止事项。 */
export function buildStrategyPrompt(spec: GenerationSpec): string {
  const style = spec.style ?? 'custom'
  const intent = spec.intent.trim() === '' ? '(no intent given: pick a simple rule and say so in desc)' : spec.intent.trim()
  const blocks: string[] = [ROLE, HARD_RULES, CONTRACT]

  const want: string[] = ['# User intent', intent, '', `Style: ${style} — ${STYLE_NOTE[style]}`]
  if (spec.instrumentHint) want.push(`Instrument hint: ${spec.instrumentHint}`)
  if (spec.interval) want.push(`Interval: ${spec.interval}`)
  if (spec.idHint) want.push(`id hint: '${spec.idHint}'`)
  blocks.push(want.join('\n'))

  const constraints = (spec.constraints ?? []).map((c) => c.trim()).filter((c) => c !== '')
  if (constraints.length) blocks.push(['# Constraints from the user', ...constraints.map((c) => `- ${c}`)].join('\n'))

  blocks.push(FORBIDDEN)
  return blocks.join('\n\n') + '\n'
}

// ───────────── 静态校验 ─────────────

// 照抄 strategy/loader.ts 的静态规则（未导出，故在此复制并注明来源行）。
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/ // loader.ts:38
const SEMVER_RE = /^\d+\.\d+\.\d+$/ // loader.ts:40
const RESERVED_PARAM_KEYS = new Set(['privatekey', 'secret', 'apisecret', 'mnemonic', 'seed', 'passphrase', 'size']) // loader.ts:42
/** loader.ts:66-77 的 FORBIDDEN，去掉 import / dynamic import / require 三条（它们归 no-import）。 */
const FORBIDDEN_NO_IO: { re: RegExp; what: string }[] = [
  { re: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/, what: 'network access' },
  { re: /\bprocess\s*\./, what: 'process / environment access' },
  { re: /\b(?:child_process|node:fs|node:net|node:http|node:https|node:os|node:vm|worker_threads)\b/, what: 'node built-in modules' },
  { re: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/, what: 'eval / Function constructor' },
  { re: /\bglobalThis\s*\./, what: 'globalThis access' },
  { re: /\bMath\.random\s*\(/, what: 'Math.random() (strategies must be deterministic)' },
  { re: /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/, what: 'the wall clock (use candle timestamps)' },
]
/** desc 里读起来像业绩承诺的词：一旦出现，Agent 就回到了「卖点」语气。中文词按字符拼接书写（同 protocol 的 PLUGIN_PROMISE_PATTERNS），避免公开扫描把词表本身当成违规文案。 */
const PROMISE_WORDS = ['guaranteed', '100%', '保' + '守', '激' + '进', '稳' + '赚', '跑' + '赢', '稳定' + '盈利']

const FENCE_OPEN = /^[ \t]*```[^\n]*\n/m
const FENCE_CLOSE = /^[ \t]*```[ \t]*$/m

/** 去掉 ``` 代码围栏；围栏内的内容原样保留（不加不减空行），方便与输入逐字比较。 */
function stripFences(text: string): string {
  const src = text.replace(/^\uFEFF/, '')
  if (!src.includes('```')) return src
  const open = FENCE_OPEN.exec(src)
  if (!open) return src
  const rest = src.slice(open.index + open[0].length)
  const close = FENCE_CLOSE.exec(rest)
  return close ? rest.slice(0, close.index) : rest
}

/** 去掉注释，保留字符串内容；换行按原样补齐，行号不漂移。 */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]!
    const next = src[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      let pad = ''
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') pad += '\n'; i++ }
      i += 2
      out += pad
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      i++
      while (i < n) {
        const c = src[i]!
        out += c
        i++
        if (c === '\\') { if (i < n) { out += src[i]!; i++ } continue }
        if (c === quote) break
        if (c === '\n' && quote !== '`') break
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 把字符串内容抹成空格（长度、换行不变）：扫关键字时不会命中注释或字符串里提到的词。 */
function blankStrings(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += quote
      i++
      while (i < n) {
        const c = src[i]!
        if (c === '\\') {
          out += ' '
          i++
          if (i < n) { out += src[i] === '\n' ? '\n' : ' '; i++ }
          continue
        }
        if (c === quote) { out += quote; i++; break }
        out += c === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

function lineOf(src: string, index: number): number {
  let line = 1
  const end = Math.min(index, src.length)
  for (let i = 0; i < end; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

const at = (rule: string, message: string, src: string, index?: number): StaticIssue =>
  index === undefined ? { rule, message } : { rule, message, line: lineOf(src, index) }

/** 读 `id: 'x'` / `version: 'x'` / `desc: 'x'` 这类字符串字面量字段（注释已去掉）。 */
function stringField(code: string, name: string): { value: string; index: number } | undefined {
  const re = new RegExp(`\\b${name}\\s*:\\s*(['"\`])([^'"\`\\n]*)\\1`)
  const m = re.exec(code)
  if (!m) return undefined
  return { value: m[2] ?? '', index: m.index }
}

// ───────────── 参数质量（生成后校验用） ─────────────

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/indicator_code_quality.py:146; adapted (params array / comments instead of Python-decorated params; the lookahead check stays in loader.ts).

const PARAM_TYPES: readonly ParamDef['type'][] = ['number', 'integer', 'boolean', 'select']
const NUM_LITERAL = String.raw`-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`
/** `params: [` —— 后面紧跟 `[`，所以类型声明 `params: ParamDef[]` 不会命中。 */
const PARAMS_ARRAY_RE = /\bparams\s*:\s*\[/g
const PARAM_ITEM_RE = /\{[^{}]*\}/g
const RANGE_EPS = 1e-9

/** params 数组里的一项；抓不到的字段留 undefined（缺 key / default 的项整项跳过）。 */
interface RawParam {
  index: number
  key: string
  label?: string
  type?: ParamDef['type']
  def?: ParamValue
  min?: number
  max?: number
  step?: number
}

/** 从 open 处的括号往后找配对的收括号（字符串内容已抹成空格，括号不会误配）。 */
function matchEnd(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '[' || ch === '{' || ch === '(') depth++
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return src.length
}

/** 读对象字面量里的字符串字段（`key: 'x'`）。 */
function fieldString(text: string, name: string): string | undefined {
  const re = new RegExp('\\b' + name + '\\s*:\\s*([\'"`])([^\'"`\\n]*)\\1')
  return re.exec(text)?.[2]
}

/** 读对象字面量里的数字字段（`min: 2`）。 */
function fieldNumber(text: string, name: string): number | undefined {
  const re = new RegExp('\\b' + name + '\\s*:\\s*(' + NUM_LITERAL + ')(?![0-9A-Za-z_])')
  const raw = re.exec(text)?.[1]
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** 读 `default:` 的字面量（数字 / true / false / 字符串）；读不出返回 undefined。 */
function fieldDefault(text: string): ParamValue | undefined {
  const re = new RegExp('\\bdefault\\s*:\\s*(' + NUM_LITERAL + '(?![0-9A-Za-z_])|(?:true|false)\\b|\'[^\'\\n]*\'|"[^"\\n]*")')
  const raw = re.exec(text)?.[1]
  if (raw === undefined) return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw.startsWith("'") || raw.startsWith('"')) return raw.slice(1, -1)
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** 抓源码里 `params: [...]` 数组的每一项；没写数组或一项都抓不到时返回 []。 */
function scanArrayParams(code: string, bare: string): RawParam[] {
  PARAMS_ARRAY_RE.lastIndex = 0
  for (let outer = PARAMS_ARRAY_RE.exec(bare); outer !== null; outer = PARAMS_ARRAY_RE.exec(bare)) {
    const open = outer.index + outer[0].length - 1
    const body = code.slice(open + 1, matchEnd(bare, open))
    const out: RawParam[] = []
    PARAM_ITEM_RE.lastIndex = 0
    for (let item = PARAM_ITEM_RE.exec(body); item !== null; item = PARAM_ITEM_RE.exec(body)) {
      const text = item[0]
      const key = fieldString(text, 'key')
      const def = fieldDefault(text)
      if (key === undefined || key === '' || def === undefined) continue
      const raw: RawParam = { index: open + 1 + item.index, key, def }
      const label = fieldString(text, 'label')
      if (label !== undefined) raw.label = label
      const type = fieldString(text, 'type')
      if (type !== undefined && (PARAM_TYPES as readonly string[]).includes(type)) raw.type = type as ParamDef['type']
      const min = fieldNumber(text, 'min')
      if (min !== undefined) raw.min = min
      const max = fieldNumber(text, 'max')
      if (max !== undefined) raw.max = max
      const step = fieldNumber(text, 'step')
      if (step !== undefined) raw.step = step
      out.push(raw)
    }
    if (out.length > 0) return out
  }
  return []
}

function toParamDef(raw: RawParam): ParamDef {
  const param: ParamDef = { key: raw.key, label: raw.label ?? raw.key, type: raw.type ?? 'number', default: raw.def ?? 0 }
  if (raw.min !== undefined) param.min = raw.min
  if (raw.max !== undefined) param.max = raw.max
  if (raw.step !== undefined) param.step = raw.step
  return param
}

/** span 是 step 的整数倍（1e-9 误差内）。param-default-range 对两条口径都检查：max − min 与 default − min 都必须是 step 的整数倍。 */
function dividesBy(span: number, step: number): boolean {
  if (!(step > 0)) return true
  const quotient = span / step
  return Math.abs(quotient - Math.round(quotient)) <= RANGE_EPS
}

/** evaluate 函数体（注释已去掉、字符串内容已抹空，下标与 code 对齐）；跳过类型声明里的 `evaluate(...)`。 */
function evaluateBody(bare: string, code: string): string {
  const re = /\bevaluate\s*\(/g
  for (let m = re.exec(bare); m !== null; m = re.exec(bare)) {
    const open = bare.indexOf('{', m.index)
    if (open < 0) return ''
    // 签名与函数体之间只允许参数 / 返回类型：出现括号说明这是类型声明行，不是实现。
    if (/[{}]/.test(bare.slice(m.index, open))) continue
    return code.slice(open + 1, matchEnd(bare, open))
  }
  return ''
}

/** key 在函数体里被读过：num(p, 'key') / bool(p, 'key') / p.key / p['key'] 任一形态。 */
function keyIsRead(body: string, key: string): boolean {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const forms = [
    new RegExp('\\b(?:num|bool)\\s*\\(\\s*\\w+\\s*,\\s*[\'"`]' + k + '[\'"`]'),
    new RegExp('\\b\\w+\\s*\\.\\s*' + k + '\\b'),
    new RegExp('\\b\\w+\\s*\\[\\s*[\'"`]' + k + '[\'"`]\\s*\\]'),
  ]
  return forms.some((re) => re.test(body))
}

/** 优先从 `params: [...]` 数组抓参数；抓不到再用 `@param` 注释；都没有返回空。 */
export function paramsFromGenerated(text: string): { params: ParamDef[]; source: 'array' | 'comments' | 'none' } {
  const source = stripFences(typeof text === 'string' ? text : '')
  const code = stripComments(source)
  const raw = scanArrayParams(code, blankStrings(code))
  if (raw.length > 0) return { params: raw.map(toParamDef), source: 'array' }
  const fromComments = parseParamComments(source).params
  if (fromComments.length > 0) return { params: fromComments, source: 'comments' }
  return { params: [], source: 'none' }
}

/** 生成后静态校验：去围栏 → export default / evaluate → import / IO → id / version / desc / 参数名 / 参数质量。不执行代码。 */
export function validateGeneratedStrategy(text: string): { source: string; issues: StaticIssue[] } {
  const source = stripFences(typeof text === 'string' ? text : '')
  const code = stripComments(source)
  const bare = blankStrings(code)
  const issues: StaticIssue[] = []

  if (!/\bexport\s+default\b/.test(bare)) {
    issues.push(at('export-default', 'the file must end with `export default <strategy object>`', source))
  }
  const evaluate = /\bevaluate\s*\(/.exec(bare)
  if (!evaluate) {
    issues.push(at('evaluate', 'evaluate(candles, params) is missing', source))
  }

  const runtimeImport = /^[ \t]*import\s+(?!type\b)/m.exec(bare) ?? /\bimport\s*\(/.exec(bare) ?? /\brequire\s*\(/.exec(bare)
  if (runtimeImport) {
    issues.push(at('no-import', 'the file imports a module at run time (`import type` is allowed and erased); copy any helper into the file', source, runtimeImport.index))
  }

  for (const f of FORBIDDEN_NO_IO) {
    const m = f.re.exec(bare)
    if (m) issues.push(at('no-io', `the file uses ${f.what}`, source, m.index))
  }

  const id = stringField(code, 'id')
  if (!id) issues.push(at('id', 'the strategy object must declare `id`', source))
  else if (!ID_RE.test(id.value)) issues.push(at('id', `id "${id.value}" must match ${ID_RE.source} (lowercase letters, digits and dashes, 2-40 chars)`, source, id.index))

  const version = stringField(code, 'version')
  if (!version) issues.push(at('version', 'the strategy object must declare `version`', source))
  else if (!SEMVER_RE.test(version.value)) issues.push(at('version', `version "${version.value}" must be a semantic version string like "0.1.0"`, source, version.index))

  const desc = stringField(code, 'desc')
  if (desc) {
    const lower = desc.value.toLowerCase()
    const word = PROMISE_WORDS.find((w) => lower.includes(w.toLowerCase()))
    if (word) issues.push(at('no-promise', `desc contains "${word}": it reads as a performance promise; say what the rule does and when it fails instead`, source, desc.index))
  }

  const keyRe = /\bkey\s*:\s*(['"])([^'"\n]*)\1/g
  for (let m = keyRe.exec(code); m; m = keyRe.exec(code)) {
    const key = m[2] ?? ''
    if (!RESERVED_PARAM_KEYS.has(key.toLowerCase())) continue
    const message = key.toLowerCase() === 'size'
      ? `parameter key "${key}" is reserved: "size" is the engine-wide per-order size cap, pick another name`
      : `parameter key "${key}" looks like a secret; the protocol rejects such names`
    issues.push(at('param-key', message, source, m.index))
    issues.push(at('param-reserved', message, source, m.index))
  }

  // 参数质量：范围 / 步长 / 未使用 / 注释与数组不一致。
  const rawParams = scanArrayParams(code, bare)
  for (const p of rawParams) {
    if (p.type === 'integer' && typeof p.def === 'number' && !Number.isInteger(p.def)) {
      issues.push(at('param-default-range', `parameter "${p.key}": integer default ${p.def} is not an integer`, source, p.index))
    }
    if (typeof p.def === 'number') {
      if (p.min !== undefined && p.def < p.min - RANGE_EPS) {
        issues.push(at('param-default-range', `parameter "${p.key}": default ${p.def} is below min ${p.min}`, source, p.index))
      }
      if (p.max !== undefined && p.def > p.max + RANGE_EPS) {
        issues.push(at('param-default-range', `parameter "${p.key}": default ${p.def} is above max ${p.max}`, source, p.index))
      }
    }
    if (p.step !== undefined && p.step > 0) {
      if (p.min !== undefined && p.max !== undefined && !dividesBy(p.max - p.min, p.step)) {
        issues.push(at('param-default-range', `parameter "${p.key}": step ${p.step} does not divide the range ${p.min}..${p.max}`, source, p.index))
      }
      if (p.min !== undefined && typeof p.def === 'number' && !dividesBy(p.def - p.min, p.step)) {
        issues.push(at('param-default-range', `parameter "${p.key}": default ${p.def} is not on the ${p.step}-step grid that starts at min ${p.min}`, source, p.index))
      }
    }
  }

  const body = evaluateBody(bare, code)
  for (const p of rawParams) {
    if (!keyIsRead(body, p.key)) {
      issues.push(at('param-unused', `parameter "${p.key}" is declared in params but never read in evaluate()`, source, p.index))
    }
  }

  const commented = parseParamComments(source).params
  if (commented.length > 0) {
    const declaredKeys = new Set(rawParams.map((p) => p.key))
    const commentKeys = new Set(commented.map((p) => p.key))
    const onlyCommented = [...commentKeys].filter((k) => !declaredKeys.has(k))
    const onlyDeclared = [...declaredKeys].filter((k) => !commentKeys.has(k))
    if (onlyCommented.length > 0 || onlyDeclared.length > 0) {
      const parts: string[] = []
      if (onlyCommented.length > 0) parts.push(`only in @param comments: ${onlyCommented.join(', ')}`)
      if (onlyDeclared.length > 0) parts.push(`only in the params array: ${onlyDeclared.join(', ')}`)
      issues.push(at('param-comment-mismatch', `@param comments and the params array disagree (${parts.join('; ')})`, source))
    }
  }

  return { source, issues }
}
