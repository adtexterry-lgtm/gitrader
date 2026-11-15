// SPDX-License-Identifier: CPAL-1.0
// Gitrader 便携包构建：把已构建的 dist 产物 + 官方 Node 运行时拼成「解开就能跑」的目录，再打成一个压缩包。
//
// 用法（仓库根执行）：
//   node tools/portable/build-portable.mjs                                  本机平台，下载 Node 22.23.2，构建后打包
//   node tools/portable/build-portable.mjs --platform linux-x64 --out dist-portable
//   node tools/portable/build-portable.mjs --runtime-dir <已有 Node 目录> --skip-build    离线 / 测试
//
// 设计约束：
// - 只有用户显式运行本脚本、且没给 --runtime-dir 时才会联网下载；测试全程离线（注入假 fetch / 假运行时目录）。
// - 只用 Node 标准库 + 系统自带工具（PowerShell Expand-Archive / Compress-Archive、tar），不新增依赖。
// - 压缩包未做代码签名，见同目录 README.md 的「已知限制」。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_NODE_VERSION = '22.23.2'
/** CLI 声明的 engines.node 下限（packages/cli/package.json）。低于它不保证能跑。 */
export const NODE_MIN = '22.13'
export const PLATFORMS = ['win-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']
export const DEFAULT_OUT = 'dist-portable'
/** 零承诺语言：产品文案里不许出现的词（判据同 scripts/check-public.mjs）。按片段拼，免得本文件自己被门禁正则命中。 */
const frag = (...parts) => parts.join('')
export const PROMISE_WORDS = [
  frag('保', '守'), frag('激', '进'), frag('稳', '赚'), frag('跑', '赢'),
  '稳定盈利', '保证收益', '零风险', 'risk-free', 'guaranteed',
]

export const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 构建失败：带机器可读的 code，测试按 code 断言。 */
export class BuildError extends Error {
  constructor(message, code = 'BUILD_FAILED') {
    super(message)
    this.name = 'BuildError'
    this.code = code
  }
}

// ---- 平台 / 文件名 / URL ------------------------------------------------------------------

/** 当前机对应的便携包平台名；不支持的组合返回 undefined。 */
export function detectPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'x64' ? 'win-x64' : undefined
  if (platform === 'linux') return arch === 'x64' ? 'linux-x64' : undefined
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : undefined
  return undefined
}

export function nodeExecutableName(platform) {
  return platform.startsWith('win') ? 'node.exe' : 'node'
}

/** nodejs.org/dist 上的运行时包名。 */
export function nodeArchiveName(version, platform) {
  return `node-v${version}-${platform}.${platform.startsWith('win') ? 'zip' : 'tar.gz'}`
}

export function nodeDistUrl(version, file) {
  return `https://nodejs.org/dist/v${version}/${file}`
}

export function bundleDirName(version, platform) {
  return `gitrader-${version}-${platform}`
}

export function archiveName(version, platform) {
  return `${bundleDirName(version, platform)}.${platform.startsWith('win') ? 'zip' : 'tar.gz'}`
}

// ---- 参数 ---------------------------------------------------------------------------------

const USAGE = `用法: node tools/portable/build-portable.mjs [选项]

  --platform <win-x64|linux-x64|darwin-arm64|darwin-x64>   目标平台（缺省：当前机）
  --node <版本>                                            运行时版本（缺省 ${DEFAULT_NODE_VERSION}）
  --runtime-dir <目录>                                     用本机已有的 Node 目录，不联网下载
  --out <目录>                                             产物目录（缺省 ${DEFAULT_OUT}）
  --repo-root <目录>                                       仓库根（缺省：按本脚本位置推导）
  --skip-build                                             跳过 npm run build -w gitrader（用现有 dist）
  --no-pack                                                只装配目录，不打包
  --help
`

export class UsageError extends BuildError {
  constructor(message) {
    super(message, 'USAGE')
    this.name = 'UsageError'
  }
}

const FLAGS = new Set(['platform', 'node', 'runtime-dir', 'out', 'repo-root'])
const SWITCHES = new Set(['skip-build', 'no-pack', 'help'])

