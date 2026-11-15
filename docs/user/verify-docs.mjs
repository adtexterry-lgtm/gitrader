// SPDX-License-Identifier: CPAL-1.0
// 用户文档离线校验（不联网、不装依赖）：
//   1) 文档里出现的 `gitrader <子命令>` 必须存在于 packages/cli/src/index.ts 的 case 分支；
//   2) 反引号里以 config.ts 顶层字段开头的点路径配置键，必须能解析到 config.ts 的字段；
//   3) 产品文案禁词与本机绝对路径扫描；
//   4) 十篇文档齐全且非空；
//   5) 相对链接必须指向真实存在的文件（锚点忽略；教程里缺失的样例数据只告警，样例由数据/教程标段产出）；
//   6) tutorials/ 下的教程（存在时）走同一套扫描；目录还没落地就跳过，不算失败。
// 用完即跑：`node docs/user/verify-docs.mjs [docs 目录]`，缺省校验本目录。
// 有任何不一致：逐条打印，退出码 1。全过：退出码 0。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const docsDir = process.argv[2] ? resolve(process.argv[2]) : here
const root = resolve(here, '..', '..')
const CLI = join(root, 'packages', 'cli', 'src', 'index.ts')
const CONFIG = join(root, 'packages', 'kernel', 'src', 'config.ts')

const problems = []
const warnings = []
const fail = (msg) => problems.push(msg)
const warn = (msg) => warnings.push(msg)
const norm = (s) => s.split(String.fromCharCode(13)).join('')

// ---- 必读文件 -------------------------------------------------------------------------
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
  const p = join(docsDir, name)
  if (!existsSync(p)) { fail(`缺文件：docs/user/${name}`); continue }
  if (norm(readFileSync(p, 'utf8')).trim().length < 400) fail(`文件内容过短（可能没写完）：docs/user/${name}`)
}

if (!existsSync(CLI)) { console.error(`找不到 CLI 源码：${CLI}`); process.exit(1) }
if (!existsSync(CONFIG)) { console.error(`找不到配置源码：${CONFIG}`); process.exit(1) }
const cliText = norm(readFileSync(CLI, 'utf8'))
const configText = norm(readFileSync(CONFIG, 'utf8'))

// ---- 1) 子命令集合 ---------------------------------------------------------------------
const subcommands = new Set()
for (const m of cliText.matchAll(/case\s+'([a-z][a-z0-9-]*)'\s*:/g)) subcommands.add(m[1])
if (subcommands.size === 0) { console.error('从 packages/cli/src/index.ts 没解析到任何 case 分支'); process.exit(1) }

// 只有一个合法子动作的命令（写成别的动词就是错的）
const FIXED_SUB = { mcp: 'snippet', session: 'link', paper: 'reset' }
const VERBS = new Set(['start', 'stop', 'run', 'backtest', 'list', 'export', 'import', 'verify', 'install', 'remove', 'add', 'call', 'reload', 'bind', 'reset'])

// ---- 2) 配置字段 -----------------------------------------------------------------------
/** 取 `export interface <name> { ... }` 花括号内的文本（能处理单行接口）。 */
function interfaceBody(name, text = configText) {
  const m = new RegExp(`export interface ${name}\\s*\\{`).exec(text)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start + 1, i) }
  }
  return null
}

/** 配置类型里 `{ … } & 协议类型` 的协议类型：在协议包的服务端安全配置里找（server 段并入了 ServerSecurityConfig）。 */
const PROTO_SERVER_SECURITY = join(root, 'packages', 'protocol', 'src', 'model', 'server-security.ts')
const protoInterfaceBody = (name) => (existsSync(PROTO_SERVER_SECURITY) ? interfaceBody(name, readFileSync(PROTO_SERVER_SECURITY, 'utf8')) : null)

/** 深度 0 上的字段名（嵌套字面量里的名字不算本层字段）。 */
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
if (!topBody) { console.error('解析不到 GitraderConfig'); process.exit(1) }
const TOP = topFields(topBody)

