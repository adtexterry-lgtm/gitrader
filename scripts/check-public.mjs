// SPDX-License-Identifier: CPAL-1.0
// 公开仓库卫生检查（CI 与首发前都跑）：
//   node scripts/check-public.mjs                      内部施工记录不在公开文件里 + 本机路径 / 禁词 / 邮箱 / 密钥形 / 私有禁词表扫描
//   node scripts/check-public.mjs --notices A B        两份 THIRD-PARTY-NOTICES.md 除"生成日期"行外必须一致（CI：构建前后各一份）
//   node scripts/check-public.mjs --pack FILE           `npm pack --dry-run --json` 的输出：包里只有 dist/ 与随包文档，没有 test / map / 内部记录
// 私有禁词表：环境变量 GITRADER_PRIVATE_DENYLIST 指向仓库外的文件，每行 `hard|soft<TAB>正则`。
//   hard 命中 = FAIL；soft 命中 = WARN（只列文件:行）。没有这个文件时打印 skip 并继续。
// 密钥形：只报告文件:行，绝不打印匹配到的原文；三处公开测试向量/链上常量按「文件 + 行号 + 行哈希」精确放行。
// 文件清单取 `git ls-files`（CI 的干净检出）；没有 git 仓库时（本地还没初始化）回退为遍历目录，并按 .gitignore 的内部记录规则跳过。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let failures = 0
const fail = (msg) => { failures += 1; console.error(`FAIL  ${msg}`) }
const warn = (msg) => { console.log(`WARN  ${msg}`) }
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)

// ---- 模式 2：第三方声明一致 ----------------------------------------------------------------
if (args[0] === '--notices') {
  const strip = (p) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('生成日期：')).join('\n')
  if (strip(args[1]) !== strip(args[2])) {
    fail(`THIRD-PARTY-NOTICES.md 过期：构建后与仓库里的不一致（${args[1]} vs ${args[2]}）。运行 npm run build -w gitrader 重新生成并提交。`)
  } else console.log('ok    THIRD-PARTY-NOTICES.md 与构建结果一致')
  process.exit(failures ? 1 : 0)
}

// ---- 模式 3：npm 包清单（npm pack --dry-run --json 的输出）----------------------------------------
if (args[0] === '--pack') {
  const files = JSON.parse(readFileSync(resolve(args[1]), 'utf8'))[0].files.map((f) => f.path)
  console.log(files.join('\n'))
  const allowed = (p) => /^(dist\/|README\.md$|LICENSE$|NOTICE$|THIRD-PARTY-NOTICES\.md$|package\.json$)/.test(p)
  for (const p of files) {
    if (!allowed(p) || /\.map$/.test(p) || /(^|\/)(test|before-r1|reports)(\/|$)/.test(p) || /(^|\/)CHANGES\.md$/.test(p)) fail(`npm 包里不该有：${p}`)
  }
  for (const need of ['dist/bin.js', 'dist/gitrader-mcp.js', 'dist/engine-core.mjs', 'dist/workbench/index.html', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) if (!files.includes(need)) fail(`npm 包里缺：${need}`)
  if (!failures) console.log('ok    npm 包清单符合预期')
  process.exit(failures ? 1 : 0)
}

// ---- 私有禁词表 ------------------------------------------------------------------------------
// 公开脚本里不写任何内部代号本身；词表只在运行时从仓库外读入。
const PRIVATE_PATH = process.env.GITRADER_PRIVATE_DENYLIST
const PRIVATE = []
if (PRIVATE_PATH && existsSync(PRIVATE_PATH)) {
  for (const raw of readFileSync(PRIVATE_PATH, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    if (!raw || raw.startsWith('#')) continue
    const tab = raw.indexOf('\t')
    if (tab < 0) continue
    const level = raw.slice(0, tab).trim()
    const pattern = raw.slice(tab + 1)
    if (level !== 'hard' && level !== 'soft') continue
    if (!pattern) continue
    try {
      PRIVATE.push({ level, re: new RegExp(pattern) })
    } catch {
      fail(`私有禁词表第 ${PRIVATE.length + 1} 行不是合法正则`)
    }
  }
  console.log(`private denylist: ${PRIVATE.length} rules from GITRADER_PRIVATE_DENYLIST`)
} else {
  console.log('SKIP: private denylist not configured (GITRADER_PRIVATE_DENYLIST)')
}

// ---- 文件清单 --------------------------------------------------------------------------------
// 内部施工记录：不进公开仓库（与 .gitignore 同一份规则）
const INTERNAL = [
  /^before-r1\//, /(^|\/)before-r1\//, /^reports\//, /^dist-store\//, /(^|\/)CHANGES\.md$/, /(^|\/)test-out\//, /\.tgz$/, /\.map$/,
]
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage'])
function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return { files: out.split('\0').filter(Boolean), source: 'git ls-files' }
  } catch { /* 不是 git 仓库 */ }
  const files = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue
      const p = join(d, name)
      const rel = relative(root, p).split(sep).join('/')
      if (statSync(p).isDirectory()) { if (!INTERNAL.some((re) => re.test(`${rel}/`))) walk(p) } else if (!INTERNAL.some((re) => re.test(rel))) files.push(rel)
    }
  }
  walk(root)
  return { files, source: 'directory walk (no git repository; internal records skipped by rule)' }
}
const { files, source } = listFiles()
console.log(`scanning ${files.length} files via ${source}`)

