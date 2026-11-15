// SPDX-License-Identifier: CPAL-1.0
// 发布资产构建：npm 包 tgz + 各平台便携包 + SHA256SUMS + RELEASE-NOTES.md。
//
// 用法（仓库根执行）：
//   node scripts/release/build-release-assets.mjs                                 缺省三个平台，产物进 dist-release/
//   node scripts/release/build-release-assets.mjs --out dist-release --platforms win-x64,linux-x64
//   node scripts/release/build-release-assets.mjs --runtime-dir <已有 Node 目录> --skip-build   离线 / 复用现成产物
//   node scripts/release/build-release-assets.mjs --skip-portable                 只出 tgz + SHA256SUMS
//
// 只用 Node 标准库。便携包的装配与打包复用 tools/portable/build-portable.mjs 的导出（拿不到导出就退化成子进程调用）。
// 联网只发生在「没给 --runtime-dir 且缓存里没有运行时」时，由便携脚本的下载分支负责；--help 不做任何事。
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const DEFAULT_OUT = 'dist-release'
export const DEFAULT_PLATFORMS = ['win-x64', 'linux-x64', 'darwin-arm64']
const PORTABLE_SUPPORTED = ['win-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64']
/** 进 SHA256SUMS 的文件后缀。 */
const ARCHIVE_RE = /\.(tgz|zip|tar\.gz)$/i
/** 便携脚本的运行时下载缓存，不进 SHA256SUMS。 */
const CACHE_DIR = '.runtime-cache'

const USAGE = `用法: node scripts/release/build-release-assets.mjs [选项]

  --out <目录>               产物目录（缺省 ${DEFAULT_OUT}）
  --platforms <p1,p2,...>    便携包平台，逗号分隔（缺省 ${DEFAULT_PLATFORMS.join(',')}）
  --runtime-dir <目录>       用本机已有的 Node 目录，透传给便携构建（离线用；不给则按平台下载 / 复用缓存）
  --skip-portable            跳过便携包，只做 tgz + SHA256SUMS + 说明
  --skip-build               跳过 npm run build -w gitrader（用 packages/cli/dist 现成产物）
  --help                     只打印本用法，退出 0，不做任何事

产物：gitrader-<版本>.tgz、gitrader-<版本>-<平台>.zip|tar.gz、SHA256SUMS、RELEASE-NOTES.md
退出码：0 全过；1 某一步失败（打印中文原因 + 该步原始输出末 20 行）；2 参数用法错误。
`

// ---- 纯函数（供测试） ---------------------------------------------------------------------

