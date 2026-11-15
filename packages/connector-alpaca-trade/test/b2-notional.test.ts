// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { parseAsset } from '../src/assets'
import { parseCalendar } from '../src/sessions'
import { assetRow, calendarRows, NOW } from './helpers/fake-alpaca'
import { mulDec } from '@gitrader/protocol/decimal'

describe('B2 base-unit notional metadata', () => {
  it('uses the production asset parser and computes stock-share notional', () => {
    const inst = parseAsset(assetRow(), { calendar: parseCalendar(calendarRows(), 'America/New_York', NOW), now: NOW }).instrument
    expect(inst).toMatchObject({ venueSizeUnit: 'base', contractSize: '1' })
    expect(mulDec(mulDec('2.5', '123.45'), inst.contractSize)).toBe('308.625')
  })
})
