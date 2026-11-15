// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { kernelRestartItem, mergeActivity, type ActivityItem } from '../src/model-activity'

const item = (seq: number): ActivityItem => ({ id: `led_${seq}`, seq, ts: 1000 + seq, origin: {} as never, type: 'order.intent' as never, rules: [], what: `row ${seq}` })

describe('P2-6 local kernel-restart activity row', () => {
  it('maps to the existing kernel.started wording, in memory only', () => {
    const row = kernelRestartItem(5000, [item(3), item(7)])
    expect(row.what).toBe('内核已重启')
    expect(row.result).toEqual({ label: '已启动', tone: 'flat' })
    expect(row.ts).toBe(5000)
    expect(row.id).toBe('local-kernel-restart-5000')
  })
  it('sits above existing rows but below later real entries; the same restart is not added twice', () => {
    const base = [item(7), item(3)]
    const merged = mergeActivity(base, kernelRestartItem(5000, base))
    expect(merged.map((x) => x.seq)).toEqual([7.5, 7, 3])
    expect(mergeActivity(merged, kernelRestartItem(5000, merged))).toBe(merged)
    expect(mergeActivity(merged, item(8)).map((x) => x.seq)).toEqual([8, 7.5, 7, 3])
  })
})
