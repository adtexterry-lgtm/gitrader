// SPDX-License-Identifier: CPAL-1.0
// GQ-61：便携包清单里的 Node 版本必须是运行时的真实版本，不是请求的缺省值；
// README.txt 要写清便携包怎么跑其它命令、怎么改端口与数据目录。
// 正反两向：问得到运行时 → 用真实版本；问不到（假可执行文件 / 跨平台）→ 退回目录名，再不行退回请求值；
// 版本低于 22.13 必须失败（RUNTIME_TOO_OLD），不许悄悄产出低版本包。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PLATFORMS, PROMISE_WORDS, detectPlatform, detectRuntimeNodeVersion, findPromiseWords } from '../build-portable.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'tools', 'portable', 'build-portable.mjs')
const VERSION = '9.9.9'

const tmp = (tag) => mkdtempSync(join(tmpdir(), `gitrader-runtime-${tag}-`))
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }

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

/** 假运行时目录，目录名可控（跨平台打包只能靠官方解压目录名 `node-v<版本>-<平台>` 认版本）。 */
function makeFakeRuntime(dirName) {
  const root = tmp('runtime')
  put(join(root, dirName, 'node.exe'), '')
  put(join(root, dirName, 'LICENSE'), 'Node.js is licensed for use as follows (test fixture)\n')
  return join(root, dirName)
}

function runBuild(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8')
const BANNED = [/\b[A-Za-z]:[\\/]+Users[\\/]+/i, /\b[A-Za-z]:[\\/]+(UNIGIT|gitrader)\b/, /\/Users\/[a-z0-9._-]+\//i, /\/home\/[a-z0-9._-]+\//i]

test('detectRuntimeNodeVersion 同平台：直接问运行时本身', () => {
  const exec = () => ({ status: 0, stdout: 'v22.23.2\n', stderr: '' })
  assert.equal(detectRuntimeNodeVersion('/any/node', detectPlatform(), { exec }), '22.23.2')
})

test('detectRuntimeNodeVersion 问不出来（假可执行文件）→ 回退目录名；目录名也没有 → undefined', () => {
  const bad = () => ({ error: new Error('EFTYPE'), status: null })
  assert.equal(detectRuntimeNodeVersion('/x/node-v22.99.1-win-x64/node.exe', detectPlatform(), { exec: bad }), '22.99.1')
  assert.equal(detectRuntimeNodeVersion('/x/runtime/node.exe', detectPlatform(), { exec: bad }), undefined)
  // 非零退出 / 输出不是 vX.Y.Z 也不认
  assert.equal(detectRuntimeNodeVersion('/x/runtime/node.exe', detectPlatform(), { exec: () => ({ status: 1, stdout: 'v22.99.1\n' }) }), undefined)
  assert.equal(detectRuntimeNodeVersion('/x/runtime/node.exe', detectPlatform(), { exec: () => ({ status: 0, stdout: 'system node 22.99.1\n' }) }), undefined)
})

test('detectRuntimeNodeVersion 跨平台：不尝试执行（exec 不得被调用），只认目录名', () => {
  const other = PLATFORMS.find((p) => p !== detectPlatform())
  let called = 0
  const exec = () => { called += 1; return { status: 0, stdout: 'v20.0.0\n' } }
  assert.equal(detectRuntimeNodeVersion(`/x/node-v22.23.2-${other}/bin/node`, other, { exec }), '22.23.2')
  assert.equal(called, 0, '跨平台时不该执行对方的可执行文件')
  assert.equal(detectRuntimeNodeVersion(`/x/runtime/bin/node`, other, { exec }), undefined)
})

test('assembleBundle：运行时目录叫 node-v22.99.1-win-x64 → VERSION / manifest / README 都写 22.99.1（不是请求的 22.23.2）', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('node-v22.99.1-win-x64'); const out = tmp('out')
  try {
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.equal(r.status, 0, r.stderr)
    const bundle = join(out, `gitrader-${VERSION}-win-x64`)
    assert.equal(read(bundle, 'VERSION'), `${VERSION}\nnode v22.99.1 win-x64\n`)
    const m = JSON.parse(read(bundle, 'manifest.json'))
    assert.equal(m.nodeVersion, '22.99.1')
    assert.match(read(bundle, 'README.txt'), /Node v22\.99\.1/)
    assert.doesNotMatch(read(bundle, 'README.txt'), /Node v22\.23\.2/)
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('运行时版本低于 22.13 → 失败码 RUNTIME_TOO_OLD，不产出包', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('node-v22.12.0-win-x64'); const out = tmp('out')
  try {
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /RUNTIME_TOO_OLD/)
    assert.equal(
      existsSync(out) ? readdirSync(out).filter((n) => n.startsWith(`gitrader-${VERSION}`)).length : 0,
      0, '失败时不该留下半个包',
    )
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('README.txt：保留 1–3 步，新增第 4、5 步，提到 bin\\gitrader.cmd、--port、GITRADER_HOME，且过禁词与本机路径检查', () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime('node-v22.23.2-win-x64'); const out = tmp('out')
  try {
    const r = runBuild(['--platform', 'win-x64', '--runtime-dir', runtime, '--skip-build', '--no-pack', '--repo-root', repo, '--out', out])
    assert.equal(r.status, 0, r.stderr)
    const readme = read(join(out, `gitrader-${VERSION}-win-x64`), 'README.txt')
    assert.match(readme, /^1\. /m)
    assert.match(readme, /^2\. /m)
    assert.match(readme, /^3\. /m)
    assert.match(readme, /^4\. /m)
    assert.match(readme, /^5\. /m)
    assert.match(readme, /bin\\gitrader\.cmd/)
    assert.match(readme, /bin\/gitrader/)
    assert.match(readme, /--port/)
    assert.match(readme, /GITRADER_HOME/)
    assert.match(readme, /doctor/)
    assert.deepEqual(findPromiseWords(readme), [], 'README 不该命中零承诺禁词')
    for (const w of PROMISE_WORDS) assert.equal(readme.toLowerCase().includes(w.toLowerCase()), false, `命中禁词 ${w}`)
    for (const re of BANNED) assert.doesNotMatch(readme, re)
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})