function sha256Buffer(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizeName(name) {
  return String(name).split(sep).join('/').replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 生成 SHA256SUMS 文本：每行 `<sha256>  <文件名>`，按文件名排序。
 * files: Array<{ name: string, bytes: Buffer | string }>
 */
export function sha256sums(files = []) {
  const rows = (Array.isArray(files) ? files : [])
    .map((f) => ({ name: normalizeName(f && f.name), bytes: f && f.bytes }))
    .filter((f) => f.name)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${sha256Buffer(f.bytes ?? '')}  ${f.name}`)
  return rows.length ? `${rows.join('\n')}\n` : ''
}

/**
 * 检查发出去的 tgz 有没有运行时依赖（规则同 tools/release/deps-audit.mjs）：
 * dependencies 必须为空，且不得依赖未发布的 @gitrader/* 包。返回问题清单，空数组表示合格。
 */
export function checkTgzManifest(pkgJson) {
  if (!pkgJson || typeof pkgJson !== 'object' || Array.isArray(pkgJson)) return ['package.json 不是一个对象']
  const problems = []
  const version = String(pkgJson.version ?? '')
  if (!/^\d+\.\d+\.\d+/.test(version)) problems.push(`version 不是 x.y.z：${version || '（空）'}`)
  const deps = pkgJson.dependencies
  const depNames = deps && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps) : []
  if (depNames.length) problems.push(`dependencies 必须为空，现为 ${depNames.sort().join(', ')}`)
  const scoped = depNames.filter((n) => n === '@gitrader' || n.startsWith('@gitrader/'))
  if (scoped.length) problems.push(`不能依赖未发布的 @gitrader 包：${scoped.join(', ')}`)
  for (const field of ['peerDependencies', 'optionalDependencies']) {
    const value = pkgJson[field]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const hits = Object.keys(value).filter((n) => n === '@gitrader' || n.startsWith('@gitrader/'))
    if (hits.length) problems.push(`${field} 里不能有 @gitrader 运行时依赖：${hits.sort().join(', ')}`)
  }
  return problems
}

/**
 * 便携包内容判据：含本平台的 runtime/node(.exe)、对应启动脚本、以及 app/cli/bin.js。
 * fileList 为包内相对路径（任意分隔符都行），platform 取 win-x64 / linux-x64 / darwin-arm64 等。
 */
export function portableHasRuntime(fileList, platform) {
  const list = (Array.isArray(fileList) ? fileList : []).map(normalizeName)
  const has = (p) => list.includes(p)
  const win = String(platform).startsWith('win')
  return has(win ? 'runtime/node.exe' : 'runtime/node') && has(win ? 'start.cmd' : 'start.sh') && has('app/cli/bin.js')
}

export const BUNDLED_PLUGINS = ['notify-discord', 'notify-email', 'notify-slack', 'notify-telegram', 'notify-webhook', 'notify-wecom']

/** 发出去的包里必须有的随包资源（相对 dist/）。 */
export function requiredBundledEntries() {
  return [
    ...BUNDLED_PLUGINS.flatMap((n) => ['gitrader-plugin.json', 'gsp.mjs', 'index.mjs'].map((f) => `plugins-bundled/${n}/${f}`)),
    // R2-REL-10：内核靠这份内容哈希清单信任随包插件（不再要求开 developerMode）；漏了随包插件就会被当成未信任，所以发布前必须有。
    'plugins-bundled/BUNDLED-HASHES.json',
    'examples/strategies/grid.ts', 'examples/strategies/dca.ts', 'examples/strategy-template.ts', 'examples/README.txt',
  ]
}

/** entries = 包内文件列表；prefix = 'package/dist/'（tgz）或 'app/cli/'（便携包）。返回缺的相对路径。 */
export function missingBundled(entries, prefix) {
  const normalized = new Set((Array.isArray(entries) ? entries : []).map(normalizeName))
  const required = requiredBundledEntries().map((e) => normalizeName(`${prefix}${e}`))
  return required.filter((r) => !normalized.has(r)).map((r) => r.replace(new RegExp(`^${normalizeName(prefix)}`), ''))
}

// ---- 参数 ---------------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

export function parseArgs(argv = []) {
  const out = { out: DEFAULT_OUT, platforms: [...DEFAULT_PLATFORMS], runtimeDir: undefined, skipPortable: false, skipBuild: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    if (arg === '--skip-portable') {
      out.skipPortable = true
      continue
    }
    if (arg === '--skip-build') {
      out.skipBuild = true
      continue
    }
    const key = arg.startsWith('--') ? arg.slice(2).split('=')[0] : undefined
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[i + 1]
    if (key === 'out') out.out = value
    else if (key === 'runtime-dir') out.runtimeDir = value
    else if (key === 'platforms') out.platforms = String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else throw new UsageError(`未知参数：${arg}`)
    if (!arg.includes('=')) i += 1
    if (value === undefined || value === '') throw new UsageError(`--${key} 需要一个值`)
  }
  if (!out.platforms.length) throw new UsageError('--platforms 至少要给一个平台')
  for (const p of out.platforms) {
    if (!PORTABLE_SUPPORTED.includes(p)) throw new UsageError(`不支持的平台：${p}（可选：${PORTABLE_SUPPORTED.join(' / ')}）`)
  }
  return out
}

// ---- 失败与输出 ---------------------------------------------------------------------------

/** 某一步失败：带该步的原始输出，由入口打印末 20 行。 */
export class StepError extends Error {
  constructor(message, output = '') {
    super(message)
    this.name = 'StepError'
    this.output = String(output ?? '')
  }
}

export function tailLines(text, n = 20) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '')
  return lines.slice(-n).join('\n')
}

function textOf(result) {
  const parts = []
  if (result && result.stdout) parts.push(String(result.stdout))
  if (result && result.stderr) parts.push(String(result.stderr))
  if (result && result.error) parts.push(result.error.message)
  return parts.join('\n')
}

// ---- 各步 ---------------------------------------------------------------------------------

function readCliPackage(repoRoot) {
  const file = join(repoRoot, 'packages', 'cli', 'package.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** ① npm pack -w packages/cli --pack-destination <out> → `<name>-<version>.tgz`。 */
export function packTgz({ repoRoot, outDir, exec = spawnSync }) {
  const pkg = readCliPackage(repoRoot)
  const problems = checkTgzManifest(pkg)
  if (problems.length) throw new StepError(`packages/cli/package.json 不满足发布规则：${problems.join('；')}`)
  const result = exec('npm', ['pack', '-w', 'packages/cli', '--pack-destination', outDir], {
    cwd: repoRoot, shell: true, encoding: 'utf8',
  })
  if (result.error) throw new StepError(`npm pack 起不来：${result.error.message}`, textOf(result))
  if (result.status !== 0) throw new StepError(`npm pack 退出码 ${result.status}`, textOf(result))
  const file = join(outDir, `${pkg.name}-${pkg.version}.tgz`)
  if (!existsSync(file)) {
    const got = readdirSync(outDir).filter((n) => n.endsWith('.tgz'))
    throw new StepError(`npm pack 没产出 ${pkg.name}-${pkg.version}.tgz（目录里有：${got.join(', ') || '空'}）`, textOf(result))
  }
  return { file, version: pkg.version, name: pkg.name, output: textOf(result) }
}

async function loadPortable(repoRoot) {
  const file = join(repoRoot, 'tools', 'portable', 'build-portable.mjs')
  if (!existsSync(file)) return undefined
  try {
    const mod = await import(pathToFileURL(file).href)
    const shape = ['assembleBundle', 'packBundle', 'recordArchive', 'readRepoVersion']
    if (shape.every((k) => typeof mod[k] === 'function')) return mod
  } catch {
    // 拿不到导出就退化成子进程调用
  }
  return undefined
}

/** 便携脚本的运行时：给了 --runtime-dir 就用它，否则复用下载缓存，缓存也没有才下载。 */
async function resolveRuntimeDir(mod, { platform, runtimeDir, outDir, log }) {
  if (runtimeDir) {
    log(`运行时：${runtimeDir}`)
    return resolve(runtimeDir)
  }
  const nodeVersion = mod.DEFAULT_NODE_VERSION
  const cached = mod.runtimeCacheDir(outDir, nodeVersion, platform)
  const hit = ['node.exe', 'node'].some((n) => existsSync(join(cached, n)) || existsSync(join(cached, 'bin', n)))
  if (hit) {
    log(`复用已下载的运行时：${cached}`)
    return cached
  }
  log(`下载 Node v${nodeVersion}（${platform}）到 ${cached}`)
  return mod.downloadNodeRuntime({ version: nodeVersion, platform, destDir: cached, log })
}

/** 没有导出函数时的兜底：直接跑便携脚本（参数形状同它自己的用法）。 */
function spawnPortable(repoRoot, { platform, outDir, runtimeDir, skipBuild, exec = spawnSync }) {
  const argv = [join(repoRoot, 'tools', 'portable', 'build-portable.mjs'), '--platform', platform, '--out', outDir]
  if (runtimeDir) argv.push('--runtime-dir', resolve(runtimeDir))
  if (skipBuild) argv.push('--skip-build')
  const result = exec(process.execPath, argv, { cwd: repoRoot, encoding: 'utf8', shell: false })
  if (result.error) throw new StepError(`便携构建起不来（${platform}）：${result.error.message}`, textOf(result))
  if (result.status !== 0) throw new StepError(`便携构建失败（${platform}）退出码 ${result.status}`, textOf(result))
  const archiveName = `gitrader-${versionFromOut(outDir, platform)}-${platform}.${platform.startsWith('win') ? 'zip' : 'tar.gz'}`
  return { archive: join(outDir, archiveName), output: textOf(result) }
}

/** 兜底路径下从目录名反推版本（`gitrader-<ver>-<platform>/`）。 */
function versionFromOut(outDir, platform) {
  const hit = readdirSync(outDir).find((n) => n.startsWith('gitrader-') && n.endsWith(`-${platform}`))
  if (!hit) return 'unknown'
  return hit.slice('gitrader-'.length, hit.length - platform.length - 1)
}

/** ② 每个平台一个便携包。 */
export async function buildPortables({ repoRoot, outDir, platforms, runtimeDir, skipBuild, version, mod, log }) {
  const results = []
  for (const platform of platforms) {
    const stepLog = (m) => log(`[${platform}] ${m}`)
    if (!mod) {
      const r = spawnPortable(repoRoot, { platform, outDir, runtimeDir, skipBuild })
      stepLog(`压缩包：${r.archive}`)
      results.push({ platform, archive: r.archive })
      continue
    }
    const dir = await resolveRuntimeDir(mod, { platform, runtimeDir, outDir, log: stepLog })
    if (skipBuild) stepLog('跳过 npm run build -w gitrader（--skip-build）')
    else mod.runBuild(repoRoot, { log: stepLog })
    const { bundleDir } = mod.assembleBundle({
      repoRoot, platform, runtimeDir: dir, outDir, version, nodeVersion: mod.DEFAULT_NODE_VERSION, log: stepLog,
    })
    const archive = mod.packBundle(bundleDir, platform, { log: stepLog })
    mod.recordArchive(bundleDir, archive)
    stepLog(`压缩包：${archive.archive}（sha256 ${String(archive.sha256).slice(0, 16)}…）`)
    results.push({ platform, archive: archive.archive })
  }
  return results
}

/** ③ 收集 out 下所有 .tgz / .zip / .tar.gz（跳过运行时缓存）。 */
export function collectArchives(outDir) {
  const out = []
  const stack = [outDir]
  while (stack.length) {
    const dir = stack.pop()
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const st = statSync(abs)
      if (st.isDirectory()) {
        if (name === CACHE_DIR) continue
        stack.push(abs)
      } else if (st.isFile() && ARCHIVE_RE.test(name)) {
        out.push({ name: relative(outDir, abs).split(sep).join('/'), abs })
      }
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** ④ 说明模板：版本、三种装法、SHA256 校验，中文。 */
export function releaseNotes({ version, assets, platforms }) {
  const list = assets.length ? assets.map((a) => `- \`${a.name}\``).join('\n') : '- （本次没产出压缩包）'
  const platformHelp = platforms.map((p) => (p.startsWith('win') ? `${p}：解压后双击 \`start.cmd\`` : `${p}：解压后执行 \`./start.sh\``)).join('\n')
  return [
    `# Gitrader ${version}`,
    '',
    '## 三种装法（选一种）',
    '',
    `A. 一行命令（已发布到 npm）：需要 Node >= 22.13。\`npx gitrader@${version} init\`，然后 \`npx gitrader@${version} serve\`。`,
    '',
    `B. 用本页的 tgz：从本页下载 \`gitrader-${version}.tgz\`，\`npm install -g gitrader-${version}.tgz\`，然后 \`gitrader init\`、\`gitrader serve\`。`,
    '',
    'C. 便携包（不用装 Node）：下载对应平台的压缩包，解压后按下面的方式启动；终端会打印一条 2 分钟有效、只能用一次的链接。',
    '',
    platformHelp,
    '',
    '装好后运行 `gitrader doctor` 自检（全绿即可开始）。',
    '',
    '## 本次产物',
    '',
    list,
    '',
    '## 校验下载的文件',
    '',
    '同一目录下有 `SHA256SUMS`（每行 `<sha256>  文件名`）。Linux / macOS：',
    '',
    '```',
    'sha256sum -c SHA256SUMS',
    '```',
    '',
    'Windows PowerShell：',
    '',
    '```',
    'Get-FileHash .\\gitrader-' + version + '.tgz -Algorithm SHA256',
    '# 与 SHA256SUMS 里对应那一行比对，必须一致',
    '```',
    '',
    '## 说明',
    '',
    '- 默认只在本机 127.0.0.1 上监听；默认走测试网和纸面账户。',
    '- 便携包与里面的 Node 运行时都没有代码签名，Windows 首次运行可能弹 SmartScreen 提示；发行方身份与每个文件的哈希见包内 manifest.json。',
    '- 数据在 `~/.gitrader`（环境变量 `GITRADER_HOME` 可改）；删掉这个目录即可卸载。',
    '',
  ].join('\n')
}

// ---- 入口 ---------------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), {
  repoRoot = REPO_ROOT, err = (s) => process.stderr.write(s), out = (s) => process.stdout.write(s),
} = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    out(USAGE)
    return 0
  }
  const log = (m) => err(`[release] ${m}\n`)
  const outDir = resolve(args.out)
  try {
    mkdirSync(outDir, { recursive: true })
    log(`输出目录：${outDir}`)

    const packed = packTgz({ repoRoot, outDir })
    log(`npm 包：${packed.file}（${(statSync(packed.file).size / 1024).toFixed(0)} KB）`)

    const assets = [{ name: `${packed.name}-${packed.version}.tgz` }]
    if (!args.skipPortable) {
      const mod = await loadPortable(repoRoot)
      if (!mod) log('没拿到 tools/portable/build-portable.mjs 的导出，改用子进程调用')
      const built = await buildPortables({
        repoRoot, outDir, platforms: args.platforms, runtimeDir: args.runtimeDir,
        skipBuild: args.skipBuild, version: packed.version, mod, log,
      })
      for (const b of built) assets.push({ name: relative(outDir, b.archive).split(sep).join('/') })
    } else {
      log('跳过便携包（--skip-portable）')
    }

    const archives = collectArchives(outDir)
    if (!archives.length) throw new StepError('产物目录里没有任何 .tgz / .zip / .tar.gz，SHA256SUMS 无从生成')
    const sums = sha256sums(archives.map((a) => ({ name: a.name, bytes: readFileSync(a.abs) })))
    writeFileSync(join(outDir, 'SHA256SUMS'), sums)
    log(`SHA256SUMS：${archives.length} 个文件`)

    const notes = releaseNotes({ version: packed.version, assets, platforms: args.platforms })
    writeFileSync(join(outDir, 'RELEASE-NOTES.md'), notes)
    log('RELEASE-NOTES.md 已写入')

    out(`${archives.map((a) => `${a.name}\n`).join('')}SHA256SUMS\nRELEASE-NOTES.md\n`)
    return 0
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    err(`错误：${message}\n`)
    const output = e instanceof StepError ? e.output : ''
    if (output.trim()) err(`该步原始输出（末 20 行）：\n${tailLines(output, 20)}\n`)
    return 1
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main().then((code) => { process.exitCode = code })
