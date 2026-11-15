// SPDX-License-Identifier: CPAL-1.0
// deps-audit.mjs 的验收用例：真仓库退出 0；伪造未登记第三方依赖 / 工作区包版本写错 / 幽灵工作区包 /
// 白名单范围不符 / 白名单过期，一律退出非 0。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { makeRoot, rootPkgJson, runScript, writeJson } from './helpers.mjs'

const WHITELIST = {
  allow: {
    ajv: { ranges: ['^8.20.0'], reason: 'JSON Schema 校验，MIT（测试白名单条目）' },
    ws: { ranges: ['^8.22.0'], reason: 'WebSocket 客户端，MIT（测试白名单条目）' },
  },
}

function fixtureRoot(packages, whitelist = WHITELIST) {
  const files = { 'package.json': rootPkgJson() }
  for (const [dir, pkg] of Object.entries(packages)) files[`packages/${dir}/package.json`] = JSON.stringify(pkg, null, 2)
  const f = makeRoot(files)
  const wl = writeJson(f.root, 'allow.json', whitelist)
  return { ...f, wl }
}

test('真仓库：运行时依赖全是工作区包或白名单，退出 0，并列出第三方依赖', () => {
  const r = runScript('deps-audit.mjs')
  assert.equal(r.status, 0, r.output)
  assert.match(r.output, /依赖边界审计通过/)
  assert.match(r.output, /第三方运行时依赖 ajv@\^8\.20\.0 ← /)
  assert.match(r.output, /第三方运行时依赖共 \d+ 个名字 \/ \d+ 处引用/)
})

test('未登记的第三方依赖：退出非 0，并点名 left-pad', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { 'left-pad': '^1.3.0' } },
  })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /未登记的第三方依赖 left-pad@\^1\.3\.0/)
  } finally { f.cleanup() }
})

test('白名单里的包但版本范围不符：退出非 0', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { ajv: '^9.0.0' } },
  })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /ajv@\^9\.0\.0 不在白名单允许范围/)
  } finally { f.cleanup() }
})

test('工作区包却写了具体版本号：退出非 0', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { '@fixture/b': '*' } },
    b: { name: '@fixture/b', version: '0.1.0', license: 'CPAL-1.0', dependencies: { '@fixture/a': '^0.1.0' } },
  })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /依赖工作区包 @fixture\/a，版本应写 "\*"（现在 \^0\.1\.0）/)
  } finally { f.cleanup() }
})

test('幽灵工作区包（@gitrader/typo 不在工作区）：退出非 0', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { '@gitrader/typo': '*' } },
  })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /依赖 @gitrader\/typo，但工作区里没有这个包/)
  } finally { f.cleanup() }
})

test('白名单过期（条目没人用）：退出非 0，要求删掉', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { ajv: '^8.20.0' } },
  })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /白名单条目 ws 没有被任何包使用/)
  } finally { f.cleanup() }
})

test('干净夹具（工作区包 * + 白名单包）：退出 0，并逐条列出第三方依赖', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { '@fixture/b': '*', ajv: '^8.20.0' } },
    b: { name: '@fixture/b', version: '0.1.0', license: 'CPAL-1.0', dependencies: { ws: '^8.22.0' } },
  })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 0, r.output)
    assert.match(r.output, /2 个工作区包/)
    assert.match(r.output, /第三方运行时依赖 ajv@\^8\.20\.0 ← @fixture\/a/)
    assert.match(r.output, /第三方运行时依赖 ws@\^8\.22\.0 ← @fixture\/b/)
    assert.match(r.output, /第三方运行时依赖共 2 个名字 \/ 2 处引用/)
  } finally { f.cleanup() }
})

test('白名单条目缺 reason：退出非 0', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { ajv: '^8.20.0', ws: '^8.22.0' } },
  }, { allow: { ajv: { ranges: ['^8.20.0'], reason: 'JSON Schema 校验，MIT（测试白名单条目）' }, ws: { ranges: ['^8.22.0'], reason: '' } } })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /白名单 ws 必须写 reason/)
  } finally { f.cleanup() }
})

test('包依赖自己：退出非 0', () => {
  const f = fixtureRoot({
    a: { name: '@fixture/a', version: '0.1.0', license: 'CPAL-1.0', dependencies: { '@fixture/a': '*' } },
  })
  try {
    const r = runScript('deps-audit.mjs', ['--root', f.root, '--whitelist', f.wl])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /@fixture\/a 依赖自己/)
  } finally { f.cleanup() }
})