/** 顶层字段 → 二级字段集合（命名类型走接口；内联字面量走其中出现的键名）。 */
const SECOND = new Map()
let depth = 0
for (const line of topBody.split('\n')) {
  const depthBefore = depth
  for (const c of line) { if (c === '{') depth++; else if (c === '}') depth-- }
  if (depthBefore !== 0) continue // 多行字面量内部的行不算顶层字段
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
    for (const m of rawType.matchAll(/&\s*([A-Z][A-Za-z0-9]*)/g)) {
      const body = interfaceBody(m[1]) ?? protoInterfaceBody(m[1])
      if (body) for (const k of topFields(body)) set.add(k)
    }
    if (set.size) SECOND.set(field, set)
  }
}

const wordInConfig = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(configText)

// 与配置顶层同前缀、但属于内核动作名 / 事件主题名的二级段：不是配置键，跳过。
// （例如 risk relax 的动作名、risk.denials 事件主题：它们不在 config.ts 里，也不该在。）
const NOT_CONFIG_SECOND = new Set(['relax', 'verify', 'replay', 'stats', 'policy', 'denials', 'precheck', 'denied', 'temporaryRelax'])

/** 校验一个反引号片段；返回问题描述或 null。 */
function checkKeyPath(raw) {
  const path = raw.replace(/\[\]/g, '').trim()
  if (!/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(path)) return null // 不是点路径
  const parts = path.split('.')
  if (['notify.send', 'notify_send', 'notify.user'].includes(path)) return null // 插件工具名 / 权限名，不是配置键
  if (['notify', 'notifications', 'notification', 'channels'].includes(parts[0]) && !TOP.has(parts[0])) {
    return `config.ts 没有 \`${parts[0]}\` 段，不能当配置键写：${raw}`
  }
  if (!TOP.has(parts[0])) return null // 不属于配置命名空间（工具名 / 权限名 / 文件名 / 方法名）
  if (NOT_CONFIG_SECOND.has(parts[1])) return null
  const set = SECOND.get(parts[0])
  if (set && !set.has(parts[1])) return `配置键不存在于 config.ts：${raw}`
  if (!set && parts.length > 2) return `配置键不存在于 config.ts：${raw}`
  for (const seg of parts.slice(2)) if (!wordInConfig(seg)) return `配置键不存在于 config.ts：${raw}`
  return null
}

// ---- 3) 禁词（拼接写法，避免本脚本自己被扫到）---------------------------------------------
const BANNED = [
  '保' + '守',
  '激' + '进',
  '稳' + '赚',
  '跑' + '赢',
  '保证' + '收益',
  '零' + '风险',
  'risk' + '-free',
  'guarante' + 'ed',
  '稳定' + '盈利',
  '帮你' + '赚钱',
  '即将' + '支持',
  '即将' + '上线',
]
const LOCAL_PATH = [
  /\b[A-Za-z]:[\\/]+Users[\\/]+(?!you|user|username|example|runner|me|someone)[^\\/\s"']+/i,
  /\b[A-Za-z]:[\\/]+(UNIGIT|gitrader)\b/,
  /\/Users\/(?!you|user|someone)[a-z0-9._-]+\//i,
  /\/home\/(?!you|user|someone)[a-z0-9._-]+\//i,
]

// ---- 4) 相对链接 -----------------------------------------------------------------------
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
/** 文档里的相对链接（忽略 http(s) / mailto / 纯锚点 / 占位符）。 */
function checkLinks(label, filePath, text, strict) {
  const base = dirname(filePath)
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(LINK)) {
      const raw = m[1]
      if (!raw || /^(https?:|mailto:|tel:|#)/i.test(raw)) continue
      if (raw.startsWith('/')) continue // 站点绝对路径，不属于本地文件
      if (/[{}$<>]/.test(raw)) continue // 占位符
      const target = raw.split('#')[0].split('?')[0]
      if (!target) continue
      let decoded = target
      try { decoded = decodeURIComponent(target) } catch { /* 保持原样 */ }
      if (existsSync(join(base, decoded))) continue
      if (strict) fail(`${label}:${i + 1}: 链接指向的文件不存在 ${JSON.stringify(raw)}`)
      else warn(`${label}:${i + 1}: 链接指向的文件暂不存在 ${JSON.stringify(raw)}（教程样例可能由其它标段产出）`)
    }
  })
}

