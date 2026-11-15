// SPDX-License-Identifier: CPAL-1.0
// 插件里的 format.mjs 是库 src/format.ts 的副本：逐条比对两边输出，防止只改一边。
import { describe, expect, it } from 'vitest'
import { MAX_TEXT as LIB_MAX_TEXT, escapeSlackText as libEscape, renderNotice as libRender } from '../../notify-slack/src/format'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { MAX_TEXT as PLUGIN_MAX_TEXT, escapeSlackText as pluginEscape, renderNotice as pluginRender } from '../format.mjs'

const FIXTURES = [
  { title: 'Risk denial', lines: ['account acct_x', 'notional 1200 > 1000'], level: 'warn' as const, ts: 1760000000000 },
  { title: 'a & b <c>', lines: ['<!channel>', '<@U123> x&y'], level: 'critical' as const },
  { title: '', lines: [], level: 'info' as const, ts: 0 },
  { title: '接管 applied', lines: ['takeoverId to_1', 'scope risk'], level: 'info' as const },
]

describe('format.mjs 与库 src/format.ts 输出一致', () => {
  it('上限常量一致（40000）', () => {
    expect(PLUGIN_MAX_TEXT).toBe(LIB_MAX_TEXT)
    expect(LIB_MAX_TEXT).toBe(40000)
  })

  it('escapeSlackText 对同一批输入逐字节相同', () => {
    for (const input of ['', 'plain', 'a & b', '<!channel>', 'x>y<z&']) {
      expect(pluginEscape(input)).toBe(libEscape(input))
    }
  })

  it('renderNotice 对四个夹具逐字节相同', () => {
    for (const fixture of FIXTURES) expect(pluginRender(fixture)).toBe(libRender(fixture))
  })
})
