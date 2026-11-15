// SPDX-License-Identifier: CPAL-1.0
// strategy.list 的 sha256：与 engine.describe 同一来源（加载器记录的原始文件字节摘要）；未经加载器的定义不伪造字段。
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256Digest } from '../src/util/hash'
import { EXAMPLE_STRATEGIES, rig, type Rig } from './harness'

let r: Rig | null = null
afterEach(() => { r?.close(); r = null })

describe('strategy.list：sha256', () => {
  it('每个清单项带摘要；与 engine.describe 相同；等于策略文件原始字节的 sha256', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitrader-strategy-list-sha-'))
    const file = join(EXAMPLE_STRATEGIES, 'ema-cross.ts')
    copyFileSync(file, join(dir, basename(file)))
    r = await rig({ strategiesDir: dir })

    const list = await r.session.call('strategy.list', {})
    const items = list.strategies as { id: string; sha256?: string }[]
    expect(items.length).toBeGreaterThan(0)
    for (const s of items) expect(s.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)

    const d = await r.session.call('engine.describe', {})
    const described = d.strategies as { id: string; sha256?: string }[]
    for (const s of items) {
      const same = described.find((x) => x.id === s.id)
      expect(same, s.id).toBeDefined()
      expect(same!.sha256, s.id).toBe(s.sha256)
    }

    const raw = sha256Digest(readFileSync(join(dir, basename(file))))
    const loaded = items.find((s) => s.id === 'ema-cross')
    expect(loaded).toBeDefined()
    expect(loaded!.sha256).toBe(raw)
  })
})
