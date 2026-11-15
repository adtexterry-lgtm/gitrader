// SPDX-License-Identifier: CPAL-1.0
// render.ts 的单元测试：模板版式、HTML 转义、无品牌词、无表情。全部离线。
import { describe, expect, it } from 'vitest'
import { escapeHtml } from '../src/mime'
import { renderMail } from '../src/render'

const BRAND = /gitrader|hermes|nous research/i
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

describe('renderMail', () => {
  it('版式：level 标记 + 标题 / 每条一行 / 末行 ISO 时间（text 版）', () => {
    const out = renderMail({ title: '资金费率告警', lines: ['BTC 费率 0.3%', '阈值 0.1%'], ts: 0, level: 'warn' })
    expect(out.text).toBe('[WARN] 资金费率告警\nBTC 费率 0.3%\n阈值 0.1%\n1970-01-01T00:00:00.000Z')
  })

  it('subject 含标题与等级标签', () => {
    const out = renderMail({ title: '资金费率告警', lines: [], level: 'warn' })
    expect(out.subject).toContain('资金费率告警')
    expect(out.subject).toContain('[WARN]')
  })

  it('缺省 level 是 info，无 ts 时不留空行', () => {
    const out = renderMail({ title: 't', lines: ['a'] })
    expect(out.text).toBe('[INFO] t\na')
    expect(out.text.endsWith('\n')).toBe(false)
  })

  it('critical 用 [CRIT] 标记', () => {
    expect(renderMail({ title: 't', lines: [], level: 'critical' }).text.startsWith('[CRIT] ')).toBe(true)
  })

  it('html 版把动态文本全部转义', () => {
    const out = renderMail({ title: '<b>告警</b>', lines: ['<script>x</script>'], ts: 0 })
    expect(out.html).toContain('&lt;b&gt;告警&lt;/b&gt;')
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(out.html).not.toContain('<script>')
    expect(out.html).toContain('<h2>')
    expect(out.html).toContain('<code>1970-01-01T00:00:00.000Z</code>')
  })

  it('两版都没有品牌词、没有表情符号', () => {
    const out = renderMail({ title: '通知', lines: ['内容'], ts: 1_700_000_000_000, level: 'info' })
    for (const text of [out.text, out.html]) {
      expect(BRAND.test(text)).toBe(false)
      expect(EMOJI.test(text)).toBe(false)
    }
  })

  it('text 与 html 用同一份内容（标题都在第一行 / 第一个块）', () => {
    const out = renderMail({ title: '同一个标题', lines: ['同一行内容'] })
    expect(out.text.split('\n')[0]).toBe('[INFO] 同一个标题')
    expect(out.html).toContain('<h2>[INFO] 同一个标题</h2>')
    expect(out.text).toContain('同一行内容')
    expect(out.html).toContain('<p>同一行内容</p>')
  })
})

describe('escapeHtml', () => {
  it('escapeHtml(\'<b>&\') 正确', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;')
  })
})
