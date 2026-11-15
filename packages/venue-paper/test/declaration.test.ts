// SPDX-License-Identifier: CPAL-1.0
// 对外声明 = 契约 §1.5.3 的 JSON；ASSUMPTIONS.md 必须逐项提到它们，改一边不改另一边就失败。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { simDeclaration } from '../src/declaration'

const CONTRACT = {
  connector: 'kernel-sim',
  modes: ['paper', 'shadow'],
  mirrors: ['hyperliquid'],
  fillModel: {
    market: 'walk-l2-book', bookShortfall: 'last-level-plus-0.1pct', noBook: 'mid-plus-5bps', limit: 'touch-fill-at-limit', queuePosition: false,
    latencyMs: 0, funding: 'hourly-accrual', liquidation: 'approx-at-mark', positionMode: 'oneWay', marginMode: 'cross-only',
  },
  knownGaps: ['no-queue-position', 'no-latency-model', 'isolated-only-markets-simulated-as-cross'],
}

describe('kernel-sim declaration', () => {
  it('equals the contract example byte for byte', () => {
    expect(simDeclaration()).toEqual(CONTRACT)
  })

  it('ASSUMPTIONS.md documents every declared value and every known gap', () => {
    const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ASSUMPTIONS.md'), 'utf8')
    for (const [k, v] of Object.entries(CONTRACT.fillModel)) {
      expect(md, `fillModel.${k}`).toContain(k)
      expect(md, `fillModel.${k} = ${v}`).toContain(String(v))
    }
    for (const gap of CONTRACT.knownGaps) expect(md, gap).toContain(gap)
  })
})
