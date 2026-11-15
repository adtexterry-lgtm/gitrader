// SPDX-License-Identifier: CPAL-1.0
// R2-REL-10 收尾：随包插件的内容哈希清单 plugins-bundled/BUNDLED-HASHES.json 是发布资产的必备项，漏了要报错。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingBundled, requiredBundledEntries } from '../../../scripts/release/build-release-assets.mjs'

const HASHES = 'plugins-bundled/BUNDLED-HASHES.json'

test('requiredBundledEntries 含 BUNDLED-HASHES.json', () => {
  assert.ok(requiredBundledEntries().includes(HASHES))
})

test('tgz 与便携包里缺 BUNDLED-HASHES.json：点名该文件', () => {
  for (const prefix of ['package/dist/', 'app/cli/']) {
    const entries = requiredBundledEntries().map((e) => `${prefix}${e}`).filter((p) => p !== `${prefix}${HASHES}`)
    assert.deepEqual(missingBundled(entries, prefix), [HASHES])
  }
})
