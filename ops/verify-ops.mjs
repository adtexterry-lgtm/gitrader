// SPDX-License-Identifier: CPAL-1.0
// 可观测性配置的离线校验（不联网、不启动任何服务、不新增依赖）：
//   1) 解析 Grafana 仪表盘 JSON，收集所有 expr 里出现的 gitrader_* 指标名，
//      与 packages/kernel/src/metrics.ts 里的指标名集合双向比对（引用了不存在的 / 存在但没上盘）。
//   2) 校验 expr 里的标签名（state / topic）与取值，取值集合从内核与协议源码读出。
//   3) 用一个内置的最小 YAML 子集解析器读 prometheus.yml / alertmanager.yml / provisioning/*.yml，
//      再做结构断言（抓取路径、令牌文件引用、severity 路由、接收器名闭合）。
//   4) 密钥扫描：配置与文档里不许出现疑似真实令牌 / 密码。
// 退出码：全部通过 0，有任何一条失败 1。
//
// 用法：node ops/verify-ops.mjs        （在仓库任意位置执行都可以）
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const OPS = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(OPS, '..')

let failures = 0
let checks = 0
const fail = (msg) => { failures += 1; console.error(`FAIL  ${msg}`) }
const ok = (msg) => { checks += 1; console.log(`ok    ${msg}`) }
const check = (cond, msg, detail = '') => { if (cond) ok(msg); else fail(detail === '' ? msg : `${msg} — ${detail}`) }
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8')

// ---- 最小 YAML 子集解析器 ------------------------------------------------------------------
// 只支持本仓库配置用到的子集：注释、缩进映射、块序列、`- key: value` 内联映射起点、
// 单/双引号标量、行内 [a, b] / {a: b}、数字 / 布尔 / null。遇到不支持的写法直接抛错（宁可报错也不猜）。
const stripComment = (line) => {
  let out = ''
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote !== null) {
      out += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break
    out += ch
  }
  return out.replace(/\s+$/, '')
}

const splitFlow = (body) => {
  const items = []
  let cur = ''
  let quote = null
  let depth = 0
  for (const ch of body) {
    if (quote !== null) { cur += ch; if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '[' || ch === '{') { depth += 1; cur += ch; continue }
    if (ch === ']' || ch === '}') { depth -= 1; cur += ch; continue }
    if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() !== '') items.push(cur.trim())
  return items.filter((s) => s !== '')
}