/** 解析命令行；未知参数一律报用法错误（不静默忽略）。 */
export function parseArgs(argv = []) {
  const o = {
    platform: undefined, node: DEFAULT_NODE_VERSION, runtimeDir: undefined, out: DEFAULT_OUT,
    repoRoot: undefined, skipBuild: false, pack: true, help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new UsageError(`多余的参数：${a}`)
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
    const inline = eq > 0 ? a.slice(eq + 1) : undefined
    if (SWITCHES.has(key)) {
      if (inline !== undefined) throw new UsageError(`--${key} 不接受值`)
      if (key === 'skip-build') o.skipBuild = true
      else if (key === 'no-pack') o.pack = false
      else o.help = true
      continue
    }
    if (!FLAGS.has(key)) throw new UsageError(`未知参数：--${key}`)
    const value = inline ?? argv[++i]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new UsageError(`--${key} 需要一个值`)
    if (key === 'platform') o.platform = value
    else if (key === 'node') o.node = value.replace(/^v/, '')
    else if (key === 'runtime-dir') o.runtimeDir = value
    else if (key === 'out') o.out = value
    else o.repoRoot = value
  }
  if (o.platform !== undefined && !PLATFORMS.includes(o.platform)) {
    throw new UsageError(`不支持的平台：${o.platform}（可选：${PLATFORMS.join(' / ')}）`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(o.node)) throw new UsageError(`版本号要写成 x.y.z：${o.node}`)
  if (NODE_MIN && compareVersions(o.node, NODE_MIN) < 0) throw new UsageError(`运行时版本低于 ${NODE_MIN}：${o.node}`)
  return o
}

/** 只比较 x.y.z 数字段。 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number(n) || 0)
  const pb = String(b).split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

// ---- 校验和 -------------------------------------------------------------------------------

/** 解析 `SHASUMS256.txt`：每行 `<sha256>␠␠<文件名>`；忽略空行 / 注释 / 认不出的行。 */
export function parseShasums(text) {
  const map = new Map()
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (!m) continue
    map.set(m[2].trim(), m[1].toLowerCase())
  }
  return map
}

/** 从清单里取某个文件应有的 sha256；没有就报错（不静默放过）。 */
export function expectedDigest(shasumsText, assetName) {
  const got = parseShasums(shasumsText).get(assetName)
  if (got === undefined) throw new BuildError(`校验清单里找不到 ${assetName}`, 'CHECKSUM_MISSING')
  return got
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function sha256File(file) {
  return sha256Buffer(readFileSync(file))
}

/** 比对 sha256；不一致抛 CHECKSUM_MISMATCH（调用方负责删掉坏文件）。 */
export function verifyDigest(expected, actual, label = 'file') {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new BuildError(`期望的 sha256 形状不对：${String(expected)}`, 'CHECKSUM_MALFORMED')
  }
  if (expected !== actual) {
    throw new BuildError(`sha256 不匹配：${label}（期望 ${expected}，实际 ${actual}）`, 'CHECKSUM_MISMATCH')
  }
  return true
}

// ---- 下载 / 解压（仅用户显式运行时发生） ----------------------------------------------------

/** 系统解压：Windows 用 PowerShell Expand-Archive，其它平台用 tar。 */
export function extractArchive(archive, platform, destDir, { exec = spawnSync, log = () => {} } = {}) {
  mkdirSync(destDir, { recursive: true })
  if (platform.startsWith('win')) {
    const script = `Expand-Archive -LiteralPath '${psPath(archive)}' -DestinationPath '${psPath(destDir)}' -Force`
    log(`解压：powershell ${script}`)
    const r = exec('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'inherit' })
    if (r.error) throw new BuildError(`调用 PowerShell 失败：${r.error.message}`, 'EXTRACT_FAILED')
    if (r.status !== 0) throw new BuildError(`Expand-Archive 退出码 ${r.status}`, 'EXTRACT_FAILED')
    return
  }
  log(`解压：tar -xzf ${archive} -C ${destDir}`)
  const r = exec('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' })
  if (r.error) throw new BuildError(`调用 tar 失败：${r.error.message}`, 'EXTRACT_FAILED')
  if (r.status !== 0) throw new BuildError(`tar 退出码 ${r.status}`, 'EXTRACT_FAILED')
}

