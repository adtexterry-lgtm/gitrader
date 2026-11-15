// SPDX-License-Identifier: CPAL-1.0
// plugin-audit.mjs 的验收用例：真仓库退出 0 且 0 失败；清单申请永不可授予权限 / id 不合协议 /
// 协议真源缺失 / 源码读了未声明的密钥形状环境变量，一律退出非 0。
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, makeRoot, pkgJson, rootPkgJson, runScript } from './helpers.mjs'

const PROTOCOL_TS = readFileSync(join(REPO, 'packages/protocol/src/plugin/manifest.ts'), 'utf8')
const PROTOCOL_SCHEMA = readFileSync(join(REPO, 'packages/protocol/schemas/plugin.json'), 'utf8')
const LICENSE = readFileSync(join(REPO, 'LICENSE'), 'utf8')
/** 通知契约的唯一真源（批 11 主题二 ⑤）；夹具直接复制真文档，改文档/改清单都能触发同一套判定。 */
const NOTIFY_DOC = readFileSync(join(REPO, 'docs/notifications.md'), 'utf8')

/** 与 docs/notifications.md 工具契约一致的 notify_send（用例只改需要触发规则的那一项）。 */
function notifyTool(overrides = {}) {
  const base = {
    name: 'notify_send',
    desc: '把一条通知发到夹具通道。',
    tags: ['utility'],
    permissions: [],
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['notice', 'params'],
      properties: {
        notice: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'level', 'title', 'lines'],
          properties: {
            key: { type: 'string' },
            level: { type: 'string', enum: ['info', 'warn', 'critical'] },
            title: { type: 'string' },
            lines: { type: 'array' },
            ts: { type: 'number' },
            topic: { type: 'string' },
          },
        },
        params: { type: 'object' },
      },
    },
    output: { type: 'object', required: ['ok'] },
  }
  return { ...base, ...overrides }
}

/** 一份能过全部清单检查的最小插件清单；用例只改需要触发规则的那一项。 */
function fixtureManifest(overrides = {}) {
  return JSON.stringify({
    schema: 'gitrader-plugin/1',
    id: 'connector.fixture.demo',
    package: 'block',
    kind: 'connector',
    name: '夹具插件',
    desc: '夹具：plugin-audit 回归测试用的最小清单。',
    tags: ['fixture'],
    version: '0.1.0',
    vendor: { id: 'fixture', name: 'Fixture', kind: 'community', verified: false, url: null },
    source: {
      repo: 'local/plugin-fixture',
      commit: '0000000000000000000000000000000000000000',
      sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      fetchedAt: 1,
    },
    license: { spdx: 'CPAL-1.0', redistribute: 'bundle', notice: '夹具', commercialUse: true },
    runtime: { type: 'node', native: false, diskMB: 1 },
    entry: { module: './index.mjs', transport: 'stdio' },
    install: { by: 'user-install' },
    permissions: [],
    secrets: [],
    privacy: { hosted: false, sends: [] },
    provides: {},
    fixtures: { offline: [], smoke: [] },
    compat: { gitrader: '>=0.1.0 <0.2.0', pluginSchema: '1' },
    ...overrides,
  }, null, 2)
}

/** 假仓库：真协议真源 + 一个插件候选包；withProtocol=false 时连 protocol 目录都不建。 */
function fixtureRoot({ manifest = fixtureManifest(), files = {}, withProtocol = true, notifyDoc = NOTIFY_DOC, withNotifyDoc = true } = {}) {
  const base = {
    'package.json': rootPkgJson(),
    'packages/plugin-fixture/package.json': pkgJson('@fixture/plugin-demo', { type: 'module', main: './index.mjs' }),
    'packages/plugin-fixture/README.md': '# 夹具插件\n\n用来跑 plugin-audit 的回归用例。\n',
    'packages/plugin-fixture/LICENSE': LICENSE,
    'packages/plugin-fixture/gitrader-plugin.json': manifest,
    'packages/plugin-fixture/index.mjs': '// SPDX-License-Identifier: CPAL-1.0\nexport const entry = 1\n',
    'packages/plugin-fixture/test/smoke.test.mjs': '// SPDX-License-Identifier: CPAL-1.0\nexport const smoke = 1\n',
    ...files,
  }
  if (withProtocol) {
    base['packages/protocol/src/plugin/manifest.ts'] = PROTOCOL_TS
    base['packages/protocol/schemas/plugin.json'] = PROTOCOL_SCHEMA
  }
  if (withNotifyDoc) base['docs/notifications.md'] = notifyDoc
  return makeRoot(base)
}

