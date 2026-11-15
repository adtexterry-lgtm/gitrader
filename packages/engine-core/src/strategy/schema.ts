// SPDX-License-Identifier: CPAL-1.0
// 策略参数 → JSON Schema（strategy.params 返回给宿主），以及 API 层的严格校验。
// 注意与 resolveParams 的区别：resolveParams 是 Demo 的「宽松补全并夹范围」（给回测夹具与旧调用用）；
// API 层不静默改写调用方的值——超范围、类型不对、未知键都明确报错，由调用方决定怎么改。
import type { ParamDef, ParamValue, Params } from './types'

export type JsonSchemaObject = Record<string, unknown>

export function paramsSchema(defs: readonly ParamDef[], title?: string): JsonSchemaObject {
  const properties: Record<string, unknown> = {}
  for (const d of defs) {
    const p: Record<string, unknown> = { title: d.label, default: d.default }
    if (d.type === 'boolean') p.type = 'boolean'
    else if (d.type === 'select') { p.type = 'string'; p.enum = d.options ?? [] }
    else {
      p.type = d.type === 'integer' ? 'integer' : 'number'
      if (d.min !== undefined) p.minimum = d.min
      if (d.max !== undefined) p.maximum = d.max
      if (d.step !== undefined) p['x-step'] = d.step
    }
    if (d.help) p.description = d.help
    if (d.hidden) p['x-hidden'] = true
    properties[d.key] = p
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...(title ? { title } : {}),
    type: 'object',
    properties,
    additionalProperties: false,
  }
}

export function defaultsOf(defs: readonly ParamDef[]): Params {
  return Object.fromEntries(defs.map((d) => [d.key, d.default]))
}

export type StrictResult = { ok: true; params: Params } | { ok: false; errors: string[] }

/** 严格校验：未知键、类型、范围、枚举；缺省键补默认值。错误信息只含键名与限制，不回显调用方给的值。 */
export function validateStrictParams(defs: readonly ParamDef[], input: unknown): StrictResult {
  if (input === undefined || input === null) return { ok: true, params: defaultsOf(defs) }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['params must be an object'] }
  const given = input as Record<string, unknown>
  const errors: string[] = []
  const known = new Set(defs.map((d) => d.key))
  for (const k of Object.keys(given)) if (!known.has(k)) errors.push(`unknown parameter "${k}"`)
  const out: Params = {}
  for (const d of defs) {
    const raw = given[d.key]
    if (raw === undefined) { out[d.key] = d.default; continue }
    if (d.type === 'boolean') {
      if (typeof raw !== 'boolean') errors.push(`${d.key}: must be a boolean`)
      else out[d.key] = raw
    } else if (d.type === 'select') {
      if (typeof raw !== 'string' || !d.options?.includes(raw)) errors.push(`${d.key}: must be one of ${(d.options ?? []).join(', ')}`)
      else out[d.key] = raw
    } else {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) errors.push(`${d.key}: must be a finite number`)
      else if (d.type === 'integer' && !Number.isInteger(raw)) errors.push(`${d.key}: must be an integer`)
      else if (d.min !== undefined && raw < d.min) errors.push(`${d.key}: must be >= ${d.min}`)
      else if (d.max !== undefined && raw > d.max) errors.push(`${d.key}: must be <= ${d.max}`)
      else out[d.key] = raw
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, params: out }
}

// ---- 实例级通用参数（所有策略实例都接受，不属于某个策略的 schema）--------------------------------

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/
export const INSTANCE_SIZE_KEY = 'size'

/**
 * `size`：单笔订单数量上限（基础资产单位，规范十进制字符串）。不设 = 不限。实例运行时可热改（strategy.update）。
 * 引擎按目标仓位算出的下单量超过它时，截到它；它只会让引擎少下，不会放大下单量。
 */
export function instanceParamsSchema(defs: readonly ParamDef[], title?: string): JsonSchemaObject {
  const s = paramsSchema(defs, title) as { properties: Record<string, unknown> }
  s.properties[INSTANCE_SIZE_KEY] = {
    title: '单笔数量上限（基础资产单位；不设 = 不限）', type: 'string', pattern: DECIMAL_RE.source,
    description: 'Per-order size cap in base-asset units, as a canonical decimal string. Only ever reduces order size.',
  }
  return s
}

/** API 层的实例参数校验：策略自己的参数严格校验 + 通用参数 size。 */
export function validateInstanceParams(defs: readonly ParamDef[], input: unknown): StrictResult {
  if (input === undefined || input === null) return { ok: true, params: defaultsOf(defs) }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['params must be an object'] }
  const { [INSTANCE_SIZE_KEY]: size, ...rest } = input as Record<string, unknown>
  const v = validateStrictParams(defs, rest)
  if (size === undefined) return v
  const errors = v.ok ? [] : [...v.errors]
  if (typeof size !== 'string' || !DECIMAL_RE.test(size) || !(Number(size) > 0)) errors.push('size: must be a positive canonical decimal string')
  return errors.length ? { ok: false, errors } : { ok: true, params: { ...(v as { params: Params }).params, [INSTANCE_SIZE_KEY]: size as string } }
}

