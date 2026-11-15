// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { pickDefaultEngine } from '../src/util/default-engine'

const s = (...x: [string, string][]) => x.map(([engineId, state]) => ({ engineId, state }))

describe('GQ-21 默认引擎', () => {
  it('core 在线时无论顺序都选 core', () => {
    expect(pickDefaultEngine(s(['python-engine', 'ready'], ['gitrader-core', 'ready']))).toEqual({ ok: true, engineId: 'gitrader-core' })
    expect(pickDefaultEngine(s(['gitrader-core', 'ready'], ['python-engine', 'ready']))).toEqual({ ok: true, engineId: 'gitrader-core' })
  })

  it('core 不在线、只剩一个就用它', () => {
    expect(pickDefaultEngine(s(['gitrader-core', 'down'], ['python-engine', 'ready']))).toEqual({ ok: true, engineId: 'python-engine' })
  })

  it('core 不在线、多个别的在线 → 报错且列出在线引擎（反例）', () => {
    const r = pickDefaultEngine(s(['a', 'ready'], ['b', 'ready']))
    expect(r.ok).toBe(false)
    expect((r as any).message).toContain('a, b')
  })

  it('没有在线引擎 → 原有提示', () => {
    expect((pickDefaultEngine(s(['gitrader-core', 'down'])) as any).message).toContain('no engine is connected')
  })
})
