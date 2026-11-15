// SPDX-License-Identifier: CPAL-1.0
// 公开发布就绪校验（CI 与首发前都跑，离线，只用 Node 标准库）：
//   node tools/release/verify-public-readiness.mjs
// 校验内容：
//   1. .github/workflows/ci.yml 里每条 `npm run <脚本>` / `node <路径>` 在仓库里真实存在（含 `-w <工作区>` 的脚本）；
//      CI 用 `npm ci`（不是 npm install）、Node 22 在矩阵里、缓存 npm、push 与 pull_request 都触发。
//   2. 四个根文档（CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / CHANGELOG）存在、非空、无禁词、无本机路径、无真实邮箱。
//   3. 发布面结构在位：PR 模板三条自检、两个 Issue 模板、README 的「安装与文档」三个入口、CHANGELOG 按日期分组。
// 退出码：0 全过；1 有失败项（逐条打印原因）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const failures = []
const notes = []
const fail = (msg) => { failures.push(msg); console.error(`FAIL  ${msg}`) }
const ok = (msg) => console.log(`ok    ${msg}`)
const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const read = (p) => readFileSync(p, 'utf8')

// ---- 工作区索引（根 package.json 的 workspaces 是 packages/*，不展开 glob 之外的花样）--------------------
function loadJson(p) {
  try { return JSON.parse(read(p)) } catch { return null }
}
const rootPkg = loadJson(join(root, 'package.json'))
if (!rootPkg) fail('根 package.json 读不出来')
const workspaces = new Map() // 包名 -> { dir, scripts }
for (const pattern of rootPkg?.workspaces ?? []) {
  const base = pattern.replace(/\/\*$/, '')
  const dir = join(root, base)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    const pkgPath = join(dir, name, 'package.json')
    const pkg = isFile(pkgPath) ? loadJson(pkgPath) : null
    if (pkg?.name) workspaces.set(pkg.name, { dir: join(dir, name), scripts: pkg.scripts ?? {} })
  }
}

// ---- 1) ci.yml -----------------------------------------------------------------------------------
const ciPath = join(root, '.github', 'workflows', 'ci.yml')
if (!isFile(ciPath)) fail('.github/workflows/ci.yml 不存在')
const ci = isFile(ciPath) ? read(ciPath) : ''

// 取出所有 run: 步骤的命令行（内联 YAML 标量与 | / > 块都支持）
function runCommands(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const indent = m[1].length
    const value = m[2].trim().replace(/^['"]|['"]$/g, '')
    if (value !== '|' && value !== '>' && value !== '|-' && value !== '>-' && value !== '') {
      out.push(value)
      continue
    }
    const block = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.trim() === '') { block.push(''); continue }
      const lineIndent = /^(\s*)/.exec(line)[1].length
      if (lineIndent <= indent) break
      block.push(line.trim())
      i = j
    }
    out.push(block.filter(Boolean).join('\n'))
  }
  return out
}

const ciCommands = ci ? runCommands(ci) : []
const flat = ciCommands.flatMap((c) => c.split(/\r?\n/)).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
if (flat.length === 0) fail('ci.yml 里没有解析出任何 run: 命令（格式变了？）')