/** 下载官方 Node 运行时并校验 sha256 后解压；返回解压出的运行时根目录。 */
export async function downloadNodeRuntime({
  version = DEFAULT_NODE_VERSION, platform, destDir, fetchImpl = globalThis.fetch,
  extract = extractArchive, log = () => {},
}) {
  if (typeof fetchImpl !== 'function') throw new BuildError('没有可用的 fetch（需要 Node 18+）', 'NO_FETCH')
  mkdirSync(destDir, { recursive: true })
  const asset = nodeArchiveName(version, platform)
  const sumsUrl = nodeDistUrl(version, 'SHASUMS256.txt')
  log(`读取校验清单：${sumsUrl}`)
  const sumsRes = await fetchImpl(sumsUrl)
  if (!sumsRes || !sumsRes.ok) throw new BuildError(`下载 SHASUMS256.txt 失败：HTTP ${sumsRes ? sumsRes.status : '?'}`, 'DOWNLOAD_FAILED')
  const sumsText = await sumsRes.text()
  const expected = expectedDigest(sumsText, asset)

  const url = nodeDistUrl(version, asset)
  log(`下载运行时：${url}`)
  const res = await fetchImpl(url)
  if (!res || !res.ok) throw new BuildError(`下载 ${asset} 失败：HTTP ${res ? res.status : '?'}`, 'DOWNLOAD_FAILED')
  const buf = Buffer.from(await res.arrayBuffer())
  const archive = join(destDir, asset)
  writeFileSync(archive, buf)
  try {
    verifyDigest(expected, sha256Buffer(buf), asset)
  } catch (e) {
    rmSync(archive, { force: true })
    throw e
  }

  const out = join(destDir, 'unpacked')
  rmSync(out, { recursive: true, force: true })
  extract(archive, platform, out, { log })
  const tops = readdirSync(out).filter((n) => statSync(join(out, n)).isDirectory())
  const top = tops.find((n) => n.startsWith(`node-v${version}-`)) ?? (tops.length === 1 ? tops[0] : undefined)
  if (!top) throw new BuildError(`解压后找不到 node-v${version}-* 目录（${tops.join(', ') || '空'}）`, 'EXTRACT_FAILED')
  return join(out, top)
}

// ---- 源码 / 运行时的准备 --------------------------------------------------------------------

export function readRepoVersion(repoRoot = DEFAULT_REPO_ROOT) {
  for (const p of [join(repoRoot, 'package.json'), join(repoRoot, 'packages', 'cli', 'package.json')]) {
    if (!existsSync(p)) continue
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (typeof j.version === 'string' && /^\d+\.\d+\.\d+/.test(j.version)) return j.version
  }
  throw new BuildError('读不到版本号（根 package.json 与 packages/cli/package.json 都没有 version）', 'NO_VERSION')
}

