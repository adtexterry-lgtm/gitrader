// SPDX-License-Identifier: CPAL-1.0
// 打包环节：本机平台走真实系统工具（Windows Compress-Archive / 其它 tar），断言压缩包结构与 manifest 记录的哈希。
// 打包工具失败时走注入的假 exec，断言错误码；全程不联网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { BuildError, packBundle, recordArchive, sha256File } from '../build-portable.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(REPO_ROOT, 'tools', 'portable', 'build-portable.mjs')
const VERSION = '9.9.9'
const PLATFORM = process.platform === 'win32' ? 'win-x64' : 'linux-x64'

const tmp = (tag) => mkdtempSync(join(tmpdir(), `gitrader-portable-${tag}-`))
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }

function walk(root) {
  const out = []
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) stack.push(p)
      else out.push(relative(root, p).split(sep).join('/'))
    }
  }
  return out.sort()
}

function makeFakeRepo() {
  const root = tmp('repo')
  put(join(root, 'package.json'), `${JSON.stringify({ name: 'gitrader', version: VERSION }, null, 2)}\n`)
  put(join(root, 'LICENSE'), 'CPAL-1.0 test license text\n')
  put(join(root, 'THIRD_PARTY_NOTICES.md'), '# third party notices (test fixture)\n')
  put(join(root, 'packages', 'cli', 'dist', 'bin.js'), '#!/usr/bin/env node\nconsole.log("cli")\n')
  put(join(root, 'packages', 'cli', 'dist', 'engine-core.mjs'), 'export {}\n')
  put(join(root, 'packages', 'cli', 'dist', 'workbench', 'index.html'), '<!doctype html><title>Gitrader</title>\n')
  return root
}

function makeFakeRuntime() {
  const dir = tmp('runtime')
  put(join(dir, PLATFORM.startsWith('win') ? 'node.exe' : 'node'), '')
  return dir
}

test(`打包（${PLATFORM}）：压缩包有唯一的包目录、manifest 的 archive 哈希与磁盘一致`, () => {
  const repo = makeFakeRepo(); const runtime = makeFakeRuntime(); const out = tmp('out')
  try {
    const r = spawnSync(process.execPath, [
      SCRIPT, '--platform', PLATFORM, '--runtime-dir', runtime, '--skip-build', '--repo-root', repo, '--out', out,
    ], { cwd: REPO_ROOT, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)

    const bundleName = `gitrader-${VERSION}-${PLATFORM}`
    const bundle = join(out, bundleName)
    const archive = join(out, `${bundleName}.${PLATFORM.startsWith('win') ? 'zip' : 'tar.gz'}`)
    assert.ok(statSync(archive).size > 1000)

    // manifest 里补写的归档信息：只有文件名与哈希，没有构建机的绝对路径
    const m = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))
    assert.equal(m.archive.name, `${bundleName}.${PLATFORM.startsWith('win') ? 'zip' : 'tar.gz'}`)
    assert.equal(m.archive.sha256, sha256File(archive))
    assert.equal(m.archive.size, statSync(archive).size)
    assert.equal(m.archive.path, undefined, 'manifest 不该记构建机的绝对路径')
    assert.equal(JSON.stringify(m).includes(out), false, 'manifest 里不该出现输出目录的绝对路径')

    // 压缩包本身：格式正确、顶层只有一个包目录（解压不会散一地）
    // 注意：PowerShell 5.1 的 Compress-Archive 在条目名里用反斜杠（Windows 资源管理器 / 7-Zip / Expand-Archive
    // 都读中央目录、照常解压），所以这里两种分隔符都认；unix 的 tar.gz 只可能是正斜杠。
    const bytes = readFileSync(archive)
    const sep = PLATFORM.startsWith('win') ? '[\\\\/]' : '/'
    for (const name of ['manifest.json', 'README.txt', 'start.cmd', 'bin/gitrader.cmd']) {
      const re = new RegExp(`${bundleName}${sep}${name.replace('/', sep)}`)
      assert.match(bytes.toString('latin1'), re, `压缩包里缺 ${name}`)
    }
    assert.equal(bytes.includes(Buffer.from(resolve(out))), false, '压缩包里不该有构建机绝对路径')
    if (PLATFORM.startsWith('win')) {
      assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'zip 本地文件头 PK\\x03\\x04')
    } else {
      assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b], 'gzip 魔数')
      const tar = gunzipSync(bytes).toString('latin1')
      assert.ok(tar.includes(`${bundleName}/manifest.json`))
      assert.ok(tar.includes(`${bundleName}/bin/gitrader`))
    }

    // 解压回来：文件清单与 manifest 完全一致（这才是用户拿到手的样子）
    const unpacked = join(out, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    const ex = PLATFORM.startsWith('win')
      ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${archive.split('/').join('\\')}' -DestinationPath '${unpacked.split('/').join('\\')}' -Force`], { encoding: 'utf8' })
      : spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' })
    assert.equal(ex.status, 0, `解压失败：${ex.stderr}`)
    const extracted = walk(join(unpacked, bundleName))
    assert.deepEqual(extracted, [...m.files.map((f) => f.path), 'manifest.json'].sort(), '解压后的文件清单与 manifest 一致（外加 manifest 自身）')
    for (const rel of ['start.cmd', 'start.sh', 'runtime/' + (PLATFORM.startsWith('win') ? 'node.exe' : 'node'), 'app/cli/bin.js']) {
      assert.ok(existsSync(join(unpacked, bundleName, rel)), `解压后缺 ${rel}`)
    }
  } finally { for (const d of [repo, runtime, out]) rmSync(d, { recursive: true, force: true }) }
})

test('打包工具全失败 → PACK_FAILED，不留下空压缩包', () => {
  const root = tmp('pack')
  try {
    const bundle = join(root, `gitrader-${VERSION}-win-x64`)
    put(join(bundle, 'README.txt'), 'x\n')
    const failing = () => ({ status: 127, stderr: 'no such tool', error: undefined })
    assert.throws(() => packBundle(bundle, 'win-x64', { exec: failing, log: () => {} }),
      (e) => e instanceof BuildError && e.code === 'PACK_FAILED')
    assert.equal(readFileSync(join(bundle, 'README.txt'), 'utf8'), 'x\n', '失败不该动包目录')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('recordArchive：只记文件名与哈希，哈希按传入值原样写入', () => {
  const root = tmp('record')
  try {
    const bundle = join(root, 'gitrader-1.0.0-linux-x64')
    put(join(bundle, 'manifest.json'), `${JSON.stringify({ name: 'gitrader', version: '1.0.0', files: [] }, null, 2)}\n`)
    const info = { archive: join(root, 'gitrader-1.0.0-linux-x64.tar.gz'), sha256: 'a'.repeat(64), size: 42 }
    const m = recordArchive(bundle, info)
    assert.equal(m.archive.name, 'gitrader-1.0.0-linux-x64.tar.gz')
    assert.equal(m.archive.sha256, 'a'.repeat(64))
    assert.equal(m.archive.size, 42)
    assert.equal('path' in m.archive, false)
    assert.equal(m.name, 'gitrader')
    assert.deepEqual(JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')), m, '补写要落盘')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