const unquote = (s) => s.slice(1, -1).replace(/''/g, "'").replace(/\\"/g, '"')

const isMapStart = (text) => /^[^\s:'"][^:]*:(\s|$)/.test(text)
// `- foo: bar` 这种序列项里内联映射的键（键名不能含冒号）
const splitKey = (text) => {
  const m = /^([^\s:'"][^:]*?):(?:\s+(.*))?$/.exec(text)
  if (m === null) return null
  const key = m[1].trim()
  const raw = m[2] === undefined ? '' : m[2].trim()
  return { key, raw }
}

const parseScalar = (s) => {
  const t = s.trim()
  if (t === '') return null
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return unquote(t)
  if (t.startsWith('[') && t.endsWith(']')) return splitFlow(t.slice(1, -1)).map(parseScalar)
  if (t.startsWith('{') && t.endsWith('}')) {
    const out = {}
    for (const part of splitFlow(t.slice(1, -1))) {
      const kv = splitKey(part)
      if (kv === null) throw new Error(`行内映射无法解析：${part}`)
      out[kv.key] = parseScalar(kv.raw)
    }
    return out
  }
  if (t === 'null' || t === '~') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

function parseYaml(text, label = 'yaml') {
  const lines = []
  const raw = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n')
  raw.forEach((line, i) => {
    const noComment = stripComment(line)
    if (noComment.trim() === '') return
    const indent = /^ */.exec(noComment)[0].length
    if (noComment[indent] === '\t') throw new Error(`${label}:${i + 1} 用了 tab 缩进`)
    if (indent === 0 && /^---\s*$/.test(noComment.trim())) return
    lines.push({ indent, text: noComment.trim(), line: i + 1 })
  })
  let pos = 0
  const where = () => (pos < lines.length ? `${label}:${lines[pos].line}` : `${label}:EOF`)

  const parseMap = (indent) => {
    const out = {}
    while (pos < lines.length) {
      const l = lines[pos]
      if (l.indent < indent) break
      if (l.indent > indent) throw new Error(`${where()} 缩进不齐`)
      const kv = splitKey(l.text)
      if (kv === null) throw new Error(`${where()} 不是 key: value`)
      if (l.text.startsWith('- ')) throw new Error(`${where()} 序列项出现在映射里`)
      pos += 1
      if (kv.raw === '') {
        if (pos < lines.length && lines[pos].indent > indent) out[kv.key] = parseNode(lines[pos].indent)
        else out[kv.key] = null
      } else out[kv.key] = parseScalar(kv.raw)
    }
    return out
  }

  const parseSeq = (indent) => {
    const out = []
    while (pos < lines.length) {
      const l = lines[pos]
      if (l.indent < indent) break
      if (l.indent > indent) throw new Error(`${where()} 缩进不齐`)
      if (!(l.text === '-' || l.text.startsWith('- '))) break
      const rest = l.text === '-' ? '' : l.text.slice(2).trim()
      if (rest === '') {
        pos += 1
        if (pos < lines.length && lines[pos].indent > indent) out.push(parseNode(lines[pos].indent))
        else out.push(null)
      } else if (isMapStart(rest)) {
        const keyIndent = indent + 2
        lines[pos] = { indent: keyIndent, text: rest, line: l.line }
        out.push(parseMap(keyIndent))
      } else {
        pos += 1
        out.push(parseScalar(rest))
      }
    }
    return out
  }

  const parseNode = (indent) => {
    const l = lines[pos]
    if (l === undefined) return null
    return l.text === '-' || l.text.startsWith('- ') ? parseSeq(indent) : parseMap(indent)
  }

  if (lines.length === 0) return null
  const value = parseNode(lines[0].indent)
  if (pos !== lines.length) throw new Error(`${where()} 解析提前结束（剩余 ${lines.length - pos} 行）`)
  return value
}

const tryYaml = (rel) => {
  try {
    return { ok: true, value: parseYaml(read(...rel.split('/')), rel) }
  } catch (err) {
    fail(`${rel} 最小 YAML 解析失败：${err.message}`)
    return { ok: false, value: null }
  }
}

// ---- 1. 内核指标名 --------------------------------------------------------------------------
const metricsSrc = read('packages', 'kernel', 'src', 'metrics.ts')
const kernelMetrics = new Set()
for (const m of metricsSrc.matchAll(/# TYPE (gitrader_[a-z0-9_]+)\s/g)) kernelMetrics.add(m[1])
check(kernelMetrics.size > 0, `metrics.ts 里读到 ${kernelMetrics.size} 个指标名`, '一个都没读到')

const kernelLabels = new Set()
for (const m of metricsSrc.matchAll(/\{([a-z_]+)="\$\{/g)) kernelLabels.add(m[1])
check(kernelLabels.size > 0, `metrics.ts 里读到标签名 ${[...kernelLabels].join(' / ')}`, '没读到标签名')

// 事件主题与交易状态：取值集合从源码读，不手写第二份
const topicsSrc = read('packages', 'kernel', 'src', 'events.ts')
const topics = new Set()
const topicBlock = /export const EVENT_TOPICS = \[([\s\S]*?)\] as const/.exec(topicsSrc)
if (topicBlock !== null) for (const m of topicBlock[1].matchAll(/'([a-z.]+)'/g)) topics.add(m[1])
check(topics.size > 0, `events.ts 里读到 ${topics.size} 个事件主题`, '没读到 EVENT_TOPICS')

const riskSrc = read('packages', 'protocol', 'src', 'model', 'risk.ts')
const states = new Set()
const stateBlock = /export const TRADING_STATES = \[([^\]]*)\]/.exec(riskSrc)
if (stateBlock !== null) for (const m of stateBlock[1].matchAll(/'([A-Z]+)'/g)) states.add(m[1])
check(states.size > 0, `risk.ts 里读到交易状态 ${[...states].join(' / ')}`, '没读到 TRADING_STATES')

// ---- 2. 仪表盘 ------------------------------------------------------------------------------
const DASH = 'ops/grafana/dashboards/gitrader-overview.json'
let dash = null
try {
  dash = JSON.parse(read(...DASH.split('/')))
  ok(`${DASH} 是合法 JSON`)
} catch (err) {
  fail(`${DASH} JSON 解析失败：${err.message}`)
}

const exprs = []
const walk = (node, path) => {
  if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return }
  if (node === null || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'expr' && typeof v === 'string') exprs.push({ expr: v, path })
    else walk(v, path === '' ? k : `${path}.${k}`)
  }
}
if (dash !== null) {
  walk(dash, '')
  check(exprs.length > 0, `仪表盘里收集到 ${exprs.length} 条 expr`, '没有 expr')
  check(typeof dash.uid === 'string' && dash.uid !== '', '仪表盘有 uid')
  check(Array.isArray(dash.panels) && dash.panels.length > 0, '仪表盘有面板', '没有 panels')

  const used = new Set()
  for (const { expr, path } of exprs) for (const m of expr.matchAll(/gitrader_[a-z0-9_]+/g)) used.add(m[0])

  const unknown = [...used].filter((n) => !kernelMetrics.has(n)).sort()
  check(unknown.length === 0, 'expr 引用的指标名都在 metrics.ts 里', `不存在的指标：${unknown.join(', ')}`)

  const unused = [...kernelMetrics].filter((n) => !used.has(n)).sort()
  check(unused.length === 0, 'metrics.ts 的每个指标都上盘了', `没上盘的指标：${unused.join(', ')}`)
  // 限流计数器要单独点名：它只在被拒时才增长，没人看就永远发现不了「限流把正常调用也拒了」。
  check(used.has('gitrader_op_rate_limited_total'), '限流计数器 gitrader_op_rate_limited_total 有面板', '没上盘：gitrader_op_rate_limited_total')

  const badLabel = []
  const badValue = []
  for (const { expr } of exprs) {
    for (const m of expr.matchAll(/\{\s*([a-z_]+)="([^"]*)"\s*\}/g)) {
      const [, label, value] = m
      if (!kernelLabels.has(label)) { badLabel.push(`${label}（${expr}）`); continue }
      if (label === 'topic' && !topics.has(value)) badValue.push(`topic="${value}"（${expr}）`)
      if (label === 'state' && !states.has(value)) badValue.push(`state="${value}"（${expr}）`)
    }
  }
  check(badLabel.length === 0, 'expr 里的标签名都在 metrics.ts 里', badLabel.join('; '))
  check(badValue.length === 0, 'expr 里的 topic / state 取值都在源码枚举里', badValue.join('; '))

  const ids = new Set()
  const badPanel = []
  for (const p of Array.isArray(dash.panels) ? dash.panels : []) {
    if (typeof p.id !== 'number') badPanel.push(`面板「${p.title ?? '?'}」缺 id`)
    if (ids.has(p.id)) badPanel.push(`面板 id 重复：${p.id}`)
    ids.add(p.id)
    if (typeof p.title !== 'string' || p.title === '') badPanel.push(`面板 id ${p.id} 缺 title`)
    if (!Array.isArray(p.targets) || p.targets.length === 0) badPanel.push(`面板「${p.title ?? '?'}」没有 targets`)
    const g = p.gridPos
    if (g === undefined || g === null) badPanel.push(`面板「${p.title ?? '?'}」缺 gridPos`)
    else if (!(g.x >= 0 && g.w > 0 && g.x + g.w <= 24)) badPanel.push(`面板「${p.title}」gridPos 超出 24 列`)
  }
  check(badPanel.length === 0, `仪表盘 ${ids.size} 个面板结构完整`, badPanel.join('; '))
}

// ---- 3. Prometheus / Alertmanager / provisioning ---------------------------------------------
const prom = tryYaml('ops/prometheus/prometheus.yml')
if (prom.ok && prom.value !== null) {
  const cfg = prom.value
  const ruleFiles = Array.isArray(cfg.rule_files) ? cfg.rule_files : []
  check(ruleFiles.some((f) => typeof f === 'string' && f.endsWith('alerts.yml')), 'prometheus.yml 的 rule_files 指向 alerts.yml', JSON.stringify(ruleFiles))
  check(existsSync(join(OPS, 'prometheus', 'alerts.yml')), 'ops/prometheus/alerts.yml 存在（既有文件，未改动）')

  const scrapes = Array.isArray(cfg.scrape_configs) ? cfg.scrape_configs : []
  const kernel = scrapes.find((s) => s !== null && typeof s === 'object' && s.job_name === 'gitrader-kernel')
  check(kernel !== undefined, 'prometheus.yml 有 gitrader-kernel 抓取作业', `作业：${scrapes.map((s) => s?.job_name).join(', ')}`)
  if (kernel !== undefined) {
    check(kernel.metrics_path === '/api/metrics', '抓取路径是 /api/metrics', String(kernel.metrics_path))
    const auth = kernel.authorization
    check(auth !== null && typeof auth === 'object' && auth.type === 'Bearer', '抓取用 Bearer 鉴权', JSON.stringify(auth))
    check(auth !== null && typeof auth === 'object' && typeof auth.credentials_file === 'string' && auth.credentials_file !== '', '令牌走 credentials_file 文件引用', JSON.stringify(auth))
    check(auth === null || typeof auth !== 'object' || !('credentials' in auth), 'prometheus.yml 里没有内联令牌', '出现了 authorization.credentials')
    const staticCfg = Array.isArray(kernel.static_configs) ? kernel.static_configs : []
    check(staticCfg.length > 0 && Array.isArray(staticCfg[0]?.targets) && staticCfg[0].targets.length > 0, '抓取目标非空', JSON.stringify(staticCfg))
  }
  const am = cfg.alerting?.alertmanagers
  check(Array.isArray(am) && am.length > 0, 'prometheus.yml 配了 alertmanager', JSON.stringify(am))
}

const amres = tryYaml('ops/alertmanager/alertmanager.yml')
if (amres.ok && amres.value !== null) {
  const cfg = amres.value
  const receivers = Array.isArray(cfg.receivers) ? cfg.receivers : []
  const names = receivers.map((r) => r?.name)
  check(names.length > 0, `alertmanager.yml 有 ${names.length} 个接收器`, '没有 receivers')
  const has = (fn) => receivers.some((r) => r !== null && typeof r === 'object' && Object.keys(r).some((k) => fn(k)))
  check(has((k) => k === 'telegram_configs'), '接收器里有 telegram 模板', names.join(', '))
  check(has((k) => k === 'email_configs'), '接收器里有 email 模板', names.join(', '))
  check(has((k) => k === 'webhook_configs'), '接收器里有 webhook 模板', names.join(', '))

  const route = cfg.route
  check(route !== null && typeof route === 'object', 'alertmanager.yml 有 route')
  const routes = Array.isArray(route?.routes) ? route.routes : []
  const sevNames = new Set()
  for (const r of routes) {
    const matchers = Array.isArray(r?.matchers) ? r.matchers : []
    for (const matcher of matchers) {
      const m = /^severity="([a-z]+)"$/.exec(String(matcher).trim())
      if (m !== null) sevNames.add(m[1])
    }
  }
  check(['critical', 'warning', 'info'].every((s) => sevNames.has(s)), 'route 按 severity 分成 critical / warning / info', [...sevNames].join(', ') || '一个都没有')

  const referenced = [route?.receiver, ...routes.map((r) => r?.receiver)].filter((n) => n !== undefined && n !== null)
  const dangling = referenced.filter((n) => !names.includes(n))
  check(dangling.length === 0, 'route 引用的接收器都存在', `找不到：${dangling.join(', ')}`)

  const inhibit = Array.isArray(cfg.inhibit_rules) ? cfg.inhibit_rules : []
  check(inhibit.every((r) => Array.isArray(r?.source_matchers) && Array.isArray(r?.target_matchers)), 'inhibit_rules 结构完整', JSON.stringify(inhibit))

  const telegram = receivers.find((r) => Array.isArray(r?.telegram_configs))
  const tg = telegram?.telegram_configs?.[0]
  check(tg?.bot_token_file !== undefined && tg?.bot_token === undefined, 'telegram 用 bot_token_file 文件引用，不内联令牌')
  const smtp = receivers.find((r) => Array.isArray(r?.email_configs))?.email_configs?.[0]
  check(smtp?.auth_password_file !== undefined && smtp?.auth_password === undefined, 'email 用 auth_password_file 文件引用，不内联密码')
  const hook = receivers.find((r) => Array.isArray(r?.webhook_configs))?.webhook_configs?.[0]
  check(hook?.http_config?.authorization?.credentials_file !== undefined, 'webhook 用 credentials_file 文件引用令牌')
}

const ds = tryYaml('ops/grafana/provisioning/datasources/prometheus.yml')
if (ds.ok && ds.value !== null) {
  const list = Array.isArray(ds.value.datasources) ? ds.value.datasources : []
  const p = list.find((d) => d?.type === 'prometheus')
  check(p !== undefined, 'provisioning 里有 prometheus 数据源', JSON.stringify(list.map((d) => d?.name)))
  check(p?.uid === 'prometheus', '数据源 uid 是 prometheus（与仪表盘引用一致）', String(p?.uid))
  check(typeof p?.url === 'string' && p.url !== '', '数据源 url 非空', String(p?.url))
  // 仪表盘里每个 datasource 引用都要指向 provisioning 定义的 uid
  const dsUids = new Set()
  const collectDs = (node) => {
    if (Array.isArray(node)) { node.forEach(collectDs); return }
    if (node === null || typeof node !== 'object') return
    if (typeof node.uid === 'string' && typeof node.type === 'string' && Object.keys(node).length <= 2) dsUids.add(node.uid)
    for (const v of Object.values(node)) collectDs(v)
  }
  if (dash !== null) collectDs(dash)
  const badDs = [...dsUids].filter((u) => u !== p?.uid)
  check(badDs.length === 0, '仪表盘里的 datasource uid 都指向该数据源', `多出来的 uid：${badDs.join(', ')}`)
}

const dp = tryYaml('ops/grafana/provisioning/dashboards/dashboards.yml')
if (dp.ok && dp.value !== null) {
  const providers = Array.isArray(dp.value.providers) ? dp.value.providers : []
  check(providers.length > 0, 'provisioning 里有仪表盘 provider', '没有 providers')
  const p = providers[0]
  check(typeof p?.options?.path === 'string' && p.options.path !== '', 'provider 配了仪表盘目录', JSON.stringify(p?.options))
  check(p?.type === 'file', 'provider 类型是 file', String(p?.type))
}

// ---- 4. 密钥扫描 ----------------------------------------------------------------------------
const TEXT = /\.(md|json|mjs|js|yml|yaml|txt)$/i
const files = []
const walkDir = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkDir(p)
    else if (TEXT.test(name)) files.push(p)
  }
}
walkDir(OPS)

const SECRET_PATTERNS = [
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, what: '疑似 Telegram 机器人令牌' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: '疑似 AWS key id' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, what: '疑似 GitHub 令牌' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, what: '疑似 API key' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: '私钥' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/, what: '疑似 Slack 令牌' },
]
const secretKeys = /^\s*(bot_token|auth_password|password|token|secret|api_key|credentials)\s*:\s*(\S+)\s*$/i
const secretHits = []
for (const p of files) {
  const rel = relative(ROOT, p).split(sep).join('/')
  const lines = readFileSync(p, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const { re, what } of SECRET_PATTERNS) if (re.test(line)) secretHits.push(`${rel}:${i + 1} ${what}`)
    const m = secretKeys.exec(line)
    if (m !== null && !m[1].toLowerCase().endsWith('_file')) {
      const v = m[2]
      const placeholder = v === "''" || v === '""' || v.startsWith('${') || v.startsWith('$') || v.startsWith('<') || v === 'null' || v === '~'
      if (!placeholder) secretHits.push(`${rel}:${i + 1} 明文 ${m[1]}`)
    }
  })
}
check(secretHits.length === 0, `扫了 ${files.length} 个文件，没有疑似真实密钥`, secretHits.join('; '))

// ---- 汇总 ----------------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} 项不通过（共 ${checks + failures} 项检查）`)
  process.exit(1)
}
console.log(`\nok    ops 配置自检通过（${checks} 项检查，${files.length} 个文件）`)
