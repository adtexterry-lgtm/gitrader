// SPDX-License-Identifier: CPAL-1.0
// docker/ 交付的离线结构校验（不联网、不需要 docker、不引第三方依赖）：
//   node docker/verify-docker.mjs
//
// 校验四件事：
//   1) Dockerfile 构建阶段 COPY 的仓库路径都存在，运行阶段只带 packages/cli/dist 与 LICENSE；--from=build 的源在构建产物目录；非 root；HEALTHCHECK 打 /api/ready
//   2) docker-compose.yml 引用的宿主文件 / 目录存在；服务、卷、profiles 结构齐；端口来自环境变量、每个服务的宿主侧缺省只绑回环；变量都有缺省或写进 .env.example
//   3) .env.example 只有端口 / 时区 / 日志级别 / 日志格式四类的键，没有密钥形状的名称或值
//   4) README 无禁词、无本机路径、无真实邮箱，且写清了起 / 停 / 升级 / 备份 / *_file 传密钥
//
// 它不是 YAML / Dockerfile 解析器：只按本交付的实际写法做结构断言（缩进两格的 service 块、单行指令），
// 换写法就要同步改这里。真正的运行时验证要在一台装了 docker 的机器上做（本标段没有）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
let ok = 0
let bad = 0
const fail = (msg) => { bad += 1; console.error(`FAIL  ${msg}`) }
const pass = (msg) => { ok += 1; console.log(`ok    ${msg}`) }
const check = (cond, msg) => { if (cond) pass(msg); else fail(msg) }
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const section = (t) => console.log(`\n== ${t}`)

// 构建阶段必须进上下文的输入（LICENSE / NOTICE 由 packages/cli/build.mjs 拷进包目录）。
const BUILD_INPUTS = ['package.json', 'package-lock.json', 'tsconfig.base.json', 'scripts', 'packages', 'assets', 'LICENSE', 'NOTICE']

// 密钥形状的键名赋值：允许 GF_SECURITY_ADMIN_PASSWORD__FILE 这类以 _FILE / __FILE 结尾的引用。
const SECRET_ASSIGN = /(?:^|[^A-Za-z0-9])([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|MNEMONIC|SEED|COOKIE))\s*[:=]\s*['"]?([^\s'"]+)/i
export function secretAssignOffenders(text) {
  const out = []
  for (const [i, line] of text.split('\n').entries()) {
    const m = SECRET_ASSIGN.exec(line)
    if (!m) continue
    const key = m[1] ?? ''
    if (/_+FILE$/.test(key)) continue
    out.push({ line: i + 1, key, value: m[2] ?? '' })
  }
  return out
}

// ---- 0. 文件齐 -------------------------------------------------------------------------
section('交付文件')
for (const f of ['Dockerfile', 'docker-compose.yml', '.env.example', 'README.md', 'verify-docker.mjs', 'secrets/README.md', 'secrets/.gitignore']) {
  check(existsSync(join(here, f)), `存在 docker/${f}`)
}
if (bad) { console.error('\n交付文件不齐，后面的校验没有意义。'); process.exit(1) }

const dockerfileText = read(join(here, 'Dockerfile'))
const composeText = read(join(here, 'docker-compose.yml'))
const envText = read(join(here, '.env.example'))
const readmeText = read(join(here, 'README.md'))
const readmeZh = read(join(here, 'README.zh-CN.md')) // 0.1.0 起：README.md 英文、README.zh-CN.md 中文

// ---- Dockerfile 指令（续行拼接，跳过整行注释）------------------------------------------
function instructions(text) {
  const out = []
  let buf = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!buf && (line === '' || line.startsWith('#'))) continue
    if (buf && line.startsWith('#')) continue
    buf = buf ? `${buf} ${line}` : line
    if (buf.endsWith('\\')) { buf = buf.slice(0, -1).trimEnd(); continue }
    out.push(buf)
    buf = ''
  }
  if (buf) out.push(buf)
  return out
}