// 1) 内部施工记录不得出现在公开文件清单里
for (const f of files) if (INTERNAL.some((re) => re.test(f))) fail(`内部施工记录 / 生成物不应公开：${f}`)
// 临时探针测试（zz-*.test.ts）是施工现场的草稿，首发前删掉
for (const f of files) if (/(^|\/)zz-[^/]*\.test\.ts$/.test(f)) fail(`临时探针测试不应公开：${f}`)

// 2) 文本扫描
const TEXT = /\.(md|json|mjs|js|ts|tsx|jsx|yml|yaml|txt|html|css|svg|toml)$/i
const frag = (...p) => p.join('')
// 本机路径：开发机的具体目录一律不许；示例里的占位用户名（Some One / someone / you / user ...）放行
const PH = '(?!(?:Some One|someone|you|user|username|name|example|runner|me)[\\\\/])'
// 盘符形态：任意盘符 + 开发机目录名；WSL/Git Bash 形态：/<单字母盘>/<目录名>。
// 产品文档里的 C:/engines、D:/data 这类示例不是本机目录，不在此列。
const LOCAL_PATH = [
  new RegExp(`\\b[A-Za-z]:[\\\\/]+(?:Users|gitrader|Gitrader|ops)\\b`),
  /\B\/[a-z]\/(?:Users|gitrader|home|ops)\b/,
  new RegExp(`\\b[A-Za-z]:[\\\\/]+Users[\\\\/]+${PH}[^\\\\/\\s"']+`, 'i'),
  // 大小写敏感：macOS 真实路径是 /Users/<名字>/（首字母大写）；小写的 /users/self/ 是交易所 API 路径（如 OKX 登录签名），self 也放行
  new RegExp(`/Users/${PH}(?!self/)[A-Za-z0-9._-]+/`),
  new RegExp(`/home/${PH}[a-z0-9._-]+/`, 'i'),
]
// 禁词只扫产品文案：源码、schema、文档、README、集成说明（构建门禁脚本里的正则字面量不算）
const BANNED = [new RegExp(frag('Com', 'fy'), 'i'), new RegExp(frag('Wallet', 'Connect'), 'i'), new RegExp(frag('保', '守')), new RegExp(frag('激', '进')), new RegExp(frag('稳', '赚')), new RegExp(frag('跑', '赢'))]
const WORDS_SCOPE = [/^README\.md$/, /^SECURITY\.md$/, /^CONTRIBUTING\.md$/, /^docs\//, /^integrations\//, /^packages\/[^/]+\/(src|schemas)\//, /^packages\/[^/]+\/README\.md$/]
const EMAIL = /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g
const EMAIL_OK = /(example\.(com|org|net)|users\.noreply\.github\.com|noreply@)/i
const SELF = 'scripts/check-public.mjs'
// 这些文件按设计会提到路径形状 / 词（本脚本、卫生测试、门禁的正则）
const SCAN_EXEMPT = new Set([SELF, 'packages/protocol/test/hygiene.test.ts', 'packages/workbench/build.mjs', 'package-lock.json'])
const LOCKLIKE = /(^|\/)package-lock\.json$/

// 密钥形：只报位置，不打印原文。三处是公开测试向量 / 链上常量，按「文件:行 + 行 sha256 前 12 位」精确放行。
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bghp_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bpas]-[A-Za-z0-9-]{10,}|\bBearer\s+[A-Za-z0-9._-]{24,}|\b0x[0-9a-fA-F]{64}\b/
const SECRET_ALLOW = new Map([
  // OpenAI 公开测试向量（packages/blocks-r5/test/model-config.test.ts）
  ['packages/blocks-r5/test/model-config.test.ts:94', '28d9ebc8e022'],
  // dYdX 链上公开常量（packages/connector-dydx-trade/src/constants.ts）
  ['packages/connector-dydx-trade/src/constants.ts:28', '7fa1dfc8ba7c'],
  // EIP-712 公开测试向量（packages/kernel/test/eip712.test.ts）
  ['packages/kernel/test/eip712.test.ts:25', '105def4249bb'],
])