/** 运行时目录里的 node 可执行文件（解压布局在 bin/ 下，Windows zip 在根）。 */
export function locateNodeExecutable(runtimeDir) {
  for (const rel of [['node.exe'], ['node'], ['bin', 'node.exe'], ['bin', 'node']]) {
    const p = join(runtimeDir, ...rel)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  throw new BuildError(`运行时目录里没有 node 可执行文件：${runtimeDir}`, 'NO_RUNTIME')
}

/**
 * 运行时的真实版本。同平台就直接问它（node --version）；跨平台打包跑不了对方的可执行文件，
 * 就认官方解压目录名 `node-v22.23.2-<平台>`；都不行返回 undefined（调用方回退到请求的版本）。
 * 清单里记实际嵌入的版本，不记请求的版本（清单写错 = 用户按错的版本排查问题）。
 */
export function detectRuntimeNodeVersion(nodeSrc, platform, { exec = spawnSync } = {}) {
  if (detectPlatform() === platform) {
    let r
    try {
      r = exec(nodeSrc, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    } catch {
      r = undefined
    }
    const m = r !== undefined && !r?.error && r?.status === 0 ? /^v(\d+\.\d+\.\d+)\s*$/.exec(String(r.stdout)) : null
    if (m) return m[1]
  }
  const m2 = /node-v(\d+\.\d+\.\d+)-/.exec(String(nodeSrc).split(/[\\/]/).join('/'))
  return m2 ? m2[1] : undefined
}

export function requireDir(p, label, hint = '（先跑 npm run build -w gitrader，或去掉 --skip-build）') {
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new BuildError(`缺少${label}：${p}${hint}`, 'MISSING_SOURCE')
  return p
}

export function requireFile(p, label) {
  if (!existsSync(p) || !statSync(p).isFile()) throw new BuildError(`缺少${label}：${p}`, 'MISSING_SOURCE')
  return p
}

/** 跑 CLI 包自己的构建（它把 bin.js / engine-core.mjs / workbench/ 全写进 packages/cli/dist）。测试一律用 --skip-build，不走到这里。 */
export function runBuild(repoRoot, { exec = spawnSync, log = () => {} } = {}) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  log(`构建 dist：${npm} run build -w gitrader（cwd=${repoRoot}）`)
  const r = exec(npm, ['run', 'build', '-w', 'gitrader'], { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.error) throw new BuildError(`npm run build -w gitrader 起不来：${r.error.message}`, 'BUILD_FAILED')
  if (r.status !== 0) throw new BuildError(`npm run build -w gitrader 退出码 ${r.status}`, 'BUILD_FAILED')
}

// ---- 生成的脚本 / 文本 ----------------------------------------------------------------------

export function launcherCmd() {
  return [
    '@echo off',
    'rem Gitrader 便携版启动器（Windows）。由 tools/portable/build-portable.mjs 生成。',
    'rem GITRADER_LAUNCHER makes the next-step commands the program prints use this launcher path (ASCII only: cmd misparses multibyte text here).',
    'setlocal',
    'set "GITRADER_LAUNCHER=%~dp0gitrader.cmd"',
    '"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\cli\\bin.js" %*',
    '',
  ].join('\r\n')
}

export function launcherSh() {
  return [
    '#!/bin/sh',
    '# Gitrader 便携版启动器（macOS / Linux）。由 tools/portable/build-portable.mjs 生成。',
    'HERE=$(cd -- "$(dirname -- "$0")" && pwd)',
    '# GITRADER_LAUNCHER：让程序打印的「下一步」命令写成本启动器的完整路径。',
    'GITRADER_LAUNCHER="$HERE/gitrader"',
    'export GITRADER_LAUNCHER',
    'exec "$HERE/../runtime/node" "$HERE/../app/cli/bin.js" "$@"',
    '',
  ].join('\n')
}

export function startCmd() {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'rem 首次运行先初始化数据目录，然后起内核 + 工作台，并自动用默认浏览器打开工作台（每次启动都是新的一次性地址）。',
    'rem First run initialises the data directory, then starts the kernel and opens the workbench in your default browser.',
    'set "HERE=%~dp0"',
    'set "GITRADER_LAUNCHER=%HERE%bin\\gitrader.cmd"',
    'set "CFG=%USERPROFILE%\\.gitrader\\gitrader.json"',
    'if defined GITRADER_HOME set "CFG=%GITRADER_HOME%\\gitrader.json"',
    'if not exist "%CFG%" (',
    '  echo 首次运行：初始化数据目录  /  First run: initialising the data folder',
    '  call "%HERE%bin\\gitrader.cmd" init --no-pin',
    ')',
    'echo 启动本地内核与工作台，浏览器会自动打开；没打开就把下面的链接粘到浏览器。按 Ctrl+C 停止。',
    'echo Starting the local kernel and workbench. Your browser opens by itself; if it does not, paste the link below. Press Ctrl+C to stop.',
    `call "%HERE%bin\\gitrader.cmd" serve %* --open`,
    '',
  ].join('\r\n')
}

export function startSh() {
  return [
    '#!/bin/sh',
    '# 首次运行先初始化数据目录，然后起内核 + 工作台，并用默认浏览器打开工作台（每次启动都是新的一次性地址）。',
    '# First run initialises the data directory, then starts the kernel and opens the workbench in your default browser.',
    'set -e',
    'HERE=$(cd -- "$(dirname -- "$0")" && pwd)',
    'CFG="$HOME/.gitrader/gitrader.json"',
    'if [ -n "${GITRADER_HOME:-}" ]; then CFG="$GITRADER_HOME/gitrader.json"; fi',
    'if [ ! -f "$CFG" ]; then',
    '  echo "首次运行：初始化数据目录  /  First run: initialising the data directory"',
    '  "$HERE/bin/gitrader" init --no-pin',
    'fi',
    'echo "启动本地内核与工作台，浏览器会自动打开；没打开就把下面的链接粘到浏览器。按 Ctrl+C 停止。"',
    'echo "Starting the local kernel and workbench. Your browser opens by itself; if it does not, paste the link below. Press Ctrl+C to stop."',
    'exec "$HERE/bin/gitrader" serve "$@" --open',
    '',
  ].join('\n')
}

export function readmeText(version, platform, nodeVersion) {
  return [
    `Gitrader ${version}（${platform}，内置 Node v${nodeVersion}，不需要另外装 Node）`,
    `Gitrader ${version} (${platform}, bundled Node v${nodeVersion}; no separate Node install needed)`,
    '',
    '中文',
    '====',
    '1. 把这个目录解压到任意位置（路径可以带空格；不需要管理员权限）。',
    '2. 启动：Windows 双击 start.cmd；macOS / Linux 在终端执行 ./start.sh。',
    '3. 浏览器会自动打开工作台；没打开就把终端里那行链接粘到浏览器。按 Ctrl+C 停止服务。',
    '4. 其它命令：在这个目录里用 bin\\gitrader.cmd（macOS / Linux：bin/gitrader），例如 bin\\gitrader.cmd doctor（自检）、bin\\gitrader.cmd open（取新的登录链接，要 PIN）、bin\\gitrader.cmd status。程序打印的“下一步”命令也会写成这个完整路径。',
    '5. 改端口：start.cmd --port 50123（start.sh 同；其余参数原样交给 serve）。改数据目录：先设环境变量 GITRADER_HOME 再启动——Windows：set GITRADER_HOME=D:\\trading-data 然后 start.cmd；macOS / Linux：GITRADER_HOME=/path/to/data ./start.sh。',
    '',
    `数据写在 ${'~'}/.gitrader（密钥库、配置、账本、实验室数据；设了 GITRADER_HOME 就在那个目录）。程序本身在这个解压出来的目录里，两者是分开的。`,
    '升级：先在旧目录里运行 bin\\gitrader.cmd stop 停掉服务，再把新版压缩包解压到另一个目录，用新目录里的 start.cmd 启动。数据目录不用动，新版会直接沿用；确认没问题后再删旧目录。',
    '卸载：运行 bin\\gitrader.cmd stop，然后删掉这个解压目录即可。想连数据一起清掉，再删 ~/.gitrader（或 GITRADER_HOME 指向的目录）——里面有钥匙和账本，删了就找不回来，先自己留一份备份。',
    '压缩包与里面的运行时都没有代码签名，Windows 首次运行可能弹 SmartScreen 提示；发行方身份与文件哈希见 manifest.json。',
    '本包只在本机 127.0.0.1 上监听；未经真网验证的交易连接器不得接实盘。',
    '',
    'English',
    '=======',
    '1. Unzip this folder anywhere (spaces in the path are fine; no administrator rights needed).',
    '2. Start it: on Windows double-click start.cmd; on macOS / Linux run ./start.sh in a terminal.',
    '3. Your browser opens the workbench by itself; if it does not, paste the link printed in the terminal into a browser. Press Ctrl+C to stop the service.',
    '4. Other commands: use bin\\gitrader.cmd from this folder (macOS / Linux: bin/gitrader), for example bin\\gitrader.cmd doctor (self-check), bin\\gitrader.cmd open (a fresh login link; asks for your PIN) and bin\\gitrader.cmd status. The "next step" commands the program prints use this full path too.',
    '5. Change the port: start.cmd --port 50123 (same for start.sh; other arguments go to serve unchanged). Change the data folder: set GITRADER_HOME before starting. Windows: set GITRADER_HOME=D:\\trading-data and then start.cmd; macOS / Linux: GITRADER_HOME=/path/to/data ./start.sh.',
    '',
    `Your data lives in ${'~'}/.gitrader (key vault, config, ledger, lab data; in the GITRADER_HOME folder if you set it). The program itself is in this unzipped folder; the two are separate.`,
    'Upgrade: run bin\\gitrader.cmd stop in the old folder, unzip the new package into a different folder and start it with that folder\'s start.cmd. Leave the data folder alone; the new version picks it up. Delete the old folder once everything works.',
    'Uninstall: run bin\\gitrader.cmd stop, then delete this unzipped folder. To remove your data as well, also delete ~/.gitrader (or the GITRADER_HOME folder). It holds your keys and ledger and cannot be recovered, so keep a backup first.',
    'The archive and the runtime inside it are not code-signed, so Windows may show a SmartScreen prompt the first time you run it; the publisher identity and file hashes are in manifest.json.',
    'The service listens on 127.0.0.1 only. A trading connector that has not been verified on a live network must not be connected to a live account.',
    '',
  ].join('\n')
}

/** 零承诺语言自检；命中就抛（生成的 README 也要过这一关）。 */
export function findPromiseWords(text) {
  const hits = []
  const lower = String(text).toLowerCase()
  for (const w of PROMISE_WORDS) if (lower.includes(w.toLowerCase())) hits.push(w)
  return hits
}

export function assertNoPromiseLanguage(text, label) {
  const hits = findPromiseWords(text)
  if (hits.length) throw new BuildError(`${label} 出现禁词：${hits.join('、')}`, 'PROMISE_LANGUAGE')
  return true
}

// ---- 装配 ---------------------------------------------------------------------------------

function walkFiles(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) stack.push(p)
      else if (st.isFile()) out.push(p)
    }
  }
  return out.sort()
}

