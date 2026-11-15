// SPDX-License-Identifier: CPAL-1.0
// GQ-10 随包资源清单校验测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { missingBundled, requiredBundledEntries, BUNDLED_PLUGINS } from '../../../scripts/release/build-release-assets.mjs'

const REPO = join(import.meta.dirname, '..', '..', '..')

test('齐全的清单：缺 0 项', () => {
  const entries = requiredBundledEntries().map((e) => `package/dist/${e}`)
  assert.deepEqual(missingBundled(entries, 'package/dist/'), [])
})

test('缺一个插件的 gsp.mjs：点名该文件', () => {
  const entries = requiredBundledEntries()
    .map((e) => `app/cli/${e}`)
    .filter((p) => p !== 'app/cli/plugins-bundled/notify-slack/gsp.mjs')
  assert.deepEqual(missingBundled(entries, 'app/cli/'), ['plugins-bundled/notify-slack/gsp.mjs'])
})

test('缺示例文件：点名该文件', () => {
  const entries = requiredBundledEntries()
    .map((e) => `package/dist/${e}`)
    .filter((p) => p !== 'package/dist/examples/strategies/grid.ts')
  assert.deepEqual(missingBundled(entries, 'package/dist/'), ['examples/strategies/grid.ts'])
})

test('前缀不对 = 全缺（防止 tgz 与便携包的前缀写反）', () => {
  const entries = requiredBundledEntries().map((e) => `app/cli/${e}`)
  const missing = missingBundled(entries, 'package/dist/')
  assert.equal(missing.length, requiredBundledEntries().length)
})

test('六个插件名与仓库里 packages/plugin-notify-* 一一对应', () => {
  const dirs = readdirSync(join(REPO, 'packages'))
    .filter((n) => n.startsWith('plugin-notify-'))
    .map((n) => n.slice('plugin-'.length))
    .sort()
  assert.deepEqual([...BUNDLED_PLUGINS].sort(), dirs)
})

test('requiredBundledEntries 包含所有插件的关键文件', () => {
  const entries = requiredBundledEntries()
  for (const plugin of BUNDLED_PLUGINS) {
    assert.ok(entries.some((e) => e.includes(`plugins-bundled/${plugin}/gitrader-plugin.json`)), `missing ${plugin} manifest`)
    assert.ok(entries.some((e) => e.includes(`plugins-bundled/${plugin}/gsp.mjs`)), `missing ${plugin} gsp.mjs`)
    assert.ok(entries.some((e) => e.includes(`plugins-bundled/${plugin}/index.mjs`)), `missing ${plugin} index.mjs`)
  }
})

test('requiredBundledEntries 包含示例策略关键文件', () => {
  const entries = requiredBundledEntries()
  assert.ok(entries.includes('examples/strategies/grid.ts'))
  assert.ok(entries.includes('examples/strategies/dca.ts'))
  assert.ok(entries.includes('examples/strategy-template.ts'))
  assert.ok(entries.includes('examples/README.txt'))
})
