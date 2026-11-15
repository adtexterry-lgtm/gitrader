// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import * as kit from '../src/views/ovkit'

const anchor = { top: 820, bottom: 848, left: 1200, right: 1400, width: 200, height: 28 }
describe('placePop', () => {
  it('flips above when no room below', () => {
    expect(kit.placePop(anchor, { width: 240, height: 200 }, { width: 1440, height: 900 })).toEqual({ top: 612, left: 1160, flipped: true })
  })
  it('clamps to viewport horizontally', () => {
    expect(kit.placePop({ ...anchor, left: -40, right: 100 }, { width: 240, height: 200 }, { width: 1440, height: 900 }).left).toBe(8)
    expect(kit.placePop({ ...anchor, right: 1600 }, { width: 240, height: 200 }, { width: 1440, height: 900 }).left).toBe(1192)
  })
  it('uses maxHeight when neither side fits', () => {
    expect(kit.placePop({ ...anchor, top: 400, bottom: 428 }, { width: 240, height: 700 }, { width: 1440, height: 900 })).toEqual({ top: 436, left: 1160, maxHeight: 456, flipped: false })
    expect(kit.placePop({ ...anchor, top: 500, bottom: 528 }, { width: 240, height: 700 }, { width: 1440, height: 900 })).toEqual({ top: 8, left: 1160, maxHeight: 484, flipped: true })
  })
  it('keeps below when there is room', () => {
    expect(kit.placePop({ ...anchor, top: 100, bottom: 128 }, { width: 240, height: 200 }, { width: 1440, height: 900 })).toEqual({ top: 136, left: 1160, flipped: false })
  })
})
