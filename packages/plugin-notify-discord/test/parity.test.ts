// SPDX-License-Identifier: CPAL-1.0
// L5-12 parity：插件 format.mjs 是库 src/format.ts 的手抄副本，逐条比对两边输出（与 slack 包同一做法）。
import { describe, expect, it } from 'vitest'
import {
  MAX_CONTENT as LIB_MAX,
  chunkContent as libChunk,
  escapeDiscordMarkdown as libEscape,
  renderNotice as libRender,
} from '../../notify-discord/src/format'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { MAX_CONTENT as PLUGIN_MAX, chunkContent as pluginChunk, escapeDiscordMarkdown as pluginEscape, renderNotice as pluginRender } from '../format.mjs'

const TEXTS = ['', 'plain', 'a*b*c_d_e', '`code`', '**bold** ~~strike~~', '中文通知 1200 > 1000', 'line1\nline2']

describe('format.mjs 与库 src/format.ts 输出一致', () => {
  it('上限常量一致（2000）', () => {
    expect(PLUGIN_MAX).toBe(LIB_MAX)
  })

  it('escapeDiscordMarkdown 对同一批输入逐字节相同', () => {
    for (const text of TEXTS) expect(pluginEscape(text), text).toBe(libEscape(text))
  })

  it('chunkContent 切分结果相同', () => {
    for (const text of TEXTS) expect(pluginChunk(text, 10), text).toEqual(libChunk(text, 10))
    const long = 'x'.repeat(2500)
    expect(pluginChunk(long)).toEqual(libChunk(long))
  })

  it('renderNotice 对三个夹具逐字节相同', () => {
    const fixtures = [
      { title: 'Risk denial', lines: ['account acct_x', 'notional 1200 > 1000'], level: 'warn' as const, ts: 1760000000000 },
      { title: 'a_b*c', lines: ['`code`', '~~x~~'], level: 'critical' as const },
      { title: '', lines: [], level: 'info' as const },
    ]
    for (const fixture of fixtures) expect(pluginRender(fixture)).toBe(libRender(fixture))
  })
})