// ---- 1. Dockerfile ---------------------------------------------------------------------
section('Dockerfile')
const ins = instructions(dockerfileText)
const froms = ins.filter((l) => /^FROM\s/i.test(l))
check(froms.length === 2, `两个阶段（实际 ${froms.length}）`)
check(froms.every((l) => /\bnode:22-alpine\b/.test(l)), '基础镜像都是 node:22-alpine')
const runtimeAt = ins.findIndex((l) => /^FROM\b/.test(l) && /\bAS\s+runtime\b/i.test(l))
check(runtimeAt > 0, '有 AS runtime 阶段')

// 普通 COPY 的源必须在仓库里存在；--from=build 的源是构建产物，干净检出时不存在，只断言它在
// `npm run build -w gitrader` 的产物目录（/src/packages/cli/dist）下。
const copyLines = ins.filter((l) => /^COPY\s/i.test(l))
const copies = []
for (const line of copyLines) {
  const at = ins.indexOf(line)
  const parts = line.replace(/^COPY\s+/i, '').split(/\s+/)
  const from = parts.map((t) => /^--from=(.+)$/i.exec(t)?.[1]).find(Boolean)
  const tokens = parts.filter((t) => !t.startsWith('--'))
  if (tokens.length < 2) { fail(`COPY 指令看不懂：${line}`); continue }
  const dest = tokens[tokens.length - 1]
  const stage = at > runtimeAt ? 'runtime' : 'build'
  for (const src of tokens.slice(0, -1)) {
    if (from) {
      if (from !== 'build') { fail(`COPY --from=${from}：只允许 --from=build`); continue }
      const allowed = '/src/packages/cli/dist'
      if (!(src === allowed || src.startsWith(`${allowed}/`))) {
        fail(`COPY --from=build 的源必须是 ${allowed}（或其下路径）：${src}`)
        continue
      }
      copies.push({ src, dest, rel: src.replace(/^\/src\//, ''), stage, from })
      continue
    }
    // 构建阶段的工作目录是 /src，运行阶段是 /app；复制源只在构建阶段有意义。
    const rel = src.replace(/^\.\//, '').replace(/^\/src\//, '')
    if (src === '.' || rel === '') { copies.push({ src, dest, rel: '.', stage }); continue }
    if (src.startsWith('/') && !src.startsWith('/src/')) { fail(`COPY 用了绝对路径 ${src}（改成相对仓库根的路径，或 /src/ 前缀）`); continue }
    const abs = join(repo, rel)
    copies.push({ src, dest, rel, stage })
    check(existsSync(abs), `COPY 源存在：${src}${existsSync(abs) ? '' : ` → 期望 ${abs}`}`)
  }
}
check(copies.some((c) => c.rel === 'package-lock.json'), 'COPY 了 package-lock.json（npm ci 要它）')
check(copies.some((c) => c.rel === 'packages'), 'COPY 了 packages/（npm ci 要全部工作区清单）')

// 构建阶段的 COPY 要覆盖全部必需输入
for (const req of BUILD_INPUTS) {
  const covered = copies.some((c) => c.stage === 'build' && !c.from && (c.rel === req || c.rel.startsWith(`${req}/`)))
  check(covered, `构建阶段 COPY 覆盖 ${req}`)
}

// 运行阶段只带 packages/cli/dist（bin.js / gitrader-mcp.js / engine-core.mjs / workbench/）+ 根 LICENSE
const runtimeCopies = copies.filter((c) => c.stage === 'runtime' && c.rel !== '.')
const ALLOWED_RUNTIME = [/^packages\/cli\/dist(\/|$)/, /^LICENSE$/]
for (const c of runtimeCopies) {
  check(ALLOWED_RUNTIME.some((re) => re.test(c.rel)), `运行阶段只复制允许的产物：${c.rel}`)
}
check(runtimeCopies.length >= 2, `运行阶段复制了 ${runtimeCopies.length} 项（packages/cli/dist + LICENSE）`)
check(!runtimeCopies.some((c) => /\/(src|test)(\/|$)/.test(c.rel)), '运行阶段没有源码 / 测试目录')
check(/GITRADER_ENGINE_CORE_BUNDLE=\/app\/packages\/cli\/dist\/engine-core\.mjs/.test(dockerfileText), 'ENV GITRADER_ENGINE_CORE_BUNDLE 指向 packages/cli/dist/engine-core.mjs')

// 构建步骤
check(ins.some((l) => /^RUN\b/.test(l) && /\bnpm ci\b(?!\s*--)/.test(l)), 'RUN npm ci')
check(ins.some((l) => /^RUN\b/.test(l) && /npm run build -w gitrader/.test(l)), 'RUN npm run build -w gitrader（cli 的构建脚本产出 bin.js / 工作台 / 引擎）')

// 安全与运行约定
const userLines = ins.filter((l) => /^USER\s/i.test(l))
check(userLines.length > 0 && !/^USER\s+(root|0)(:|$)/i.test(userLines[userLines.length - 1]), `非 root 运行（${userLines[userLines.length - 1] ?? '缺 USER'}）`)
check(/GITRADER_HOME=\/data/.test(dockerfileText), 'ENV GITRADER_HOME=/data')
const health = ins.find((l) => /^HEALTHCHECK\b/i.test(l))
check(!!health, '有 HEALTHCHECK')
check(!!health && health.includes('/api/ready'), 'HEALTHCHECK 打 /api/ready')
check(!!health && health.includes('service.json'), 'HEALTHCHECK 从 service.json 取令牌（/api/ready 要 Bearer）')
check(!!health && !/echo |console\.log/.test(health), 'HEALTHCHECK 不打印令牌')
check(ins.some((l) => /^EXPOSE\s+\d+/.test(l)), '有 EXPOSE')
const entry = ins.find((l) => /^ENTRYPOINT\b/i.test(l))
check(!!entry && entry.includes('packages/cli/dist/bin.js'), 'ENTRYPOINT 指向 packages/cli/dist/bin.js')
check(!!entry && /\bserve\b/.test(entry), 'ENTRYPOINT 跑 serve')
check(!!entry && /GITRADER_PORT/.test(entry), '入口的端口来自 GITRADER_PORT')
check(!!entry && /\bexec\b/.test(entry), '入口用 exec（信号能到 node）')
check(!/^\s*ADD\s+http/im.test(dockerfileText), '没有 ADD 远程 URL')
check(!/COPY[^\n]*\.env/i.test(dockerfileText), '镜像里不带 .env')

// ---- 1b. docker/Dockerfile.dockerignore -------------------------------------------------
section('docker/Dockerfile.dockerignore')
const ignorePath = join(here, 'Dockerfile.dockerignore')
check(existsSync(ignorePath), '存在 docker/Dockerfile.dockerignore（BuildKit 与 Dockerfile 同名的忽略文件）')
if (existsSync(ignorePath)) {
  const rules = read(ignorePath).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  const REQUIRED_IGNORES = ['.git', '**/node_modules', '**/dist', 'dist-portable', 'dist-store', 'reports', 'before-r1', '**/before-r1', 'coverage', '**/test-out', '**/*.tgz', '**/.env', '**/.env.*', 'docker/secrets']
  for (const rule of REQUIRED_IGNORES) check(rules.includes(rule), `忽略规则含 ${rule}`)
  const UNIVERSAL = new Set(['*', '**', '**/*', '/'])
  const violating = []
  for (const rule of rules) {
    if (rule.startsWith('!')) continue
    const norm = rule.replace(/^\.\//, '').replace(/\/+$/, '')
    if (UNIVERSAL.has(norm) || BUILD_INPUTS.includes(norm)) violating.push(rule)
  }
  check(violating.length === 0, `忽略规则没有排除必需输入${violating.length ? `：${violating.join(', ')}` : ''}`)
}

// ---- 2. docker-compose.yml -------------------------------------------------------------
section('docker-compose.yml')
const composeLines = composeText.split('\n')
const code = composeLines.filter((l) => !l.trim().startsWith('#'))

function serviceBlock(name) {
  const start = code.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l))
  if (start < 0) return null
  const out = []
  for (let i = start + 1; i < code.length; i++) {
    const l = code[i]
    if (l.trim() !== '' && /^ {0,2}\S/.test(l)) break
    out.push(l)
  }
  return out.join('\n')
}

function servicesBlock() {
  const start = code.findIndex((l) => /^services:\s*$/.test(l))
  if (start < 0) return ''
  const out = []
  for (let i = start + 1; i < code.length; i++) {
    if (/^\S/.test(code[i])) break
    out.push(code[i])
  }
  return out.join('\n')
}

// 一个服务块里的每条 ports 映射（去掉引号，形如 hostIP:hostPort:containerPort）。
function portsOf(block) {
  const out = []
  let indent = -1
  for (const line of block.split('\n')) {
    const head = /^(\s*)ports:\s*$/.exec(line)
    if (head) { indent = (head[1] ?? '').length; continue }
    if (indent < 0) continue
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const current = (line.match(/^\s*/)?.[0] ?? '').length
    if (current <= indent) { indent = -1; continue }
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item) out.push((item[1] ?? '').trim().replace(/^['"]|['"]$/g, ''))
  }
  return out
}

const HOST_LOOPBACK = /^(?:127\.0\.0\.1:|\$\{[A-Z_][A-Z0-9_]*:-127\.0\.0\.1\}:)/
export function isLoopbackBinding(mapping) {
  return HOST_LOOPBACK.test(mapping.trim().replace(/^['"]|['"]$/g, ''))
}
export function hostBindOffenders(text) {
  const lines = text.split('\n').filter((l) => !l.trim().startsWith('#'))
  const start = lines.findIndex((l) => /^services:\s*$/.test(l))
  if (start < 0) return []
  const serviceLines = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    serviceLines.push(lines[i])
  }
  const names = serviceLines.filter((l) => /^ {2}[a-z][a-z0-9-]*:\s*$/.test(l)).map((l) => l.trim().replace(/:$/, ''))
  const out = []
  for (const name of names) {
    const at = serviceLines.findIndex((l) => new RegExp(`^ {2}${name}:\\s*$`).test(l))
    if (at < 0) continue
    const block = []
    for (let i = at + 1; i < serviceLines.length; i++) {
      const l = serviceLines[i]
      if (l.trim() !== '' && /^ {0,2}\S/.test(l)) break
      block.push(l)
    }
    for (const mapping of portsOf(block.join('\n'))) {
      if (!isLoopbackBinding(mapping)) out.push({ service: name, mapping })
    }
  }
  return out
}
const servicesText = servicesBlock()
const services = servicesText.split('\n').filter((l) => /^ {2}[a-z][a-z0-9-]*:\s*$/.test(l)).map((l) => l.trim().replace(/:$/, ''))
check(services.includes('gitrader'), `有 gitrader 服务（服务：${services.join(', ')}）`)
const main = serviceBlock('gitrader') ?? ''
check(/dockerfile: docker\/Dockerfile/.test(main), '构建用 docker/Dockerfile')
check(/context: \.\./.test(main), '构建上下文是仓库根（..）')
check(/gitrader-data:\/data/.test(main), '挂具名卷 gitrader-data 到 /data')
check(/GITRADER_HOME: \/data/.test(main), 'GITRADER_HOME=/data')
check(/\$\{GITRADER_PORT:-/.test(main), '端口来自环境变量 GITRADER_PORT（有缺省）')
check(/\$\{GITRADER_BIND:-127\.0\.0\.1\}/.test(main), '缺省只发布到 127.0.0.1')
check(!/^ {4}healthcheck:/m.test(main), '不覆盖镜像的 HEALTHCHECK（不写第二份探针）')
check(/cap_drop:\s*\n\s+- ALL/.test(main), 'cap_drop: ALL')
check(/no-new-privileges:true/.test(composeText), 'no-new-privileges')

// 每个服务的每条 ports 映射，宿主侧地址缺省必须是 127.0.0.1（字面或 ${变量:-127.0.0.1}）。
for (const name of services) {
  const mappings = portsOf(serviceBlock(name) ?? '')
  check(mappings.length > 0, `${name} 有 ports 映射`)
  for (const mapping of mappings) check(isLoopbackBinding(mapping), `${name} 的端口映射缺省只绑回环：${mapping}`)
}
const bindOffenders = hostBindOffenders(composeText)
check(bindOffenders.length === 0, `每个服务的宿主侧端口缺省都是 127.0.0.1${bindOffenders.length ? `（${bindOffenders.map((o) => `${o.service}=${o.mapping}`).join(', ')}）` : ''}`)

for (const name of ['prometheus', 'alertmanager', 'grafana']) {
  const block = serviceBlock(name)
  check(!!block, `有 ${name} 服务`)
  check(!!block && /profiles: \[observability\]/.test(block), `${name} 挂在 profiles: [observability]`)
}
check(code.some((l) => /^volumes:\s*$/.test(l)) && /^ {2}gitrader-data:\s*$/m.test(composeText), '声明了卷 gitrader-data')
check(/^networks:\s*$/m.test(composeText), '声明了 networks')
check(!/^ {4}network_mode: host\s*$/m.test(composeText), '没有默认开 network_mode: host')

// compose 引用的宿主机文件 / 目录必须存在（相对 docker/）
const bindRefs = new Set()
for (const l of code) {
  const m = /^\s*-\s+(\.\.?\/[^\s:]+):/.exec(l)
  if (m) bindRefs.add(m[1])
}
check(bindRefs.size >= 5, `compose 引用的宿主路径 ${bindRefs.size} 条`)
for (const rel of bindRefs) {
  const abs = resolve(here, rel)
  const exists = existsSync(abs)
  check(exists, `引用路径存在：${rel}${exists ? '' : ` → 期望 ${abs}`}`)
  if (exists && rel.includes('ops/')) check(statSync(abs).isFile() || statSync(abs).isDirectory(), `引用路径可读：${rel}`)
}
check([...bindRefs].some((r) => r.includes('ops/prometheus/prometheus.yml')), '挂仓库里的 ops/prometheus/prometheus.yml')
check([...bindRefs].some((r) => r.includes('ops/alertmanager/alertmanager.yml')), '挂仓库里的 ops/alertmanager/alertmanager.yml')
check([...bindRefs].some((r) => r.includes('ops/grafana/')), '挂仓库里的 ops/grafana/')

// 变量：无缺省的必须写进 .env.example
const envKeys = new Set(
  envText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => l.split('=')[0].trim()),
)
const varRe = /\$\{([A-Z_][A-Z0-9_]*)(:\?|-|:)?[^}]*\}/g
const missing = new Set()
for (const l of code) {
  for (const m of l.matchAll(varRe)) {
    const [, name, kind] = m
    if (kind === undefined && !envKeys.has(name)) missing.add(name)
  }
}
check(missing.size === 0, `无缺省又没有写进 .env.example 的变量：${missing.size ? [...missing].join(', ') : '无'}`)

// ---- 3. .env.example -------------------------------------------------------------------
section('.env.example')
const ALLOWED_ENV = new Set(['GITRADER_PORT', 'GITRADER_BIND', 'TZ', 'GITRADER_LOG_LEVEL', 'GITRADER_LOG_FORMAT'])
const envPairs = envText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } })
check(envPairs.length > 0, `.env.example 有 ${envPairs.length} 个键`)
const secretName = /(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE|MNEMONIC|SEED|CREDENTIAL|COOKIE)/i
for (const { key, value } of envPairs) {
  check(ALLOWED_ENV.has(key), `${key} 在允许的键里（只有端口 / 时区 / 日志级别 / 日志格式）`)
  check(!secretName.test(key), `${key} 不是密钥形状的键名`)
  check(!/^[A-Za-z0-9+/=_-]{24,}$/.test(value), `${key} 的值不是长令牌形状`)
  check(value.length <= 64, `${key} 的值不长于 64 字符`)
}
check(/GITRADER_PORT=/.test(envText), '端口 GITRADER_PORT')
check(/TZ=/.test(envText), '时区 TZ')
check(/GITRADER_LOG_LEVEL=/.test(envText), '日志级别 GITRADER_LOG_LEVEL')
check(/GITRADER_LOG_FORMAT=/.test(envText), '日志格式 GITRADER_LOG_FORMAT')
check(!/^(GITRADER_AGENT_TOKEN|.*_TOKEN|.*_SECRET|.*_PASSWORD)=/m.test(envText), '.env.example 没有 *_TOKEN / *_SECRET / *_PASSWORD')

// ---- 4. README -------------------------------------------------------------------------
section('README.md')
// 禁词（总则）与 check-public.mjs 的产品文案禁词
const BANNED = ['保守', '激进', '稳赚', '跑赢', '稳定盈利', '保证收益', '零风险', 'risk-free', 'guaranteed', '帮你赚钱', 'Confy', 'WalletConnect']
for (const w of BANNED) {
  const hit = (readmeText + readmeZh).toLowerCase().includes(w.toLowerCase())
  check(!hit, `无禁词「${w}」`)
}
const LOCAL_PATH = [
  /\b[A-Za-z]:[\\/]+Users[\\/]+/i,
  /\b[A-Za-z]:[\\/]+(UNIGIT|gitrader)\b/i,
  /\/Users\/[a-z0-9._-]+\//i,
  /\/home\/[a-z0-9._-]+\//i,
]
for (const re of LOCAL_PATH) check(!re.test(readmeText + readmeZh), `无本机路径（${re}）`)
check(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(readmeText + readmeZh), '无真实邮箱')

const README_TOPICS = [
  ['起', /docker compose up -d/],
  ['停', /docker compose down/],
  ['升级', /## Upgrade[\s\S]{0,400}docker compose build/, /升级[\s\S]{0,400}docker compose build/],
  ['备份', /## Back up[\s\S]{0,600}tar czf/, /备份[\s\S]{0,600}tar czf/],
  ['密钥走 *_file', /credentials_file|_FILE|bot_token_file/],
  ['缺省只绑回环', /127\.0\.0\.1/],
  ['就绪探针', /\/api\/ready/],
  ['数据目录', /\/data/],
]
for (const [name, re, reZh = re] of README_TOPICS) check(re.test(readmeText) && reZh.test(readmeZh), `README（中英）写了：${name}`)
// 如实写验证范围：发布前真容器实跑 + 本脚本只做离线结构校验
check(/offline structural/.test(readmeText) && /离线结构校验/.test(readmeZh), 'README（中英）说明了验证范围')

// 本目录的任何文件里都不该出现密钥值形状的赋值（_FILE / __FILE 引用放行）
section('整套文件')
for (const f of ['Dockerfile', 'docker-compose.yml', '.env.example', 'README.md']) {
  const hits = secretAssignOffenders(read(join(here, f)))
  check(hits.length === 0, `${f} 里没有密钥值赋值${hits.length ? `（${hits.map((h) => h.key).join(', ')}）` : ''}`)
}

// ---- 汇总 -----------------------------------------------------------------------------
console.log(`\n${ok} 项通过，${bad} 项失败（${copyLines.length} 条 COPY，${bindRefs.size} 条宿主挂载，${envPairs.length} 个环境变量键）`)
process.exitCode = bad ? 1 : 0
