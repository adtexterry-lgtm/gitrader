// SPDX-License-Identifier: CPAL-1.0
// Offline checker for the English user documentation (no network, no dependencies):
//   1) every `gitrader <subcommand>` in the docs must exist as a case branch in packages/cli/src/index.ts;
//   2) backticked dot-path config keys must resolve to fields in packages/kernel/src/config.ts;
//   3) banned English product-copy words and host absolute paths are scanned;
//   4) all ten documents exist, are non-empty, and English and Chinese pages map one-to-one;
//      an English page with no same-named Chinese page is an orphan and is reported;
//   5) the files are actually English (long runs of CJK text outside link targets are flagged).
// Any mismatch: list every problem, exit code 1. All clear: exit code 0.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..', '..')
const zhDir = resolve(here, '..')
const CLI = join(root, 'packages', 'cli', 'src', 'index.ts')
const CONFIG = join(root, 'packages', 'kernel', 'src', 'config.ts')

const problems = []
const fail = (msg) => problems.push(msg)
const norm = (s) => s.split(String.fromCharCode(13)).join('')

// ---- Required files -------------------------------------------------------------------
const REQUIRED = [
  'README.md',
  '01-快速开始.md',
  '02-配置参考.md',
  '03-策略开发.md',
  '04-回测与研究.md',
  '05-实盘与风控.md',
  '06-通知配置.md',
  '07-插件.md',
  '08-可观测性.md',
  '09-安全.md',
  '10-常见问题.md',
]
for (const name of REQUIRED) {
  const p = join(here, name)
  if (!existsSync(p)) { fail(`missing file: docs/user/en/${name}`); continue }
  if (norm(readFileSync(p, 'utf8')).trim().length < 400) fail(`file too short (probably unfinished): docs/user/en/${name}`)
  if (!existsSync(join(zhDir, name))) fail(`no Chinese counterpart for docs/user/en/${name}`)
}

// Same-named English file for every Chinese page, and no orphan English pages.
for (const name of readdirSync(zhDir).filter((f) => f.endsWith('.md')).sort()) {
  if (!existsSync(join(here, name))) fail(`docs/user/${name} has no English version at docs/user/en/${name}`)
}
// Orphan English pages: every English page must have a same-named Chinese source page.
for (const name of readdirSync(here).filter((f) => f.endsWith('.md')).sort()) {
  if (!existsSync(join(zhDir, name))) fail(`docs/user/en/${name} has no Chinese counterpart at docs/user/${name}`)
}

if (!existsSync(CLI)) { console.error(`cannot find CLI source: ${CLI}`); process.exit(1) }
if (!existsSync(CONFIG)) { console.error(`cannot find config source: ${CONFIG}`); process.exit(1) }
const cliText = norm(readFileSync(CLI, 'utf8'))
const configText = norm(readFileSync(CONFIG, 'utf8'))

// ---- 1) subcommand set ----------------------------------------------------------------
const subcommands = new Set()
for (const m of cliText.matchAll(/case\s+'([a-z][a-z0-9-]*)'\s*:/g)) subcommands.add(m[1])
if (subcommands.size === 0) { console.error('parsed no case branches from packages/cli/src/index.ts'); process.exit(1) }

// Commands with exactly one valid sub-action (writing another verb is wrong).
const FIXED_SUB = { mcp: 'snippet', session: 'link', paper: 'reset' }
const VERBS = new Set(['start', 'stop', 'run', 'backtest', 'list', 'export', 'import', 'verify', 'install', 'remove', 'add', 'call', 'reload', 'bind', 'reset'])

// ---- 2) config fields -----------------------------------------------------------------
/** Text inside `export interface <name> { ... }` (handles single-line interfaces). */
function interfaceBody(name) {
  const m = new RegExp(`export interface ${name}\\s*\\{`).exec(configText)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let depth = 0
  for (let i = start; i < configText.length; i++) {
    const c = configText[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return configText.slice(start + 1, i) }
  }
  return null
}

/** Field names at depth 0 (names inside nested literals do not count as fields of this level). */
function topFields(body) {
  const out = new Set()
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === ':' && depth === 0) {
      const m = /([A-Za-z][A-Za-z0-9]*)\??\s*$/.exec(body.slice(0, i))
      if (m) out.add(m[1])
    }
  }
  return out
}

const topBody = interfaceBody('GitraderConfig')
if (!topBody) { console.error('cannot parse GitraderConfig'); process.exit(1) }
const TOP = topFields(topBody)

/** Top-level field -> second-level field set (named types via their interface, inline literals via their keys). */
const SECOND = new Map()
let depth = 0
for (const line of topBody.split('\n')) {
  const depthBefore = depth
  for (const c of line) { if (c === '{') depth++; else if (c === '}') depth-- }
  if (depthBefore !== 0) continue // lines inside multi-line literals are not top-level fields
  const f = /^\s*([A-Za-z][A-Za-z0-9]*)\??:\s*(.+)$/.exec(line)
  if (!f) continue
  const [, field, rawType] = f
  const named = /^([A-Z][A-Za-z0-9]*)/.exec(rawType.trim())
  if (named) {
    const body = interfaceBody(named[1])
    if (body) SECOND.set(field, topFields(body))
    continue
  }
  if (rawType.trim().startsWith('{')) {
    const set = new Set()
    for (const m of rawType.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*\??:/g)) set.add(m[1])
    if (set.size) SECOND.set(field, set)
  }
}

const wordInConfig = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(configText)

// Second segments that share a config prefix but are kernel action / event-topic names, not config keys.
const NOT_CONFIG_SECOND = new Set(['relax', 'verify', 'replay', 'stats', 'policy', 'denials', 'precheck', 'denied', 'temporaryRelax'])