/** 去掉通用参数，剩下的才交给策略的 evaluate。 */
export function strategyOnlyParams(params: Params): Params {
  const { [INSTANCE_SIZE_KEY]: _s, ...rest } = params
  return rest
}

// ---- @param 注释解析 / 回写（移植自 QuantDinger 的 indicator_params）------------------------------

/** 注释行语法（一行一个，放在策略 / 指标源码任意位置的行注释里）：
 *  // @param <key> <type> default=<v> [min=<v>] [max=<v>] [step=<v>] [values=a|b|c] [label="…"] [help="…"] [hidden]
 *  type ∈ number | integer | boolean | select；values 只对 select；default 必填。 */
export interface ParamParseIssue { line: number; message: string }

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/indicator_params.py:15; adapted.
const PARAM_COMMENT_RE = /(?:\/\/|#)\s*@param\b/
const PARAM_KEY_RE = /^\w+$/
const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const PARAM_TYPES: readonly ParamDef['type'][] = ['number', 'integer', 'boolean', 'select']
const PARAM_FIELDS = new Set(['default', 'min', 'max', 'step', 'values', 'label', 'help'])

interface Token { text: string; start: number; end: number }

/** 按空格切 token；双引号内的空格不切，反斜杠转义下一个字符。 */
function tokenize(text: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (i >= text.length) break
    const start = i
    let quoted = false
    while (i < text.length) {
      const ch = text[i]!
      if (quoted) {
        if (ch === '\\') { i += 2; continue }
        if (ch === '"') quoted = false
        i++
      } else {
        if (ch === '"') { quoted = true; i++; continue }
        if (/\s/.test(ch)) break
        i++
      }
    }
    out.push({ text: text.slice(start, i), start, end: i })
  }
  return out
}

