// SPDX-License-Identifier: CPAL-1.0
// format.ts 的单元测试：mrkdwn 转义、固定模板、尺寸上限。全部离线。
import { describe, expect, it } from 'vitest'
import { MAX_TEXT, escapeSlackText, renderNotice, renderNoticeText } from '../src/format'

describe('escapeSlackText', () => {
  it('& → &amp;', () => {
    expect(escapeSlackText('a & b')).toBe('a &amp; b')
  })

  it('< 与 > 分别转成 &lt; / &gt;', () => {
    expect(escapeSlackText('<x>')).toBe('&lt;x&gt;')
  })

  it('先转 & 再转 < >，不会把 &lt; 二次转义', () => {
    expect(escapeSlackText('a & <b>')).toBe('a &amp; &lt;b&gt;')
  })

  it('普通文本与中文原样返回', () => {
    expect(escapeSlackText('资金费率 0.3%')).toBe('资金费率 0.3%')
  })

  it('<!channel> 与 <@U123> 被转义，不构成 @ 提及', () => {
    expect(escapeSlackText('<!channel>')).toBe('&lt;!channel&gt;')
    expect(escapeSlackText('<@U123>')).toBe('&lt;@U123&gt;')
  })

  it('<https://example.com|点我> 被转义，不构成链接', () => {
    const escaped = escapeSlackText('<https://example.com|点我>')
    expect(escaped).not.toContain('<')
    expect(escaped).toBe('&lt;https://example.com|点我&gt;')
  })

  it('空字符串 → 空字符串', () => {
    expect(escapeSlackText('')).toBe('')
  })
})

describe('renderNotice', () => {
  it('固定模板：[LEVEL] *title* 后逐行原文', () => {
    const out = renderNotice({ title: 'Risk denial', lines: ['account acct_x', 'notional 1200 > 1000'], level: 'warn' })
    const lines = out.split('\n')
    expect(lines[0]).toBe('[WARN] *Risk denial*')
    expect(lines[1]).toBe('account acct_x')
    expect(lines[2]).toBe('notional 1200 &gt; 1000')
    expect(lines).toHaveLength(3)
  })

  it('三个 level 各有标记，未知 level 退回 info', () => {
    expect(renderNotice({ title: 't', lines: [] }).split('\n')[0]).toBe('[INFO] *t*')
    expect(renderNotice({ title: 't', lines: [], level: 'critical' }).split('\n')[0]).toBe('[CRIT] *t*')
    // @ts-expect-error 运行期兜底：契约外的 level 按 info 处理
    expect(renderNotice({ title: 't', lines: [], level: 'loud' }).split('\n')[0]).toBe('[INFO] *t*')
  })

  it('有 ts 时末行是 ISO 时间，无 ts 时没有时间行', () => {
    expect(renderNotice({ title: 't', lines: [], ts: 0 }).split('\n').at(-1)).toBe('1970-01-01T00:00:00.000Z')
    expect(renderNotice({ title: 't', lines: [] }).split('\n')).toHaveLength(1)
  })

  it('标题里的动态文本也转义，不改写、不加品牌文案', () => {
    const out = renderNotice({ title: 'a<b', lines: ['c&d'] })
    expect(out).toContain('*a&lt;b*')
    expect(out).toContain('c&amp;d')
    expect(out).not.toMatch(/QuantDinger|Gitrader|QD Signal/i)
  })

  it('多行保持顺序与条数（不改写正文）', () => {
    const out = renderNotice({ title: 't', lines: ['l1', 'l2', 'l3'] })
    expect(out.split('\n').slice(1)).toEqual(['l1', 'l2', 'l3'])
  })
})

describe('renderNoticeText', () => {
  it('正常长度原样返回 renderNotice 的结果', () => {
    const fields = { title: 't', lines: ['a'] }
    expect(renderNoticeText(fields)).toBe(renderNotice(fields))
  })

  it('超过 40000 字符抛 RangeError（不截断、留给调用方报错）', () => {
    expect(() => renderNoticeText({ title: 't', lines: ['x'.repeat(MAX_TEXT)] })).toThrow(RangeError)
    expect(MAX_TEXT).toBe(40000)
  })

  it('正好 40000 字符可以通过（边界不误杀）', () => {
    const head = renderNotice({ title: 't', lines: [] }) // '[INFO] *t*'
    const pad = MAX_TEXT - head.length - 1
    expect(renderNoticeText({ title: 't', lines: ['y'.repeat(pad)] })).toHaveLength(MAX_TEXT)
  })
})
