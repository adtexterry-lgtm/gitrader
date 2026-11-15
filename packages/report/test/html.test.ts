// SPDX-License-Identifier: CPAL-1.0
// HTML 报告：内联 SVG / 无脚本 / 无外链字体 / 零承诺语言 / 体积上限 / 空结果。
import { describe, expect, it } from 'vitest'
import { findPromiseLanguage } from '../../protocol/src/plugin/manifest'
import { CHART_SAMPLE_LIMIT, renderHtml } from '../src/html'
import { MAX_TRADE_ROWS } from '../src/markdown'
import { DISCLAIMER } from '../src/types'
import { buildBigFixture, buildEmptyFixture, buildFixture } from './fixture'

const fixture = buildFixture()
const html = renderHtml({ result: fixture, generatedAt: Date.UTC(2024, 5, 1, 12, 0) })
const big = renderHtml({ result: buildBigFixture() })

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('HTML 结构与自包含', () => {
  it('有 <svg（权益 + 回撤 + 月度热力）且没有任何 <script', () => {
    expect(count(html, '<svg')).toBeGreaterThanOrEqual(3)
    expect(html.includes('<script')).toBe(false)
    expect(html.includes('script src')).toBe(false)
  })

  it('单文件：内联 <style>、无外链资源、无 @import 与外链字体', () => {
    expect(html).toContain('<style>')
    // SVG 的 xmlns 是唯一许可的 http 串；除此之外不得有外链。
    expect(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')).not.toContain('http')
    expect(html.includes('@import')).toBe(false)
    expect(html.includes('<link')).toBe(false)
    expect(html.includes('src="')).toBe(false)
  })

  it('含免责声明、指标值与 sha256 数据摘要', () => {
    expect(html).toContain(DISCLAIMER)
    expect(html).toContain('1.50')
    expect(html).toContain('50.00')
    expect(count(html, DISCLAIMER)).toBe(2)
    expect(/[0-9a-f]{64}/.test(html)).toBe(true)
  })

  it('零承诺语言：整份 HTML（含 SVG 文本与标题）过 findPromiseLanguage', () => {
    expect(findPromiseLanguage(html)).toBeNull()
    expect(findPromiseLanguage(big)).toBeNull()
  })

  it('交易表最多 200 行，超出时写明总数', () => {
    const rows = count(big, '<tr>') - 1 // 减去表头行
    expect(count(big, 'signal-')).toBe(MAX_TRADE_ROWS)
    expect(rows).toBeGreaterThan(0)
    expect(big).toContain('共 500 笔成交')
  })

  it('6000 个权益点、500 笔成交的大结果仍小于 300 KB，且曲线被降采样', () => {
    const bytes = Buffer.byteLength(big, 'utf8')
    expect(bytes).toBeLessThan(300 * 1024)
    const polyline = /<polyline points="([^"]+)"/.exec(big)
    expect(polyline).not.toBeNull()
    const points = polyline![1]!.split(' ').length
    expect(points).toBeLessThanOrEqual(CHART_SAMPLE_LIMIT)
  })

  it('空成交结果输出「无成交」且三张图退化为无数据占位', () => {
    const empty = renderHtml({ result: buildEmptyFixture() })
    expect(empty).toContain('无成交')
    expect(count(empty, '<svg')).toBeGreaterThanOrEqual(1)
    expect(findPromiseLanguage(empty)).toBeNull()
  })

  it('HTML 转义：标题里的尖括号不会变成标签', () => {
    const escaped = renderHtml({ result: fixture, title: '<b>x</b> & y' })
    expect(escaped).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(escaped.includes('<b>x</b>')).toBe(false)
  })
})