test('真仓库：插件完备性体检通过，退出 0 且失败 0', () => {
  const r = runScript('plugin-audit.mjs', ['--json'])
  assert.equal(r.status, 0, r.output)
  const report = JSON.parse(r.stdout)
  assert.equal(report.exitCode, 0)
  assert.equal(report.summary.failed, 0)
  assert.equal(report.failures.length, 0)
})

test('清单申请永不可授予权限 withdraw：退出 1，命中 permissions-forbidden', () => {
  const f = fixtureRoot({ manifest: fixtureManifest({ permissions: ['withdraw'] }) })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /permissions-forbidden: .*永不可授予的权限：withdraw/)
  } finally { f.cleanup() }
})

test('协议源码改双引号 + `] as const satisfies …` 写法：永不可授予权限仍生效，退出 1', () => {
  const ts = PROTOCOL_TS.replace(
    /export const NEVER_GRANTABLE_PERMISSIONS\s*=\s*\[[\s\S]*?\]\s*as const/,
    'export const NEVER_GRANTABLE_PERMISSIONS = [\n  "withdraw", "transfer",\n] as const satisfies readonly string[]',
  )
  const f = fixtureRoot({
    manifest: fixtureManifest({ permissions: ['withdraw'] }),
    files: { 'packages/protocol/src/plugin/manifest.ts': ts },
  })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /permissions-forbidden: .*永不可授予的权限：withdraw/)
    assert.doesNotMatch(r.output, /protocol-source/)
  } finally { f.cleanup() }
})

test('清单 id 不合协议 pattern（Bad_ID）：退出 1', () => {
  const f = fixtureRoot({ manifest: fixtureManifest({ id: 'Bad_ID' }) })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /manifest-id: .*Bad_ID.*不匹配/)
  } finally { f.cleanup() }
})

test('协议真源缺失（没有 packages/protocol）：退出 1，命中 protocol-source', () => {
  const f = fixtureRoot({ withProtocol: false })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /protocol-source: packages\/protocol\/src\/plugin\/manifest\.ts: 读不到这个文件/)
    assert.match(r.output, /protocol-source: packages\/protocol\/schemas\/plugin\.json: 取不到 properties\.permissions\.items\.enum/)
  } finally { f.cleanup() }
})

test('源码读 process.env.SOME_MNEMONIC 却未声明 secret：退出 1', () => {
  const f = fixtureRoot({
    files: {
      'packages/plugin-fixture/src/read.mjs': '// SPDX-License-Identifier: CPAL-1.0\nexport const mnemonic = process.env.SOME_MNEMONIC\n',
    },
  })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /secrets-env-match: 源码读了敏感环境变量但清单 secrets 未声明：SOME_MNEMONIC/)
  } finally { f.cleanup() }
})

// ---------------------------------------------------------------------------------------------
// 批 11 主题二 ④⑤：六个通知插件清单的 main 与「通知契约单一事实源」
// ---------------------------------------------------------------------------------------------

const NOTIFY_PKGS = ['plugin-notify-discord', 'plugin-notify-email', 'plugin-notify-slack', 'plugin-notify-telegram', 'plugin-notify-webhook', 'plugin-notify-wecom']

