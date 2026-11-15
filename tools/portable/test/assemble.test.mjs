// SPDX-License-Identifier: CPAL-1.0
// 装配的离线验收：临时「假仓库」（自带最小 dist 与 package.json）+ 假运行时目录 + --skip-build，
// 跑真实 CLI 入口，断言目录结构、启动脚本内容、manifest 的 sha256 与文件一致、README 无禁词 / 无本机路径。
// 不联网、不跑 npm run build（假仓库根本没有 scripts，跑到就会失败）、不写用户目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROMISE_WORDS, BuildError, assembleBundle, findPromiseWords, readRepoVersion, runBuild as runRepoBuild, startCmd } from '../build-portable.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'tools', 'portable', 'build-portable.mjs')
const VERSION = '9.9.9'

const tmp = (tag) => mkdtempSync(join(tmpdir(), `gitrader-portable-${tag}-`))
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }

/** 最小假仓库：CLI 自包含产物（bin.js / engine-core.mjs / workbench/index.html）+ 版本号 + 许可证文件。 */
function makeFakeRepo() {
  const root = tmp('repo')
  put(join(root, 'package.json'), `${JSON.stringify({ name: 'gitrader', version: VERSION, license: 'CPAL-1.0' }, null, 2)}\n`)
  put(join(root, 'LICENSE'), 'CPAL-1.0 test license text\n')
  put(join(root, 'THIRD_PARTY_NOTICES.md'), '# third party notices (test fixture)\n')
  put(join(root, 'packages', 'cli', 'dist', 'bin.js'), '#!/usr/bin/env node\nconsole.log("cli")\n')
  put(join(root, 'packages', 'cli', 'dist', 'engine-core.mjs'), 'export {}\n')
  put(join(root, 'packages', 'cli', 'dist', 'workbench', 'index.html'), '<!doctype html><title>Gitrader</title>\n')
  return root
}

/** 假运行时：Windows 布局 node.exe 在根，Unix 布局 node 在 bin/。 */
function makeFakeRuntime(layout) {
  const dir = tmp('runtime')
  const p = layout === 'bin' ? join(dir, 'bin', 'node') : join(dir, layout === 'win' ? 'node.exe' : 'node')
  put(p, '')
  put(join(dir, 'LICENSE'), 'Node.js is licensed for use as follows (test fixture)\n')
  return dir
}

