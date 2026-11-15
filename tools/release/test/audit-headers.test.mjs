// SPDX-License-Identifier: CPAL-1.0
// audit-headers.mjs 的验收用例：真仓库退出 0，伪造坏 SPDX / 缺首行 / 基线过期 / LICENSE 不全退出非 0。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, makeRoot, pkgJson, rootPkgJson, runScript, writeBaseline } from './helpers.mjs'

const APACHE_LICENSE = '                                 Apache License\n                           Version 2.0, January 2004\n\n   Licensed under the Apache License, Version 2.0\n'

test('真仓库：所有源码首行 SPDX 与包许可证一致，退出 0', () => {
  const r = runScript('audit-headers.mjs')
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /首行 SPDX 审计通过/)
  assert.match(r.output, /根 LICENSE = CPAL-1\.0 原文 \+ Exhibit A\/B/)
})

test('干净夹具（CPAL 包 + Apache 包，TS 与 Python 各一）：退出 0', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n  - packages/ap\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/ok.ts': '// SPDX-License-Identifier: CPAL-1.0\nexport const a = 1\n',
    'packages/ap/package.json': pkgJson('@fixture/ap', { license: 'Apache-2.0' }),
    'packages/ap/LICENSE': APACHE_LICENSE,
    'packages/ap/src/x.py': '# SPDX-License-Identifier: Apache-2.0\nX = 1\n',
    'tools/x/run.mjs': '// SPDX-License-Identifier: CPAL-1.0\nexport const y = 2\n',
  })
  try {
    const baseline = writeBaseline(f.root)
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', baseline])
    assert.equal(r.status, 0, r.output)
    assert.match(r.output, /共 3 个源码文件/)
    assert.match(r.output, /\{"Apache-2\.0":1,"CPAL-1\.0":2\}/)
  } finally { f.cleanup() }
})

test('坏 SPDX（MIT）：退出非 0，并指出不在已知许可证里', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/bad.ts': '// SPDX-License-Identifier: MIT\nexport const a = 1\n',
  })
  try {
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', writeBaseline(f.root)])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /MIT 不在已知许可证/)
  } finally { f.cleanup() }
})

test('包许可证不一致（CPAL 包里写 Apache-2.0）：退出非 0', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/wrong.ts': '// SPDX-License-Identifier: Apache-2.0\nexport const a = 1\n',
  })
  try {
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', writeBaseline(f.root)])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /首行 SPDX Apache-2\.0 与 packages\/a\/package\.json 的 license CPAL-1\.0 不一致/)
  } finally { f.cleanup() }
})

test('新文件缺首行 SPDX：退出非 0', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/naked.ts': 'export const a = 1\n',
  })
  try {
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', writeBaseline(f.root)])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /packages\/a\/src\/naked\.ts: 第 1 行缺 SPDX/)
  } finally { f.cleanup() }
})

test('SPDX 写在第 2 行（第 1 行是代码）：退出非 0', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/second.mjs': '/* license below */\n// SPDX-License-Identifier: CPAL-1.0\nexport const a = 1\n',
  })
  try {
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', writeBaseline(f.root)])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /second\.mjs: 第 1 行缺 SPDX/)
  } finally { f.cleanup() }
})

test('基线登记后放行（历史例外），但输出必须点名', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/legacy.ts': 'export const a = 1\n',
  })
  try {
    const baseline = writeBaseline(f.root, [{ path: 'packages/a/src/legacy.ts', kind: 'missing', reason: '历史文件，留给主会话补首行' }])
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', baseline])
    assert.equal(r.status, 0, r.output)
    assert.match(r.output, /1 条历史例外已登记/)
    assert.match(r.output, /packages\/a\/src\/legacy\.ts/)
  } finally { f.cleanup() }
})

test('基线过期（文件已修好但条目还在）：退出非 0，要求删条目', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/fixed.ts': '// SPDX-License-Identifier: CPAL-1.0\nexport const a = 1\n',
  })
  try {
    const baseline = writeBaseline(f.root, [{ path: 'packages/a/src/fixed.ts', kind: 'missing', reason: '历史文件，留给主会话补首行' }])
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', baseline])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /请从基线删掉这条/)
  } finally { f.cleanup() }
})

test('根 LICENSE 不是 CPAL 原文 + Exhibit B：退出非 0', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n',
    LICENSE: 'Common Public Attribution License Version 1.0\n\n1. Definitions\n\nshort stub only\n',
    'packages/a/package.json': pkgJson('@fixture/a'),
    'packages/a/src/ok.ts': '// SPDX-License-Identifier: CPAL-1.0\nexport const a = 1\n',
  }, { copyLicense: false })
  try {
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', writeBaseline(f.root)])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /根 LICENSE 缺 Exhibit B 归属信息/)
    assert.match(r.output, /不像 CPAL 原文全文/)
  } finally { f.cleanup() }
})

test('Apache 包缺 LICENSE 文件：退出非 0', () => {
  const f = makeRoot({
    'package.json': rootPkgJson(),
    NOTICE: 'fixture\n  - packages/ap\n',
    'packages/ap/package.json': pkgJson('@fixture/ap', { license: 'Apache-2.0' }),
    'packages/ap/src/x.ts': '// SPDX-License-Identifier: Apache-2.0\nexport const x = 1\n',
  })
  try {
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', writeBaseline(f.root)])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /packages\/ap: package\.json 是 Apache-2\.0 但没有 LICENSE 文件/)
  } finally { f.cleanup() }
})

test('真仓库的 LICENSE 文件确实是 CPAL 原文（脚本读的就是根 LICENSE）', () => {
  const text = readFileSync(join(REPO, 'LICENSE'), 'utf8')
  assert.ok(text.length > 20000, `LICENSE 太短：${text.length}`)
  assert.match(text, /EXHIBIT B\.\s*Attribution Information/)
  // 只有 LICENSE、没有任何源码：审计必须因覆盖面为空失败，而不是静默通过
  const f = makeRoot({ 'package.json': rootPkgJson(), NOTICE: 'fixture\n' })
  try {
    const r = runScript('audit-headers.mjs', ['--root', f.root, '--baseline', writeBaseline(f.root)])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /没有找到任何源码文件/)
  } finally { f.cleanup() }
})
