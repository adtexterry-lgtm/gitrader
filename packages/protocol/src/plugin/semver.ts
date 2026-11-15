// SPDX-License-Identifier: Apache-2.0
// 够用的语义化版本：解析、比较、范围判断（`compat.gitrader`）。不引第三方依赖。
// 范围语法：比较符 `>= > <= < =`、`^`、`~`、精确版本、`*`；空格 = 与，`||` = 或。不支持连字符范围与 x 通配。

export interface ParsedVersion { major: number; minor: number; patch: number; pre: string[] }

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** `1.2.3-beta.1` → 结构；不合法返回 null。构建元数据（`+x`）接受并忽略。 */
export function parseVersion(v: string): ParsedVersion | null {
  const m = typeof v === 'string' ? VERSION_RE.exec(v) : null
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

function comparePre(a: string[], b: string[]): number {
  // 无预发布 > 有预发布
  if (a.length === 0 || b.length === 0) return (a.length === 0 ? 1 : 0) - (b.length === 0 ? 1 : 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1 } else if (xn !== yn) return xn ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function cmp(a: ParsedVersion, b: ParsedVersion): number {
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch) || comparePre(a.pre, b.pre)
}

/** 比较两个版本：-1 / 0 / 1。任一不合法抛 Error。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error(`invalid version: ${pa ? b : a}`)
  return cmp(pa, pb)
}

type Op = '>=' | '>' | '<=' | '<' | '='
interface Comparator { op: Op; v: ParsedVersion; /** 用户写的比较子才算（派生的上界不算）。 */ own: boolean }

const bare = (major: number, minor: number, patch: number): ParsedVersion => ({ major, minor, patch, pre: [] })

function parseComparator(tok: string): Comparator[] | null {
  if (tok === '*') return []
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(tok)
  const v = m ? parseVersion(m[2]!) : null
  if (!m || !v) return null
  const sym = m[1]
  if (sym === '^') {
    const upper = v.major > 0 ? bare(v.major + 1, 0, 0) : v.minor > 0 ? bare(0, v.minor + 1, 0) : bare(0, 0, v.patch + 1)
    return [{ op: '>=', v, own: true }, { op: '<', v: upper, own: false }]
  }
  if (sym === '~') return [{ op: '>=', v, own: true }, { op: '<', v: bare(v.major, v.minor + 1, 0), own: false }]
  return [{ op: (sym ?? '=') as Op, v, own: true }]
}

function parseRange(range: string): Comparator[][] | null {
  if (typeof range !== 'string') return null
  const sets: Comparator[][] = []
  for (const part of range.split('||')) {
    const toks = part.trim().split(/\s+/)
    if (toks.length === 1 && toks[0] === '') return null
    const set: Comparator[] = []
    for (const t of toks) {
      const cs = parseComparator(t)
      if (!cs) return null
      set.push(...cs)
    }
    sets.push(set)
  }
  return sets
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== null
}

function holds(c: Comparator, v: ParsedVersion): boolean {
  const d = cmp(v, c.v)
  return c.op === '>=' ? d >= 0 : c.op === '>' ? d > 0 : c.op === '<=' ? d <= 0 : c.op === '<' ? d < 0 : d === 0
}

/** `version` 是否落在 `range` 内。预发布版本只在同一 major.minor.patch 的比较子自己带预发布时才算（semver 惯例）。范围或版本不合法 → false。 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version)
  const sets = parseRange(range)
  if (!v || !sets) return false
  return sets.some((set) => {
    if (!set.every((c) => holds(c, v))) return false
    if (v.pre.length === 0) return true
    return set.some((c) => c.own && c.v.pre.length > 0 && c.v.major === v.major && c.v.minor === v.minor && c.v.patch === v.patch)
  })
}