/** 目录内容清单（相对路径用 /，含 size 与 sha256）；exclude 里的相对路径跳过。 */
export function hashTree(root, { exclude = [] } = {}) {
  const skip = new Set(exclude)
  return walkFiles(root)
    .map((abs) => {
      const rel = relative(root, abs).split(sep).join('/')
      return { path: rel, size: statSync(abs).size, sha256: sha256File(abs) }
    })
    .filter((f) => !skip.has(f.path))
}

/**
 * 装配 `gitrader-<版本>-<平台>/` 目录树（不联网、不构建）。
 * 运行时从 `app/cli/` 命中：CLI 找静态目录（packages/cli/src/index.ts 的 defaultStaticDir）会试
 * `<bin 目录>/workbench`，找引擎（packages/kernel/src/engines.ts:318）会试 `<bin 目录>/engine-core.mjs`，
 * 正好落在 app/cli/workbench/ 与 app/cli/engine-core.mjs 上，不需要单独的 app/workbench、app/engine-core。
 * 返回 { bundleDir, manifest, files }。
 */
export function assembleBundle({
  repoRoot = DEFAULT_REPO_ROOT, platform, runtimeDir, outDir, version = readRepoVersion(repoRoot),
  nodeVersion = DEFAULT_NODE_VERSION, now = Date.now(), log = () => {},
}) {
  if (!PLATFORMS.includes(platform)) throw new BuildError(`不支持的平台：${platform}`, 'BAD_PLATFORM')
  requireDir(runtimeDir, '运行时目录', '（给 --runtime-dir 一个含 node / node.exe 的目录）')
  const nodeSrc = locateNodeExecutable(runtimeDir)
  // 清单 / VERSION / README 一律写运行时的真实版本：请求的 --node 只在探测不出来时当回退值。
  const actualNode = detectRuntimeNodeVersion(nodeSrc, platform) ?? nodeVersion
  if (compareVersions(actualNode, NODE_MIN) < 0) {
    throw new BuildError(`运行时 Node v${actualNode} 低于 ${NODE_MIN}`, 'RUNTIME_TOO_OLD')
  }
  if (actualNode !== nodeVersion) log(`运行时实际是 v${actualNode}（请求的是 v${nodeVersion}）：清单按实际写`)

  const sources = {
    cli: requireDir(join(repoRoot, 'packages', 'cli', 'dist'), ' CLI 产物 packages/cli/dist'),
    license: requireFile(join(repoRoot, 'LICENSE'), ' LICENSE'),
    notices: requireFile(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), ' THIRD_PARTY_NOTICES.md'),
  }
  requireFile(join(sources.cli, 'bin.js'), ' CLI 入口 packages/cli/dist/bin.js')
  requireFile(join(sources.cli, 'engine-core.mjs'), ' 引擎 packages/cli/dist/engine-core.mjs')
  requireFile(join(sources.cli, 'workbench', 'index.html'), ' 工作台首页 packages/cli/dist/workbench/index.html')

  const bundleDir = join(outDir, bundleDirName(version, platform))
  rmSync(bundleDir, { recursive: true, force: true })
  const put = (rel, text, mode) => {
    const p = join(bundleDir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
    if (mode !== undefined) chmodSync(p, mode)
    return p
  }
  const cp = (src, rel) => {
    const dest = join(bundleDir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true })
    return dest
  }

  // app/
  cp(sources.cli, 'app/cli')
  // runtime/
  const nodeExe = nodeExecutableName(platform)
  mkdirSync(join(bundleDir, 'runtime'), { recursive: true })
  cpSync(nodeSrc, join(bundleDir, 'runtime', nodeExe))
  if (!platform.startsWith('win')) chmodSync(join(bundleDir, 'runtime', nodeExe), 0o755)
  const runtimeLicense = [join(runtimeDir, 'LICENSE'), join(runtimeDir, '..', 'LICENSE')].find((p) => existsSync(p))
  if (runtimeLicense) cpSync(runtimeLicense, join(bundleDir, 'runtime', 'NODE-LICENSE.txt'))
  // 启动器 / 启动脚本
  put('bin/gitrader.cmd', launcherCmd())
  put('bin/gitrader', launcherSh(), 0o755)
  put('start.cmd', startCmd())
  put('start.sh', startSh(), 0o755)
  const readme = readmeText(version, platform, actualNode)
  assertNoPromiseLanguage(readme, 'README.txt')
  put('README.txt', readme)
  put('VERSION', `${version}\nnode v${actualNode} ${platform}\n`)
  cpSync(sources.license, join(bundleDir, 'LICENSE'))
  cpSync(sources.notices, join(bundleDir, 'THIRD_PARTY_NOTICES.md'))

  const files = hashTree(bundleDir, { exclude: ['manifest.json'] })
  const manifest = {
    name: 'gitrader',
    version,
    platform,
    nodeVersion: actualNode,
    builtAt: new Date(now).toISOString(),
    builtBy: 'tools/portable/build-portable.mjs',
    entry: { windows: 'start.cmd', unix: 'start.sh', launcher: platform.startsWith('win') ? 'bin/gitrader.cmd' : 'bin/gitrader' },
    app: { cli: 'app/cli/bin.js', workbench: 'app/cli/workbench/index.html', engineCore: 'app/cli/engine-core.mjs' },
    runtime: `runtime/${nodeExe}`,
    totals: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
    files,
  }
  writeFileSync(join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  log(`装配完成：${bundleDir}（${files.length} 个文件）`)
  return { bundleDir, manifest, files }
}