for (const cmd of flat) {
  // npm run <脚本> [-w <工作区>]
  for (const m of cmd.matchAll(/\bnpm run ([A-Za-z0-9:._-]+)/g)) {
    const script = m[1]
    const wsMatch = /\s-w\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(cmd)
    if (wsMatch) {
      const wsArg = wsMatch[2] ?? wsMatch[3] ?? wsMatch[4]
      const ws = wsArg.includes('/')
        ? { dir: join(root, wsArg), scripts: (isFile(join(root, wsArg, 'package.json')) ? loadJson(join(root, wsArg, 'package.json'))?.scripts ?? null : null) }
        : workspaces.get(wsArg) ?? null
      if (!ws || !ws.scripts) fail(`ci.yml 的 \`npm run ${script} -w ${wsArg}\`：工作区 ${wsArg} 找不到或没有 package.json`)
      else if (!Object.hasOwn(ws.scripts, script)) fail(`ci.yml 的 \`npm run ${script} -w ${wsArg}\`：该工作区没有这个脚本`)
      else ok(`npm run ${script} -w ${wsArg}（${wsArg.includes('/') ? wsArg : '包 ' + wsArg}）`)
      continue
    }
    if (!Object.hasOwn(rootPkg?.scripts ?? {}, script)) fail(`ci.yml 的 \`npm run ${script}\`：根 package.json 没有这个脚本`)
    else ok(`npm run ${script}（根）`)
  }
  // npm test / npm ci
  if (/\bnpm test\b/.test(cmd) && !Object.hasOwn(rootPkg?.scripts ?? {}, 'test')) fail('ci.yml 用了 `npm test`，根 package.json 没有 test 脚本')
  if (/\bnpm install\b/.test(cmd)) fail(`ci.yml 用了 \`npm install\`，CI 必须是 \`npm ci\`（${cmd}）`)
  // node <路径>
  for (const m of cmd.matchAll(/(?:^|\s)node\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    const target = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (!target || target.startsWith('-') || !/\.[cm]?[jt]s$/.test(target)) continue
    if (!target.startsWith('.')) {
      if (!isFile(join(root, target))) fail(`ci.yml 的 \`node ${target}\`：文件不存在`)
      else ok(`node ${target}`)
    }
  }
}
if (ci && !/\bnpm ci\b/.test(ci)) fail('ci.yml 没有 `npm ci`')
else if (ci) ok('ci.yml 用 npm ci')
if (ci && !/node-version:[\s\S]{0,80}\b22\b/.test(ci) && !/\bnode:\s*\[[^\]]*\b22\b/.test(ci)) fail('ci.yml 的 Node 矩阵里没有 22')
else if (ci) ok('ci.yml 的 Node 矩阵含 22')
if (ci && !/cache:\s*npm/.test(ci)) fail('ci.yml 的 setup-node 没有 `cache: npm`')
else if (ci) ok('ci.yml 缓存 npm')
if (ci && !/^\s{2}push:/m.test(ci)) fail('ci.yml 没有 push 触发')
if (ci && !/^\s{2}pull_request:/m.test(ci)) fail('ci.yml 没有 pull_request 触发')
if (ci && /^\s{2}push:/m.test(ci) && /^\s{2}pull_request:/m.test(ci)) ok('ci.yml 只在 push / pull_request 触发')

// ---- 2) 四个根文档：存在 + 文本卫生 ---------------------------------------------------------------
const docs = ['CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md']
const BANNED = [['Com', 'fy'], ['Wallet', 'Connect'], ['保', '守'], ['激', '进'], ['稳', '赚'], ['跑', '赢']]
  .map((parts) => new RegExp(parts.join(''), 'i'))
// 本机路径：不写死任何开发机目录，用字符类拼出来（示例占位用户名放行）
const PLACEHOLDER = '(?!(?:you|You|someone|Some One|user|username|name|example|runner|me)[\\\\/])'
const LOCAL_PATHS = [
  /\b[A-Za-z]:[\\/][^\s"'`|]+/,
  new RegExp(`/Users/${PLACEHOLDER}[A-Za-z0-9._-]+/`),
  new RegExp(`/home/${PLACEHOLDER}[A-Za-z0-9._-]+/`),
]
const EMAIL = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g
const EMAIL_PLACEHOLDER = /(example\.(com|org|net)|users\.noreply\.github\.com|noreply@)/i
const scanned = [...docs, 'README.md']
for (const name of docs) {
  const p = join(root, name)
  if (!isFile(p)) { fail(`根文档缺失：${name}`); continue }
  const text = read(p)
  if (text.trim().length < 200) fail(`${name} 内容过短（${text.trim().length} 字符），像是占位`)
  else ok(`${name} 存在（${text.length} 字符）`)
  scanText(name, text)
}
if (isFile(join(root, 'README.md'))) scanText('README.md', read(join(root, 'README.md')))
else fail('根 README.md 不存在')

function scanText(name, text) {
  for (const re of BANNED) {
    const hit = re.exec(text)
    if (hit) fail(`${name}: 产品文案禁词 ${JSON.stringify(hit[0])}`)
  }
  for (const re of LOCAL_PATHS) {
    const hit = re.exec(text)
    if (hit) fail(`${name}: 本机路径 ${JSON.stringify(hit[0])}`)
  }
  for (const m of text.matchAll(EMAIL)) {
    if (!EMAIL_PLACEHOLDER.test(m[0])) fail(`${name}: 疑似真实邮箱 ${m[0]}`)
  }
}

// ---- 3) 发布面结构 -------------------------------------------------------------------------------
const prPath = join(root, '.github', 'PULL_REQUEST_TEMPLATE.md')
if (!isFile(prPath)) fail('.github/PULL_REQUEST_TEMPLATE.md 缺失')
else {
  const pr = read(prPath)
  const checks = [
    ['零承诺语言', /零承诺语言/],
    ['不改协议冻结字段', /协议冻结字段|不改协议冻结字段/],
    ['测试只增不减', /测试只增不减/],
  ]
  for (const [label, re] of checks) {
    if (re.test(pr)) ok(`PR 模板含自检：${label}`)
    else fail(`PR 模板缺自检：${label}`)
  }
}
for (const name of ['bug.md', 'feature.md']) {
  const p = join(root, '.github', 'ISSUE_TEMPLATE', name)
  if (!isFile(p)) fail(`Issue 模板缺失：.github/ISSUE_TEMPLATE/${name}`)
  else ok(`Issue 模板 .github/ISSUE_TEMPLATE/${name}`)
}
const readmePath = join(root, 'README.md')
if (isFile(readmePath)) {
  const readme = read(readmePath)
  // 0.1.0 起 README.md 是英文、README.zh-CN.md 是中文：各自有「安装」一节，并各自链到本语言的 Docker 说明与用户文档
  const zhPath = join(root, 'README.zh-CN.md')
  const zh = isFile(zhPath) ? read(zhPath) : ''
  for (const [name, text, heading, entries] of [
    ['README.md', readme, /^## Install\s*$/m, ['tools/portable/README.md', 'docker/README.md', 'docs/user/en/README.md']],
    ['README.zh-CN.md', zh, /^## 安装\s*$/m, ['tools/portable/README.md', 'docker/README.zh-CN.md', 'docs/user/README.md']],
  ]) {
    if (!heading.test(text)) fail(`${name} 缺安装一节`)
    else ok(`${name} 有安装一节`)
    for (const entry of entries) {
      if (!text.includes(entry)) fail(`${name} 缺入口：${entry}`)
      else ok(`${name} 入口：${entry}`)
    }
  }
}
// CODE_OF_CONDUCT：来源与许可
if (isFile(join(root, 'CODE_OF_CONDUCT.md'))) {
  const coc = read(join(root, 'CODE_OF_CONDUCT.md'))
  if (!/Contributor Covenant/i.test(coc)) fail('CODE_OF_CONDUCT.md 没写来源（Contributor Covenant）')
  else ok('CODE_OF_CONDUCT.md 注明来源 Contributor Covenant')
  if (!/CC BY 4\.0|Creative Commons Attribution 4\.0/i.test(coc)) fail('CODE_OF_CONDUCT.md 没写许可证（CC BY 4.0）')
  else ok('CODE_OF_CONDUCT.md 注明许可证 CC BY 4.0')
}
// SECURITY：指向 docs/security.md 与私密渠道
if (isFile(join(root, 'SECURITY.md'))) {
  const sec = read(join(root, 'SECURITY.md'))
  if (!sec.includes('docs/security.md')) fail('SECURITY.md 没有指向 docs/security.md')
  else ok('SECURITY.md 指向 docs/security.md')
  if (!/Report a vulnerability|advisories\/new/.test(sec)) fail('SECURITY.md 没写漏洞上报渠道')
  else ok('SECURITY.md 写了上报渠道')
}
// CHANGELOG：按日期分组；标题能在 git log 里对上（浅克隆 / 无 git 时只提示）
if (isFile(join(root, 'CHANGELOG.md'))) {
  const log = read(join(root, 'CHANGELOG.md'))
  const dates = [...log.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => m[1])
  if (dates.length === 0) fail('CHANGELOG.md 没有按日期分组的小节（## YYYY-MM-DD）')
  else ok(`CHANGELOG.md 有 ${dates.length} 个日期小节（${dates.join(' / ')}）`)
  const bullets = [...log.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim())
  if (bullets.length < 5) fail(`CHANGELOG.md 只有 ${bullets.length} 条记录，像占位`)
  let subjects = null
  try {
    subjects = execFileSync('git', ['log', '--pretty=%s'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  } catch { /* 不是 git 仓库或没有 git：只提示 */ }
  if (subjects && subjects.length > dates.length) {
    const missing = bullets.filter((b) => !subjects.includes(b))
    if (missing.length) fail(`CHANGELOG.md 有 ${missing.length} 条标题在 git log 里找不到（例：${missing[0].slice(0, 60)}）`)
    else ok(`CHANGELOG.md 的 ${bullets.length} 条标题与 git log 逐条对上`)
  } else notes.push('git 历史不可用或不完整（浅克隆）：跳过 CHANGELOG 与 git log 的逐条对账')
}

// ---- 结果 ----------------------------------------------------------------------------------------
for (const n of notes) console.log(`note  ${n}`)
if (failures.length) {
  console.error(`\n${failures.length} 项不通过（公开发布未就绪）`)
  process.exit(1)
}
console.log('\nok    公开发布就绪：CI 命令全部可解析、根文档与模板在位、文本卫生通过')