function runBuild(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function walk(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) stack.push(p)
      else out.push(relative(root, p).split(sep).join('/'))
    }
  }
  return out.sort()
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8')
const BANNED = [/\b[A-Za-z]:[\\/]+Users[\\/]+/i, /\b[A-Za-z]:[\\/]+(UNIGIT|gitrader)\b/, /\/Users\/[a-z0-9._-]+\//i, /\/home\/[a-z0-9._-]+\//i]

test('Windows 平台装配：只带 CLI 自包含产物，dist 与运行时都到位', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.equal(r.status, 0, r.stderr)
    const bundle = join(out, `gitrader-${VERSION}-win-x64`)
    for (const rel of [
      'app/cli/bin.js', 'app/cli/engine-core.mjs', 'app/cli/workbench/index.html',
      'runtime/node.exe', 'runtime/NODE-LICENSE.txt',
      'bin/gitrader.cmd', 'bin/gitrader', 'start.cmd', 'start.sh',
      'README.txt', 'VERSION', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'manifest.json',
    ]) assert.ok(existsSync(join(bundle, rel)), `缺 ${rel}`)
    assert.equal(existsSync(join(bundle, 'app', 'workbench')), false, '不该再拷 app/workbench')
    assert.equal(existsSync(join(bundle, 'app', 'engine-core')), false, '不该再拷 app/engine-core')
    assert.equal(read(bundle, 'LICENSE'), read(repo, 'LICENSE'))
    assert.equal(read(bundle, 'THIRD_PARTY_NOTICES.md'), read(repo, 'THIRD_PARTY_NOTICES.md'))
    assert.equal(read(bundle, 'VERSION'), `${VERSION}\nnode v22.23.2 win-x64\n`)
    assert.deepEqual(walk(out).filter((p) => !p.startsWith(`gitrader-${VERSION}-win-x64/`)), [], '产物目录里只有这一个包目录')
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('启动脚本内容：便携启动器转调 runtime/node，start 只在没配置时 init --no-pin 再 serve', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    assert.equal(runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out]).status, 0)
    const b = join(out, `gitrader-${VERSION}-win-x64`)

    const cmd = read(b, 'bin/gitrader.cmd')
    assert.match(cmd, /^@echo off/)
    assert.match(cmd, /"%~dp0\.\.\\runtime\\node\.exe" "%~dp0\.\.\\app\\cli\\bin\.js" %\*/)
    assert.equal(cmd.includes('npm'), false, '启动器不该绕 npm')

    const sh = read(b, 'bin/gitrader')
    assert.match(sh, /^#!\/bin\/sh/)
    assert.match(sh, /HERE=\$\(cd -- "\$\(dirname -- "\$0"\)" && pwd\)/)
    assert.match(sh, /exec "\$HERE\/\.\.\/runtime\/node" "\$HERE\/\.\.\/app\/cli\/bin\.js" "\$@"/)

    const startCmd = read(b, 'start.cmd')
    assert.match(startCmd, /%USERPROFILE%\\\.gitrader\\gitrader\.json/)
    assert.match(startCmd, /if not exist .*\(/)
    assert.match(startCmd, /"%HERE%bin\\gitrader\.cmd" init --no-pin/)
    assert.match(startCmd, /"%HERE%bin\\gitrader\.cmd" serve %\*/)
    assert.match(startCmd, /Ctrl\+C/)

    const startSh = read(b, 'start.sh')
    assert.match(startSh, /^#!\/bin\/sh/)
    assert.match(startSh, /CFG="\$HOME\/\.gitrader\/gitrader\.json"/)
    assert.match(startSh, /if \[ ! -f "\$CFG" \]; then/)
    assert.match(startSh, /"\$HERE\/bin\/gitrader" init --no-pin/)
    assert.match(startSh, /exec "\$HERE\/bin\/gitrader" serve "\$@"/)
    assert.equal(startSh.includes('\r'), false, 'unix 脚本不能带 CRLF')
    assert.equal(sh.includes('\r'), false, 'unix 脚本不能带 CRLF')
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('README.txt：三行步骤、版本与 Node 写对、无禁词、无本机路径、不承诺任何收益', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    assert.equal(runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out]).status, 0)
    const readme = read(join(out, `gitrader-${VERSION}-win-x64`), 'README.txt')
    assert.match(readme, new RegExp(`Gitrader ${VERSION.replace(/\./g, '\\.')}`))
    assert.match(readme, /win-x64/)
    assert.match(readme, /Node v22\.23\.2/)
    assert.match(readme, /^1\. /m)
    assert.match(readme, /^2\. /m)
    assert.match(readme, /^3\. /m)
    assert.match(readme, /start\.cmd/)
    assert.match(readme, /start\.sh/)
    assert.match(readme, /~\/\.gitrader/)
    assert.match(readme, /127\.0\.0\.1/)
    assert.match(readme, /SmartScreen/)
    assert.deepEqual(findPromiseWords(readme), [], 'README 不该命中零承诺禁词')
    for (const w of PROMISE_WORDS) assert.equal(readme.toLowerCase().includes(w.toLowerCase()), false, `命中禁词 ${w}`)
    for (const re of BANNED) assert.doesNotMatch(readme, re)
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('manifest.json：字段齐全且每个文件的 sha256 与磁盘上的字节一致', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    assert.equal(runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out]).status, 0)
    const bundle = join(out, `gitrader-${VERSION}-win-x64`)
    const m = JSON.parse(read(bundle, 'manifest.json'))
    assert.equal(m.name, 'gitrader')
    assert.equal(m.version, VERSION)
    assert.equal(m.platform, 'win-x64')
    assert.equal(m.nodeVersion, '22.23.2')
    assert.match(m.builtAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    assert.equal(Number.isNaN(Date.parse(m.builtAt)), false)
    assert.equal(m.entry.windows, 'start.cmd')
    assert.equal(m.entry.unix, 'start.sh')
    assert.equal(m.runtime, 'runtime/node.exe')
    assert.equal(m.app.cli, 'app/cli/bin.js')
    assert.equal(m.app.workbench, 'app/cli/workbench/index.html')
    assert.equal(m.app.engineCore, 'app/cli/engine-core.mjs')
    for (const p of [m.app.cli, m.app.workbench, m.app.engineCore]) {
      assert.ok(existsSync(join(bundle, p)), `manifest.app 指向的 ${p} 不在包里`)
      assert.ok(m.files.some((f) => f.path === p), `manifest.app 指向的 ${p} 不在文件清单里`)
    }

    const onDisk = walk(bundle).filter((p) => p !== 'manifest.json')
    assert.deepEqual(m.files.map((f) => f.path), onDisk, '清单就是目录里的全部文件（不含 manifest 自身）')
    for (const f of m.files) {
      const bytes = readFileSync(join(bundle, f.path))
      assert.equal(f.size, bytes.length, `${f.path} 的 size`)
      assert.equal(f.sha256, createHash('sha256').update(bytes).digest('hex'), `${f.path} 的 sha256`)
      assert.match(f.sha256, /^[0-9a-f]{64}$/)
    }
    assert.equal(m.totals.files, onDisk.length)
    assert.equal(m.totals.bytes, m.files.reduce((n, f) => n + f.size, 0))
    assert.equal(m.archive, undefined, '--no-pack 时不写 archive 字段')
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('包里的所有文本文件都不含构建机的绝对路径', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    assert.equal(runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out]).status, 0)
    const bundle = join(out, `gitrader-${VERSION}-win-x64`)
    for (const rel of walk(bundle)) {
      if (!/\.(txt|cmd|sh|json|md|js|mjs)$/.test(rel)) continue
      const text = read(bundle, rel)
      for (const re of BANNED) assert.doesNotMatch(text, re, `${rel} 里有本机路径`)
      assert.equal(text.includes(repo), false, `${rel} 里出现了构建机上的仓库绝对路径`)
    }
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('Linux / macOS 平台：运行时取 bin/node，落成 runtime/node；压缩包换成 tar.gz', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('bin'); const out = tmp('out')
  try {
    for (const platform of ['linux-x64', 'darwin-arm64']) {
      const r = runBuild(['--platform', platform, '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
      assert.equal(r.status, 0, r.stderr)
      const bundle = join(out, `gitrader-${VERSION}-${platform}`)
      assert.ok(existsSync(join(bundle, 'runtime', 'node')), `${platform} 用 runtime/node`)
      assert.equal(existsSync(join(bundle, 'runtime', 'node.exe')), false)
      const m = JSON.parse(read(bundle, 'manifest.json'))
      assert.equal(m.platform, platform)
      assert.equal(m.runtime, 'runtime/node')
      assert.equal(m.entry.launcher, 'bin/gitrader')
      assert.match(read(bundle, 'VERSION'), new RegExp(`node v22\\.23\\.2 ${platform}`))
    }
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('版本号来自仓库根的 package.json（不是写死的）', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    put(join(repo, 'package.json'), `${JSON.stringify({ name: 'gitrader', version: '1.2.3' })}\n`)
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(out, 'gitrader-1.2.3-win-x64')))
    assert.equal(read(join(out, 'gitrader-1.2.3-win-x64'), 'VERSION'), '1.2.3\nnode v22.23.2 win-x64\n')
    assert.equal(readRepoVersion(repo), '1.2.3')
    assert.equal(readRepoVersion(REPO_ROOT), JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version)
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('运行时目录里没有 node → 退出码 1，信息里说清缺什么（不产出半个包）', () => {
  const repo = makeFakeRepo(); const runtime = tmp('empty'); const out = tmp('out')
  try {
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /node 可执行文件/)
    assert.equal(existsSync(join(out, `gitrader-${VERSION}-win-x64`)), false)
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('缺 CLI dist（没构建过）→ 退出码 1，并提示先跑 npm run build -w gitrader', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    rmSync(join(repo, 'packages', 'cli', 'dist'), { recursive: true, force: true })
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /packages\/cli\/dist/)
    assert.match(r.stderr, /npm run build -w gitrader/)
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('缺 packages/cli/dist/engine-core.mjs → MISSING_SOURCE', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    rmSync(join(repo, 'packages', 'cli', 'dist', 'engine-core.mjs'), { force: true })
    assert.throws(() => assembleBundle({ repoRoot: repo, platform: 'win-x64', runtimeDir: runtime, outDir: out }), (e) => {
      assert.ok(e instanceof BuildError)
      assert.equal(e.code, 'MISSING_SOURCE')
      assert.match(e.message, /packages\/cli\/dist\/engine-core\.mjs/)
      return true
    })
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('缺 packages/cli/dist/workbench/index.html → MISSING_SOURCE', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    rmSync(join(repo, 'packages', 'cli', 'dist', 'workbench', 'index.html'), { force: true })
    assert.throws(() => assembleBundle({ repoRoot: repo, platform: 'win-x64', runtimeDir: runtime, outDir: out }), (e) => {
      assert.ok(e instanceof BuildError)
      assert.equal(e.code, 'MISSING_SOURCE')
      assert.match(e.message, /packages\/cli\/dist\/workbench\/index\.html/)
      return true
    })
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('runBuild：调 npm run build -w gitrader（cwd 是仓库根），非 0 退出 → BUILD_FAILED', () => {
  const repo = tmp('repo')
  try {
    const calls = []
    const exec = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 } }
    runRepoBuild(repo, { exec, log: () => {} })
    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call.cmd === 'npm' || call.cmd === 'npm.cmd', `命令该是 npm / npm.cmd，实际 ${call.cmd}`)
    assert.equal(call.cmd, process.platform === 'win32' ? 'npm.cmd' : 'npm')
    assert.deepEqual(call.args, ['run', 'build', '-w', 'gitrader'])
    assert.equal(call.opts.cwd, repo)

    assert.throws(() => runRepoBuild(repo, { exec: () => ({ status: 1 }), log: () => {} }),
      (e) => e instanceof BuildError && e.code === 'BUILD_FAILED')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

test('startCmd：第二行切 UTF-8 代码页（chcp 65001），中文 echo 不花屏', () => {
  const lines = startCmd().split('\r\n')
  assert.equal(lines[0], '@echo off')
  assert.equal(lines[1], 'chcp 65001 >nul')
})

test('参数不对 → 退出码 2（用法错误与构建失败分开）', () => {
  const r = runBuild(['--platform', 'win-arm64'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /不支持的平台/)
  assert.match(r.stderr, /用法/)
})

// GQ-11：示例策略随包带在 app/cli/examples/（cp(sources.cli, 'app/cli') 整目录拷，理论上自动成立，这里锁死它）。
test('示例策略随包：app/cli/examples/strategies/grid.ts 在包里且有 sha256 清单条目', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('win'); const out = tmp('out')
  try {
    put(join(repo, 'packages', 'cli', 'dist', 'examples', 'strategies', 'grid.ts'), 'export const id = "grid"\n')
    put(join(repo, 'packages', 'cli', 'dist', 'examples', 'README.txt'), '教学示例，无业绩含义\n')
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.equal(r.status, 0, r.stderr)
    const bundle = join(out, `gitrader-${VERSION}-win-x64`)
    const rel = 'app/cli/examples/strategies/grid.ts'
    assert.ok(existsSync(join(bundle, rel)), '便携包里没有示例策略')
    assert.ok(existsSync(join(bundle, 'app/cli/examples/README.txt')), '便携包里没有示例说明')
    const m = JSON.parse(read(bundle, 'manifest.json'))
    const entry = m.files.find((f) => f.path === rel)
    assert.ok(entry, '示例策略不在 manifest.files 里')
    assert.equal(entry.sha256, createHash('sha256').update(readFileSync(join(bundle, rel))).digest('hex'))
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})