// ---- 打包 ---------------------------------------------------------------------------------

function psPath(p) {
  return resolve(p).split('/').join('\\').replace(/'/g, "''")
}

/** 打压缩包（Windows zip / 其它 tar.gz）；返回 { archive, sha256, size }。 */
export function packBundle(bundleDir, platform, { exec = spawnSync, log = () => {} } = {}) {
  const outDir = dirname(bundleDir)
  const name = `${bundleDir.split(/[\\/]/).pop()}.${platform.startsWith('win') ? 'zip' : 'tar.gz'}`
  const archive = join(outDir, name)
  rmSync(archive, { force: true })
  const attempts = []
  if (platform.startsWith('win')) {
    // bsdtar（Win10+ 自带）优先：-a 按扩展名选 zip，条目路径用 /（Windows PowerShell 5.1 的 Compress-Archive 写反斜杠，unzip 会报警告）；PowerShell 兜底
    // 必须是系统自带的 bsdtar：PATH 里排在前面的可能是 Git 的 GNU tar，它不认 -a，会写出一个扩展名是 .zip 的 tar 文件
    const bsdtar = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
    if (existsSync(bsdtar)) attempts.push([bsdtar, ['-a', '-c', '-f', archive, '-C', outDir, bundleDir.split(/[\\/]/).pop()]])
    const script = `Compress-Archive -LiteralPath '${psPath(bundleDir)}' -DestinationPath '${psPath(archive)}' -CompressionLevel Optimal -Force`
    attempts.push(['powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]])
  } else {
    attempts.push(['tar', ['-czf', archive, '-C', outDir, bundleDir.split(/[\\/]/).pop()]])
  }
  let lastErr
  for (const [cmd, args] of attempts) {
    log(`打包：${cmd} ${args.join(' ')}`)
    const r = exec(cmd, args, { stdio: 'pipe', encoding: 'utf8' })
    if (!r.error && r.status === 0 && existsSync(archive) && statSync(archive).size > 0) {
      return { archive, sha256: sha256File(archive), size: statSync(archive).size }
    }
    lastErr = r.error ? r.error.message : `退出码 ${r.status}${r.stderr ? `：${String(r.stderr).trim().split('\n')[0]}` : ''}`
    rmSync(archive, { force: true })
  }
  throw new BuildError(`打包失败：${lastErr}`, 'PACK_FAILED')
}

/** 打包后把归档信息补写进 manifest（包内那份是打包前的，差异仅此一块）。只记文件名，不记构建机的绝对路径。 */
export function recordArchive(bundleDir, info) {
  const p = join(bundleDir, 'manifest.json')
  const m = JSON.parse(readFileSync(p, 'utf8'))
  m.archive = { name: info.archive.split(/[\\/]/).pop(), sha256: info.sha256, size: info.size }
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`)
  return m
}

// ---- 入口 ---------------------------------------------------------------------------------

export function runtimeCacheDir(outDir, nodeVersion, platform) {
  return join(resolve(outDir), '.runtime-cache', `node-v${nodeVersion}-${platform}/`)
}

export async function main(argv = process.argv.slice(2), {
  out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s),
  fetchImpl = globalThis.fetch, exec = spawnSync, now = Date.now(), download = downloadNodeRuntime,
  build = runBuild,
} = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    out(USAGE)
    return 0
  }
  const log = (m) => err(`[portable] ${m}\n`)
  try {
    const repoRoot = resolve(args.repoRoot ?? DEFAULT_REPO_ROOT)
    const platform = args.platform ?? detectPlatform()
    if (!platform) throw new BuildError(`认不出当前平台（${process.platform}/${process.arch}），用 --platform 指定`, 'BAD_PLATFORM')
    const outDir = resolve(args.out)
    const version = readRepoVersion(repoRoot)
    log(`目标：gitrader ${version} / ${platform} / node v${args.node} / 输出 ${outDir}`)

    let runtimeDir = args.runtimeDir ? resolve(args.runtimeDir) : undefined
    if (runtimeDir === undefined) {
      const cached = runtimeCacheDir(outDir, args.node, platform)
      const hit = ['node.exe', 'node'].some((n) => existsSync(join(cached, n)))
        || ['node.exe', 'node'].some((n) => existsSync(join(cached, 'bin', n)))
      if (hit) {
        runtimeDir = cached
        log(`复用已下载的运行时：${cached}`)
      } else {
        runtimeDir = await download({ version: args.node, platform, destDir: cached, fetchImpl, log })
      }
    } else {
      log(`使用本地运行时目录：${runtimeDir}`)
    }

    if (args.skipBuild) log('跳过 npm run build -w gitrader（--skip-build）')
    else build(repoRoot, { exec, log })

    const { bundleDir, manifest, files } = assembleBundle({
      repoRoot, platform, runtimeDir, outDir, version, nodeVersion: args.node, now, log,
    })
    let archive
    if (args.pack) {
      archive = packBundle(bundleDir, platform, { exec, log })
      recordArchive(bundleDir, archive)
      log(`压缩包：${archive.archive}（${(archive.size / 1024 / 1024).toFixed(1)} MB, sha256 ${archive.sha256.slice(0, 16)}…）`)
    }
    out(`${bundleDir}\n${archive ? `${archive.archive}\n` : ''}`)
    out(`文件 ${files.length} 个，共 ${(manifest.totals.bytes / 1024 / 1024).toFixed(1)} MB；Node v${manifest.nodeVersion}；${manifest.builtAt}\n`)
    return 0
  } catch (e) {
    err(`错误：${e instanceof Error ? e.message : String(e)}${e && e.code ? `（${e.code}）` : ''}\n`)
    return 1
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main().then((code) => { process.exitCode = code })
