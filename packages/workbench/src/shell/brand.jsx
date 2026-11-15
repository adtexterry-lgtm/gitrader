// SPDX-License-Identifier: CPAL-1.0
// 品牌位：维护者 2026-10-11 定稿的 V21 字标原件（仓库 assets/brand/gitrader-wordmark.svg），原字节以 data URI 放进 <img>：
// 不重画、不改几何 / 字距 / 颜色，SVG 的 id 也不会和页面冲突。原件自带 #0A0A0B 深色底（不是透明稿）——
// 放它的容器底色必须同色（theme.css 的 --gr-wordmark-bg），否则会露出矩形色块。build.mjs 构建时校验原件 sha256。
import wordmarkSvg from '../../../../assets/brand/gitrader-wordmark.svg'
import glyphSvg from '../ui/brand/g-glyph-32.svg'

export const BRAND_NAME = 'Gitrader'
export const WORDMARK_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(wordmarkSvg)
export const GLYPH_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(glyphSvg)

/** 字标原件。height = 图片高（原件四周自带留白，字形约占 5/6）。 */
export function Wordmark({ height = 18, className = '', alt = BRAND_NAME }) {
  return <img className={'gr-wm' + (className ? ' ' + className : '')} src={WORDMARK_URL} alt={alt} style={{ height: height + 'px' }} draggable={false} />
}

/** G 字形原件（favicon 同源，用于侧栏模式标志）。 */
export function GlyphMark({ size = 28 }) {
  return <img src={GLYPH_URL} width={size} height={size} alt="" draggable={false} />
}

/** 顶栏字标：点一下回工作台。图高 16：字形约 13.3px，与 13px 导航字齐平（unslop 字标 16–18 取下限，release-r1 P1-6）。 */
export function Brand({ onClick }) {
  return (
    <button type="button" className="gr-brand" aria-label={BRAND_NAME} onClick={onClick}>
      <Wordmark height={16} alt="" />
    </button>
  )
}
