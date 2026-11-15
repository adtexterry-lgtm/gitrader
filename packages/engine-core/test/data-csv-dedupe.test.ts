// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { parseCsv } from '../src/runtime/data'

describe('parseCsv ordering and dedupe', () => {
  it('sorts by t and keeps the first candle for a duplicated timestamp', () => {
    expect(parseCsv('t,o,h,l,c,v\n2,1,1,1,1,0\n1,1,1,1,1,0\n2,9,9,9,9,0\n')).toEqual([
      { t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 },
      { t: 2, o: 1, h: 1, l: 1, c: 1, v: 0 },
    ])
  })
})