test('真仓库：六个通知插件包都通过 notify-contract（清单与 docs/notifications.md 逐项一致）', () => {
  const r = runScript('plugin-audit.mjs', ['--json'])
  assert.equal(r.status, 0, r.output)
  const report = JSON.parse(r.stdout)
  const withNotify = report.packages.filter((p) => p.tools.includes('notify_send'))
  assert.equal(withNotify.length, 6, `声明 notify_send 的包应有 6 个，实际 ${withNotify.length}`)
  for (const p of withNotify) {
    const check = p.checks.find((c) => c.id === 'notify-contract')
    assert.ok(check, `${p.dir} 没有 notify-contract 检查项（规则没跑到）`)
    assert.equal(check.ok, true, `${p.dir}: ${check.detail}`)
  }
})

test('真仓库：六个通知插件包的 main 与 exports["."] 指向同一个入口文件，且文件真实存在', () => {
  for (const name of NOTIFY_PKGS) {
    const dir = join(REPO, 'packages', name)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(typeof pkg.main, 'string', `${name}: package.json 缺 main`)
    assert.equal(pkg.main, pkg.exports?.['.'], `${name}: main ${pkg.main} 与 exports["."] ${pkg.exports?.['.']} 不一致`)
    assert.ok(existsSync(join(dir, pkg.main)), `${name}: main 指向的 ${pkg.main} 不存在`)
  }
})

test('清单 input.required 少 params：退出 1，命中 notify-contract', () => {
  const tool = notifyTool()
  tool.input = { ...tool.input, required: ['notice'] }
  const f = fixtureRoot({ manifest: fixtureManifest({ tools: [tool] }) })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /notify-contract: .*input\.required 文档 \["notice","params"\] \/ 清单 \["notice"\]/)
  } finally { f.cleanup() }
})

test('清单 notice.required 少 key：退出 1，命中 notify-contract', () => {
  const tool = notifyTool()
  tool.input = {
    ...tool.input,
    properties: {
      ...tool.input.properties,
      notice: { ...tool.input.properties.notice, required: ['title', 'lines'] },
    },
  }
  const f = fixtureRoot({ manifest: fixtureManifest({ tools: [tool] }) })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /notify-contract: .*notice\.required 文档 .*清单 \["title","lines"\]/)
  } finally { f.cleanup() }
})

test('清单 notice 额外放开字段（additionalProperties: true）：退出 1', () => {
  const tool = notifyTool()
  tool.input = {
    ...tool.input,
    properties: {
      ...tool.input.properties,
      notice: { ...tool.input.properties.notice, additionalProperties: true },
    },
  }
  const f = fixtureRoot({ manifest: fixtureManifest({ tools: [tool] }) })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /notify-contract: .*notice\.additionalProperties 必须是 false/)
  } finally { f.cleanup() }
})

test('清单符合文档（对照）：同为夹具时退出 0', () => {
  const f = fixtureRoot({ manifest: fixtureManifest({ tools: [notifyTool()] }) })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 0, r.output)
    assert.match(r.output, /notify-contract: .*与 docs\/notifications\.md 一致/)
  } finally { f.cleanup() }
})

test('文档被删：退出 1，命中 notify-contract-source（真源不在就不许放行）', () => {
  const f = fixtureRoot({ manifest: fixtureManifest({ tools: [notifyTool()] }), withNotifyDoc: false })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /notify-contract-source: docs\/notifications\.md: 读不到通知契约文档/)
  } finally { f.cleanup() }
})

test('文档改了 level 枚举而清单没跟：退出 1（文档受同一套判定约束，不是单向的）', () => {
  const doc = NOTIFY_DOC.replace('"enum": ["info", "warn", "critical"]', '"enum": ["info", "warn"]')
  assert.notEqual(doc, NOTIFY_DOC, '文档里没找到 level 枚举，夹具构造失败')
  const f = fixtureRoot({ manifest: fixtureManifest({ tools: [notifyTool()] }), notifyDoc: doc })
  try {
    const r = runScript('plugin-audit.mjs', ['--root', f.root])
    assert.equal(r.status, 1, r.output)
    assert.match(r.output, /notify-contract: .*level 枚举 文档 \["info","warn"\] \/ 清单 \["info","warn","critical"\]/)
  } finally { f.cleanup() }
})