function unquote(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  let out = ''
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length - 1) { out += text[i + 1]!; i++ } else out += ch
  }
  return out
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function needsQuotes(text: string): boolean {
  return text.length === 0 || /[\s"=]/.test(text)
}

function parseFinite(raw: string): number | null {
  if (!NUMERIC_RE.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function formatValue(value: ParamValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return needsQuotes(value) ? quote(value) : value
}

function formatValues(options: string[]): string {
  const joined = options.join('|')
  return /[\s"]/.test(joined) ? quote(joined) : joined
}

function formatRewriteValue(value: ParamValue, original: string): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  const wasQuoted = original.length >= 2 && original.startsWith('"') && original.endsWith('"')
  return wasQuoted || needsQuotes(value) ? quote(value) : value
}

interface PendingParam {
  key: string
  type: ParamDef['type']
  def: ParamValue
  min?: number
  max?: number
  step?: number
  options?: string[]
  label: string
  help?: string
  hidden: boolean
}

/** 解析单条 @param 行。成功返回参数定义，失败返回 { error }。 */
function parseLine(line: string, offset: number): PendingParam | { error: string } {
  const tokens = tokenize(line.slice(offset))
  const keyToken = tokens[0]
  if (!keyToken) return { error: 'missing parameter key' }
  const key = keyToken.text
  if (!PARAM_KEY_RE.test(key)) return { error: `invalid parameter key "${key}"` }
  const typeToken = tokens[1]
  if (!typeToken) return { error: `parameter "${key}": missing type` }
  const type = typeToken.text
  if (!PARAM_TYPES.includes(type as ParamDef['type'])) {
    return { error: `parameter "${key}": unknown type "${type}" (expected number, integer, boolean or select)` }
  }

  const fields = new Map<string, string>()
  let hidden = false
  const out = tokens.slice(2)
  for (const token of out) {
    const eq = token.text.indexOf('=')
    if (eq < 0) {
      if (token.text === 'hidden') { hidden = true; continue }
      return { error: `parameter "${key}": unknown token "${token.text}"` }
    }
    if (eq === 0) return { error: `parameter "${key}": empty field name` }
    const name = token.text.slice(0, eq)
    if (!PARAM_FIELDS.has(name)) return { error: `parameter "${key}": unknown field "${name}"` }
    if (fields.has(name)) return { error: `parameter "${key}": duplicate field "${name}"` }
    fields.set(name, token.text.slice(eq + 1))
  }

  const defaultRaw = fields.get('default')
  if (defaultRaw === undefined) return { error: `parameter "${key}": missing default` }

  const integer = type === 'integer'
  const bounds: Record<'min' | 'max' | 'step', number | undefined> = { min: undefined, max: undefined, step: undefined }
  for (const name of ['min', 'max', 'step'] as const) {
    const raw = fields.get(name)
    if (raw === undefined) continue
    const parsed = parseFinite(unquote(raw))
    if (parsed === null) return { error: `parameter "${key}": ${name} must be a finite number` }
    if (integer && !Number.isInteger(parsed)) return { error: `parameter "${key}": ${name} must be an integer` }
    bounds[name] = parsed
  }

  const valuesRaw = fields.get('values')
  let options: string[] | undefined
  if (valuesRaw !== undefined) {
    if (type !== 'select') return { error: `parameter "${key}": values is only allowed for select` }
    options = unquote(valuesRaw).split('|').map((v) => v.trim()).filter((v) => v.length > 0)
    if (options.length === 0) return { error: `parameter "${key}": values must list at least one option` }
  }

  const rawDefault = unquote(defaultRaw)
  let def: ParamValue
  if (type === 'boolean') {
    if (rawDefault !== 'true' && rawDefault !== 'false') {
      return { error: `parameter "${key}": boolean default must be true or false` }
    }
    def = rawDefault === 'true'
  } else if (type === 'select') {
    if (!options) return { error: `parameter "${key}": select requires values=<a|b|c>` }
    if (!options.includes(rawDefault)) {
      return { error: `parameter "${key}": default must be one of values ${options.join('|')}` }
    }
    def = rawDefault
  } else {
    const parsed = parseFinite(rawDefault)
    if (parsed === null) return { error: `parameter "${key}": default must be a finite number` }
    if (integer && !Number.isInteger(parsed)) return { error: `parameter "${key}": integer default must be an integer` }
    def = parsed
  }

  const labelRaw = fields.get('label')
  const helpRaw = fields.get('help')
  return {
    key,
    type: type as ParamDef['type'],
    def,
    min: bounds.min,
    max: bounds.max,
    step: bounds.step,
    options,
    label: labelRaw === undefined ? key : unquote(labelRaw),
    help: helpRaw === undefined ? undefined : unquote(helpRaw),
    hidden,
  }
}

export function parseParamComments(source: string): { params: ParamDef[]; issues: ParamParseIssue[] } {
  const params: ParamDef[] = []
  const issues: ParamParseIssue[] = []
  const indexByKey = new Map<string, number>()
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const comment = PARAM_COMMENT_RE.exec(line)
    if (!comment) continue
    const lineNo = i + 1
    const result = parseLine(line, comment.index + comment[0].length)
    if ('error' in result) { issues.push({ line: lineNo, message: result.error }); continue }

    const param: ParamDef = { key: result.key, label: result.label, type: result.type, default: result.def }
    if (result.min !== undefined) param.min = result.min
    if (result.max !== undefined) param.max = result.max
    if (result.step !== undefined) param.step = result.step
    if (result.options !== undefined) param.options = result.options
    if (result.help !== undefined) param.help = result.help
    if (result.hidden) param.hidden = true

    const existing = indexByKey.get(result.key)
    if (existing !== undefined) {
      params[existing] = param
      issues.push({ line: lineNo, message: `duplicate parameter "${result.key}": later declaration wins` })
    } else {
      indexByKey.set(result.key, params.length)
      params.push(param)
    }
  }
  return { params, issues }
}

/** 把新默认值回写进源码的 @param 行（只改 default=…，其余 token 原样保留，行内顺序不变）；找不到的 key 记进 missing。 */
export function rewriteParamDefaults(source: string, defaults: Record<string, ParamValue>): { source: string; missing: string[] } {
  const lines = source.split('\n')
  const found = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const comment = PARAM_COMMENT_RE.exec(line)
    if (!comment) continue
    const offset = comment.index + comment[0].length
    const tokens = tokenize(line.slice(offset))
    const key = tokens[0]?.text
    if (key === undefined || !Object.prototype.hasOwnProperty.call(defaults, key)) continue
    const value = defaults[key]
    if (value === undefined) continue
    const defaultToken = tokens.find((t) => t.text.startsWith('default='))
    if (!defaultToken) continue
    const original = defaultToken.text.slice('default='.length)
    const replacement = formatRewriteValue(value, original)
    lines[i] = line.slice(0, offset + defaultToken.start) + `default=${replacement}` + line.slice(offset + defaultToken.end)
    found.add(key)
  }
  const missing = Object.keys(defaults).filter((k) => !found.has(k))
  return { source: lines.join('\n'), missing }
}

/** 从 ParamDef[] 生成 @param 行（与 parse 互逆）。 */
export function formatParamComments(params: ParamDef[]): string {
  return params.map((p) => {
    const parts = [`// @param ${p.key} ${p.type}`, `default=${formatValue(p.default)}`]
    if (p.min !== undefined) parts.push(`min=${p.min}`)
    if (p.max !== undefined) parts.push(`max=${p.max}`)
    if (p.step !== undefined) parts.push(`step=${p.step}`)
    if (p.options !== undefined && p.options.length > 0) parts.push(`values=${formatValues(p.options)}`)
    parts.push(`label=${quote(p.label)}`)
    if (p.help !== undefined) parts.push(`help=${quote(p.help)}`)
    if (p.hidden) parts.push('hidden')
    return parts.join(' ')
  }).join('\n')
}