for (const f of files) {
  if (LOCKLIKE.test(f)) continue
  const p = join(root, f)
  if (!existsSync(p)) continue
  const exists = statSync(p)
  if (exists.size > 4 << 20) continue
  const text = readFileSync(p, 'utf8')
  if (text.includes('\0')) continue
  const lines = text.split(/\r?\n/)
  // 私有禁词表：hard 命中即 FAIL，soft 只 WARN；只报文件:行，不打印词表内容。
  if (PRIVATE.length) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      for (const rule of PRIVATE) {
        if (!rule.re.test(line)) continue
        if (rule.level === 'hard') fail(`file:line ${f}:${i + 1} 命中私有禁词表（hard）`)
        else warn(`${f}:${i + 1} private denylist (soft)`)
      }
    }
  }
  // 密钥形：allowlist 命中要求文件、行号、行内容都与发布基线一致。
  if (SECRET.test(text)) {
    for (let i = 0; i < lines.length; i++) {
      if (!SECRET.test(lines[i])) continue
      const key = `${f}:${i + 1}`
      if (SECRET_ALLOW.get(key) === sha12(lines[i])) continue
      fail(`file:line ${key} 疑似密钥形；如属公开测试向量，需登记精确 allowlist`)
    }
  }
  if (SCAN_EXEMPT.has(f) || !TEXT.test(f)) continue
  for (const re of LOCAL_PATH) { const m = re.exec(text); if (m) fail(`${f}: 本机路径 ${JSON.stringify(m[0])}`) }
  if (WORDS_SCOPE.some((re) => re.test(f))) for (const re of BANNED) { const m = re.exec(text); if (m) fail(`${f}: 产品文案禁词 ${JSON.stringify(m[0])}`) }
  if (!/(^|\/)(THIRD-PARTY-NOTICES\.md|LICENSE|NOTICE)$/.test(f) && !f.endsWith('.LEGAL.txt')) {
    for (const m of text.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) fail(`${f}: 疑似邮箱 ${m[0]}`)
  }
}

if (failures) { console.error(`\n${failures} 项不通过`); process.exit(1) }
console.log('ok    公开仓库卫生检查通过')