// ---- 5) 逐篇扫描 -----------------------------------------------------------------------
const cmdSeen = new Map()
const keySeen = new Map()

function scanText(label, filePath, text, strictLinks) {
  // 5.1 `gitrader <子命令>`
  for (const m of text.matchAll(/(?:^|[^\w.-])gitrader\s+([a-z][a-z0-9-]*)/g)) {
    const sub = m[1]
    if (!subcommands.has(sub)) { fail(`${label}: 命令不存在于 CLI 分支：gitrader ${sub}`); continue }
    cmdSeen.set(sub, (cmdSeen.get(sub) ?? 0) + 1)
    const fixed = FIXED_SUB[sub]
    if (fixed) {
      const next = /^\s+([a-z][a-z0-9-]*)/.exec(text.slice(m.index + m[0].length))
      if (next && VERBS.has(next[1]) && next[1] !== fixed) {
        fail(`${label}: gitrader ${sub} 只有子动作「${fixed}」，文档写的是「${next[1]}」`)
      }
    }
  }

  // 5.2 反引号内的配置键
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim()
    if (!span || span.length > 90) continue
    const bad = checkKeyPath(span)
    if (bad) { fail(`${label}: ${bad}`); continue }
    const clean = span.replace(/\[\]/g, '')
    if (/^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/.test(clean) && TOP.has(clean.split('.')[0])) {
      keySeen.set(span, (keySeen.get(span) ?? 0) + 1)
    }
  }

  // 5.3 禁词 / 本机路径
  text.split('\n').forEach((line, i) => {
    for (const w of BANNED) if (line.includes(w)) fail(`${label}:${i + 1}: 产品文案禁用词「${w}」`)
    for (const re of LOCAL_PATH) {
      const hit = re.exec(line)
      if (hit) fail(`${label}:${i + 1}: 本机路径 ${JSON.stringify(hit[0])}`)
    }
  })

  // 5.4 相对链接
  checkLinks(label, filePath, text, strictLinks)
}

const files = readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort()
for (const name of files) {
  const p = join(docsDir, name)
  scanText(name, p, norm(readFileSync(p, 'utf8')), true)
}

// ---- 6) 教程目录（存在就扫，没落地不算失败）----------------------------------------------
function walkTutorials(dir, base) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTutorials(p, `${base}/${entry.name}`))
    else if (entry.name.endsWith('.md')) out.push({ label: `${base}/${entry.name}`, path: p })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}
const tutorials = walkTutorials(join(docsDir, 'tutorials'), 'tutorials')
for (const t of tutorials) {
  scanText(t.label, t.path, norm(readFileSync(t.path, 'utf8')), false)
}

// ---- 输出 ------------------------------------------------------------------------------
const unique = [...new Set(problems)]
const uniqueWarn = [...new Set(warnings)]
console.log(`扫描 ${files.length} 篇文档`)
console.log(`CLI 分支 ${subcommands.size} 个：${[...subcommands].sort().join(' ')}`)
console.log(`文档覆盖子命令 ${cmdSeen.size} 个，配置键 ${keySeen.size} 个`)
console.log(tutorials.length
  ? `教程 ${tutorials.length} 篇：${tutorials.map((t) => t.label).join(' ')}`
  : '教程 0 篇（tutorials/ 还没落地，跳过）')

if (uniqueWarn.length) {
  console.log(`\n${uniqueWarn.length} 条提醒（不改变退出码）：`)
  for (const w of uniqueWarn) console.log(`  - ${w}`)
}

if (unique.length) {
  console.error(`\n${unique.length} 处不一致：`)
  for (const p of unique) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('ok    命令都在 CLI 分支里、配置键都在 config.ts 里；链接都指向真实文件；无禁词；无本机路径')
