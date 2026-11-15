// SPDX-License-Identifier: CPAL-1.0
import { makeProblem, mcpUsageLine, formatIssues, validateBySchemaId } from '../proto'
import type { McpToolDef } from '../proto'
import { KernelError } from '../util/errors'
import { isReadonlyPatch } from '../proto'
type Args = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const bad = (m: string): KernelError => new KernelError(makeProblem('INVALID_PARAMS', m))
const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
const DEC = /^-?\d+(\.\d+)?$/
const typeOk = (t: string, v: unknown): boolean =>
  t === 'string' ? typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))      // 数字写进 string 位置历来被接受（order.amend price），保持
  : t === 'number' ? (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
  : t === 'array' ? Array.isArray(v) : t === 'boolean' ? typeof v === 'boolean' : true

/** 逐个已声明的入参字段查类型；null / undefined 当没给。返回清洗后的 args（数字串转 number）。 */
export function checkToolArgs(tool: McpToolDef, action: string, args: Args): Args {
  const out: Args = {}
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue
    const spec = tool.inputSchema.properties[k] as { type?: string } | undefined
    if (k === 'action' || !spec?.type) { out[k] = v; continue }          // 未声明的键放行（见「不做」）
    if (!typeOk(spec.type, v)) {
      throw bad(`invalid argument ${tool.name}.${k}: expected ${spec.type}, got ${kindOf(v)}. Example: ${mcpUsageLine(tool.name, action)}`)
    }
    out[k] = spec.type === 'number' && typeof v === 'string' ? Number(v) : v
  }
  return out
}

/** 订单意图：只查「存在就必须长得对」的字段，缺字段仍由内核原有校验报（不改它的口径）。 */
export function checkIntent(i: unknown, path: string): void {
  if (i === undefined) return
  if (i === null || typeof i !== 'object' || Array.isArray(i)) throw bad(`${path} must be an object (got ${kindOf(i)}); see discover tool_help {"tool":"order"}`)
  const r = i as Args
  // 数字历来被 util/dec.ts 的 D() 接受（String(x) 后解析），所以有限数字照旧放行（只要 String(x) 是普通小数，不含科学计数法）；字符串必须是普通小数
  const decOk = (v: unknown): boolean => (typeof v === 'string' && DEC.test(v)) || (typeof v === 'number' && Number.isFinite(v) && DEC.test(String(v)))
  for (const f of ['size', 'notional', 'price', 'triggerPrice'] as const) {
    if (r[f] === undefined || r[f] === null) continue
    if (!decOk(r[f])) throw bad(`${path}.${f} must be a decimal string like "0.001" (got ${kindOf(r[f])}${typeof r[f] === 'string' ? ` ${JSON.stringify(String(r[f]).slice(0, 40))}` : ''})`)
  }
  if (r.side !== undefined && r.side !== 'buy' && r.side !== 'sell') throw bad(`${path}.side must be "buy" or "sell"`)
  const t = r.tpsl
  if (t !== undefined && t !== null) {
    if (typeof t !== 'object' || Array.isArray(t)) throw bad(`${path}.tpsl must be an object like {"grouping":"order","stopLoss":{"triggerPrice":"44000"}}`)
    for (const leg of ['stopLoss', 'takeProfit'] as const) {
      const l = (t as Args)[leg]
      if (l === undefined) continue
      if (l === null || typeof l !== 'object' || !decOk(l.triggerPrice))
        throw bad(`${path}.tpsl.${leg} must be an object like {"triggerPrice":"44000"} (got ${kindOf(l)})`)
    }
  }
  // 必填字段（accountId/instrumentId/side/type/reason）沿用内核既有报错，不在这里重复
}

/** experiment：先按协议 schema 校验，把 ajv 的路径原样给出；create 缺 patch 单独点名。 */
export function checkExperimentArgs(args: Args): void {
  // 只读字段（stage / metrics / runs…）不在这里拦：ajv 原句说不清原因，交给 lab 报 EXPERIMENT_FIELD_READONLY（lab 一定拒绝，这里不放宽任何东西）
  const patch = args.patch
  if ((args.action === 'update' || args.action === 'create') && patch && typeof patch === 'object' && !Array.isArray(patch)) {
    const body = args.action === 'create' ? Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'stage')) : patch   // create 允许带 stage（lab 同口径）
    if (isReadonlyPatch(body).length) return
  }
  const r = validateBySchemaId('urn:gitrader:schema:model:0.1:ExperimentToolInput', args)
  const issues = r.ok ? [] : r.issues.filter((i) => i.path !== '/to')   // stage.to 的未知值 lab 报 EXPERIMENT_TRANSITION_DENIED，更具体，不抢
  if (issues.length) throw bad(`invalid experiment input: ${formatIssues(issues)}. Example: ${mcpUsageLine('experiment', typeof args.action === 'string' ? args.action : 'create')}`)
  if (args.action === 'create') {
    if (args.patch === undefined) throw bad('invalid experiment input: create needs patch: {"title":"…","hypothesis":"…"} (title/hypothesis go inside patch, not at the top level)')
    const p = validateBySchemaId('urn:gitrader:schema:model:0.1:ExperimentCreatePatch', args.patch)
    if (!p.ok) throw bad(`invalid experiment patch: ${formatIssues(p.issues)}`)
  }
  if (args.action === 'attach' && args.attach !== undefined) {
    const a = validateBySchemaId('urn:gitrader:schema:model:0.1:ExperimentAttach', args.attach)
    if (!a.ok) throw bad(`invalid experiment attach: ${formatIssues(a.issues)}`)
  }
}
