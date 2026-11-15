// SPDX-License-Identifier: CPAL-1.0
import { formatIssues, validateBacktestSpec } from '../proto'

const TOP = ['subject', 'instruments', 'interval', 'from', 'to', 'data', 'account', 'assumptions', 'seed']
const ACCOUNT = ['initialBalance', 'ccy', 'leverage', 'maintenanceMarginRatio']
const DATA = ['source', 'files']
const FILE = ['path', 'sha256', 'format', 'kind']
const SUBJECT = ['strategy', 'workflow']

const stray = (o: unknown, allowed: string[], path: string): string[] =>
  o && typeof o === 'object' && !Array.isArray(o)
    ? Object.keys(o).filter((k) => !allowed.includes(k) && !k.startsWith('x-')).map((k) => `${path}/${k} is not a known field (allowed: ${allowed.join(', ')}; extension fields must start with "x-")`)
    : []

/** 返回 undefined = 通过；否则一句话列出全部问题（含 JSON 路径）。 */
export function explainBacktestSpec(spec: unknown): string | undefined {
  const why: string[] = []
  const r = validateBacktestSpec(spec)
  if (!r.ok) why.push(formatIssues(r.issues))
  const s = (spec ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  why.push(...stray(s, TOP, ''), ...stray(s.account, ACCOUNT, '/account'), ...stray(s.data, DATA, '/data'), ...stray(s.subject, SUBJECT, '/subject'))
  if (Array.isArray(s.data?.files)) s.data.files.forEach((f: unknown, i: number) => why.push(...stray(f, FILE, `/data/files/${i}`)))
  if (Number.isFinite(s.from) && Number.isFinite(s.to) && s.from >= s.to) why.push(`/from must be earlier than /to (from=${s.from}, to=${s.to})`)
  if (Array.isArray(s.instruments) && new Set(s.instruments).size !== s.instruments.length) why.push('/instruments contains duplicates')
  return why.length ? why.join('; ') : undefined
}