/** Validate one backticked span; returns a problem description or null. */
function checkKeyPath(raw) {
  const path = raw.replace(/\[\]/g, '').trim()
  if (!/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(path)) return null // not a dot path
  const parts = path.split('.')
  if (['notify.send', 'notify_send', 'notify.user'].includes(path)) return null // plugin tool / permission names
  if (['notify', 'notifications', 'notification', 'channels'].includes(parts[0]) && !TOP.has(parts[0])) {
    return `config.ts has no \`${parts[0]}\` section, so it cannot be written as a config key: ${raw}`
  }
  if (!TOP.has(parts[0])) return null // not in the config namespace (tool name / permission name / file name / method)
  if (NOT_CONFIG_SECOND.has(parts[1])) return null
  const set = SECOND.get(parts[0])
  if (set && !set.has(parts[1])) return `config key does not exist in config.ts: ${raw}`
  if (!set && parts.length > 2) return `config key does not exist in config.ts: ${raw}`
  for (const seg of parts.slice(2)) if (!wordInConfig(seg)) return `config key does not exist in config.ts: ${raw}`
  return null
}

// ---- 3) banned wording and host paths -------------------------------------------------
const BANNED = [
  /\bguarantee(s|d)?\b/i,
  /\brisk[- ]free\b/i,
  /\briskless\b/i,
  /\bzero[- ]risk\b/i,
  /\boutperform(s|ed|ing)?\b/i,
  /\bsteady profits?\b/i,
  /\bsure profits?\b/i,
  /\bassured returns?\b/i,
  /\bbeat(s|ing)? the market\b/i,
  /\bmak(e|es|ing) money\b/i,
  /\bpassive income\b/i,
  /\bsure thing\b/i,
  /\bcan'?t lose\b/i,
  /\bno[- ]lose\b/i,
  /\bcoming soon\b/i,
  /\bwill be supported (soon|shortly)\b/i,
  /\bconservative\b/i,
  /\baggressive\b/i,
]
const LOCAL_PATH = [
  /\b[A-Za-z]:[\\/]+Users[\\/]+(?!you|user|username|example|runner|me|someone)[^\\/\s"']+/i,
  /\b[A-Za-z]:[\\/]+(UNIGIT|gitrader)\b/,
  /\/Users\/(?!you|user|someone)[a-z0-9._-]+\//i,
  /\/home\/(?!you|user|someone)[a-z0-9._-]+\//i,
]

// ---- 4) English-only check ------------------------------------------------------------
// Markdown link targets hold the (Chinese) source file names by design, and a couple of
// tokens are quoted from the product itself; everything else must be English.
const CJK_ALLOWED = ['中文', '唐奇安突破']
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]{3,}/
function cjkRuns(line) {
  let s = line.replace(/\]\([^)]*\)/g, ']') // drop link targets
  for (const ok of CJK_ALLOWED) s = s.split(ok).join('')
  const m = CJK_RUN.exec(s)
  return m ? m[0] : null
}

// ---- 5) per-file scan -----------------------------------------------------------------
const files = readdirSync(here).filter((f) => f.endsWith('.md')).sort()
const cmdSeen = new Map()
const keySeen = new Map()

for (const name of files) {
  const text = norm(readFileSync(join(here, name), 'utf8'))

  // 5.1 `gitrader <subcommand>`
  for (const m of text.matchAll(/(?:^|[^\w.-])gitrader\s+([a-z][a-z0-9-]*)/g)) {
    const sub = m[1]
    if (!subcommands.has(sub)) { fail(`${name}: command not present as a CLI branch: gitrader ${sub}`); continue }
    cmdSeen.set(sub, (cmdSeen.get(sub) ?? 0) + 1)
    const fixed = FIXED_SUB[sub]
    if (fixed) {
      const next = /^\s+([a-z][a-z0-9-]*)/.exec(text.slice(m.index + m[0].length))
      if (next && VERBS.has(next[1]) && next[1] !== fixed) {
        fail(`${name}: gitrader ${sub} only accepts the sub-action "${fixed}", the docs say "${next[1]}"`)
      }
    }
  }

  // 5.2 backticked config keys
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim()
    if (!span || span.length > 90) continue
    const bad = checkKeyPath(span)
    if (bad) { fail(`${name}: ${bad}`); continue }
    const clean = span.replace(/\[\]/g, '')
    if (/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(clean) && TOP.has(clean.split('.')[0])) {
      keySeen.set(span, (keySeen.get(span) ?? 0) + 1)
    }
  }

  // 5.3 banned wording / host paths / non-English text
  text.split('\n').forEach((line, i) => {
    for (const re of BANNED) {
      const hit = re.exec(line)
      if (hit) fail(`${name}:${i + 1}: banned product-copy wording ${JSON.stringify(hit[0])}`)
    }
    for (const re of LOCAL_PATH) {
      const hit = re.exec(line)
      if (hit) fail(`${name}:${i + 1}: host absolute path ${JSON.stringify(hit[0])}`)
    }
    const cjk = cjkRuns(line)
    if (cjk) fail(`${name}:${i + 1}: untranslated text ${JSON.stringify(cjk)}`)
  })
}

// ---- Output ---------------------------------------------------------------------------
const unique = [...new Set(problems)]
console.log(`scanned ${files.length} English documents`)
console.log(`CLI branches: ${subcommands.size} -> ${[...subcommands].sort().join(' ')}`)
console.log(`subcommands covered by docs: ${cmdSeen.size}, config keys referenced: ${keySeen.size}`)

if (unique.length) {
  console.error(`\n${unique.length} mismatch(es):`)
  for (const p of unique) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('ok    commands are all CLI branches, config keys are all in config.ts; no banned wording; no host paths; all ten pages translated; English and Chinese pages map one-to-one')
