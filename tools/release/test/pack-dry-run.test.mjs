// SPDX-License-Identifier: CPAL-1.0
// pack-dry-run.mjs 的验收用例：真仓库的 npm pack 产物只含允许文件；伪造坏产物（map / test / 缺 LICENSE /
// 入口不在包里 / 未被 files 点名）一律退出非 0。夹具走 --input，不跑 npm，离线。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'
import { REPO, hasDist, makeRoot, runScript, writeJson } from './helpers.mjs'

const PKG = {
  name: '@fixture/pkg',
  version: '0.1.0',
  license: 'CPAL-1.0',
  bin: { fixture: './dist/bin.js' },
  main: './dist/index.mjs',
  files: ['dist/', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'],
}
const GOOD = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'dist/bin.js', 'dist/index.mjs', 'dist/bin.js.LEGAL.txt']

function runFixture(files, pkg = PKG) {
  const f = makeRoot({ 'pkg.json': '{}' })
  try {
    const input = writeJson(f.root, 'pack.json', { package: pkg, files })
    return runScript('pack-dry-run.mjs', ['--input', input])
  } finally { f.cleanup() }
}

test('真仓库：npm pack --dry-run 产物只含允许文件，退出 0', { skip: !hasDist() && 'packages/cli/dist 不存在（干净检出尚未构建）' }, () => {
  const r = runScript('pack-dry-run.mjs')
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /gitrader: \d+ 个文件、\d+ 个入口/)
  assert.match(r.output, /npm 产物审计通过/)
})

test('干净夹具产物：退出 0', () => {
  const r = runFixture(GOOD)
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /@fixture\/pkg: 8 个文件、2 个入口/)
})

test('产物里有 source map：退出非 0', () => {
  const r = runFixture([...GOOD, 'dist/bin.js.map'])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /dist\/bin\.js\.map（source map）/)
})

test('产物里有 test/ 目录：退出非 0', () => {
  const r = runFixture([...GOOD, 'test/pack.test.mjs'])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /test\/pack\.test\.mjs（测试 \/ 源码 \/ 内部记录目录）/)
})

test('产物里缺 LICENSE：退出非 0', () => {
  const r = runFixture(GOOD.filter((p) => p !== 'LICENSE'))
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /产物里缺 LICENSE/)
})

test('package.json 的 bin 指向的文件不在产物里：退出非 0', () => {
  const r = runFixture(GOOD.filter((p) => p !== 'dist/bin.js'))
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /package\.json 指向的入口 dist\/bin\.js 不在产物里/)
})

test('产物里混进 files 字段没点名的文件：退出非 0', () => {
  const r = runFixture([...GOOD, 'extra/notes.txt'])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /extra\/notes\.txt 既不在 files 字段里/)
})

test('files 字段点名了却一个文件都没进包：退出非 0', () => {
  const r = runFixture(GOOD.filter((p) => p !== 'THIRD-PARTY-NOTICES.md'))
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /files 字段点名了 THIRD-PARTY-NOTICES\.md/)
})

test('产物为空：退出非 0', () => {
  const r = runFixture([])
  assert.equal(r.status, 1, r.output)
  assert.match(r.output, /产物为空/)
})

test('dist/ 里的 .ts 源码与 dist/ 外的 .d.ts 都算违规（只有 dist/ 下的 .d.ts 放行）', () => {
  const bad = runFixture([...GOOD, 'dist/src-helper.ts'])
  assert.equal(bad.status, 1, bad.output)
  assert.match(bad.output, /dist\/src-helper\.ts（源码 \/ 配置文件/)
  const good = runFixture([...GOOD, 'dist/index.d.ts'])
  assert.equal(good.status, 0, good.output)
})

test('包目录名含不安全字符：不拼进 shell，记为失败', async () => {
  const { runNpmPacks } = await import('../pack-dry-run.mjs')
  const f = makeRoot({
    'package.json': '{"name":"fixture-root","private":true,"workspaces":["packages/*"]}',
    'packages/bad dir/package.json': '{"name":"@fixture/bad","version":"0.1.0","files":["dist/"]}',
  })
  try {
    const results = runNpmPacks(f.root)
    assert.equal(results.length, 1)
    assert.match(results[0].error, /不安全字符/)
    assert.deepEqual(results[0].files, [])
  } finally { f.cleanup() }
})

test('GQ-10：dist/python-engine 下的 .py 与 dist/examples 下的 .ts：放行（随包资源）', () => {
  const r = runFixture([
    ...GOOD,
    'dist/python-engine/engine/main.py',
    'dist/examples/strategies/grid.ts',
    'dist/plugins-bundled/notify-webhook/gsp.mjs',
    'dist/plugins-bundled/notify-webhook/gitrader-plugin.json',
  ])
  assert.equal(r.status, 0, r.output)
})

test('GQ-10 反例：放行只限那两个前缀——别处的 .ts / .py、examples 下的 source map 与 test/ 照旧拒绝', () => {
  assert.equal(runFixture([...GOOD, 'dist/other/x.ts']).status, 1)
  assert.equal(runFixture([...GOOD, 'dist/other/x.py']).status, 1)
  assert.equal(runFixture([...GOOD, 'dist/examples/strategies/grid.ts.map']).status, 1)
  assert.equal(runFixture([...GOOD, 'dist/examples/test/foo.ts']).status, 1)
})
