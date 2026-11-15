// SPDX-License-Identifier: CPAL-1.0
// Gitrader 视觉精修 v3 · 页面体检探针（在页面上下文执行；DevTools 粘贴或 run-audit.mjs 注入）。只读，不改页面。
// 返回当前视口内的计数，对应规范 §10 的机器验收项。阈值见 window.__grAudit.LIMITS。
(() => {
  // r2 只加严：capsule = 全圆胶囊的可点件（宽 > 2× 高且圆角 ≥ 高 / 2；开关轨 role=switch 除外）；text3Low = text-3 文字对实际背景 < 4.5:1（IXD 12.4）
  const LIMITS = { cjk11: 0, orange: 6, solidOrange: 1, glow: 1, orb: 1, primary: 1, sizeViolations: 0, cjk500: 0, cjkBoldSmall: 0, cjkNegTrack: 0, blackOnOrange: 0, coloredZero: 0, truncated: 0, pageSub: 0, gradientCjk: 0, nestDepth3: 0, capsule: 0, text3Low: 0, tintChip: 2, boxedTag: 3, fillDepth: 2, cardRadius: 0, rowClip: 0 }
  // r5 路由沿用批准的工作台字号表；r4 仍只在工作台根路由使用该表。
  const onWorkbench = /^#?\/?$/.test(location.hash)
  const onR5 = document.documentElement.getAttribute('data-ui') === 'r5' || new URL(location.href).searchParams.get('ui') === 'r5'
  const SIZES = new Set(onR5 || onWorkbench ? [11, 12, 13, 14, 16, 20, 36] : [11, 12, 13, 14, 16, 20, 22, 28, 44])
  const CJK = /[㐀-鿿＀-￯]/
  const vw = innerWidth, vh = innerHeight
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05 }
  const parse = (c) => { const m = c && c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
  const hsl = ({ r, g, b }) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; if (mx === mn) return { h: 0, s: 0, l }; const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: h * 60, s, l } }
  const isOrange = (c, minA = 0.35) => { const p = parse(c); if (!p || p.a < minA) return false; const { h, s, l } = hsl(p); return h >= 12 && h <= 38 && s > 0.6 && l > 0.38 && l < 0.8 }
  const lum = (p) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b) }
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
  const all = Array.from(document.querySelectorAll('body *')).filter((el) => !['SCRIPT', 'STYLE', 'DEFS', 'FILTER', 'TITLE'].includes(el.tagName.toUpperCase()) && visible(el))
  const out = { url: location.href, orange: 0, solidOrange: 0, glow: 0, orb: 0, primary: 0, sizeViolations: 0, sizes: {}, cjk500: 0, cjkBoldSmall: 0, cjkNegTrack: 0, cjk11: 0, blackOnOrange: 0, coloredZero: 0, truncated: 0, pageSub: 0, gradientCjk: 0, nestDepth3: 0, samples: {} }
  const sample = (k, el) => { (out.samples[k] = out.samples[k] || []).length < 4 && out.samples[k].push((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || el.tagName) + ' · ' + (el.textContent || '').trim().slice(0, 24)) }
  const orangeEls = new Set()
  for (const el of all) {
    const cs = getComputedStyle(el)
    const text = ownText(el)
    const bgOrange = isOrange(cs.backgroundColor, 0.6) || /gradient/.test(cs.backgroundImage) && /rgb\(2(3\d|4\d|5[0-5]), (9\d|1[0-4]\d), (\d|[1-4]\d)\)/.test(cs.backgroundImage) && !/radial-gradient\(circle at 32%/.test(cs.backgroundImage) && el.getBoundingClientRect().height < 60
    const textOrange = text && isOrange(cs.color)
    const borderOrange = ['Top', 'Right', 'Bottom', 'Left'].some((s) => parseFloat(cs['border' + s + 'Width']) > 0 && isOrange(cs['border' + s + 'Color']))
    const svgOrange = el instanceof SVGElement && (isOrange(cs.stroke) || isOrange(cs.fill))
    const bb = el.getBoundingClientRect()
    if ((bgOrange || textOrange || borderOrange || svgOrange) && bb.width > 9 && bb.height > 9 && !el.closest('.actor, .gr-actor')) { if (![...orangeEls].some((p) => p.contains(el))) orangeEls.add(el) }   // ≤ 9 px 的标识点（执行方小标、曲线末点、光轨）不计入橙色预算
    const rr = el.getBoundingClientRect()
    if (bgOrange && rr.width >= 14 && rr.height >= 14) { out.solidOrange += 1; sample('solidOrange', el); const fg = parse(cs.color); if (text && fg && lum(fg) < 0.2) { out.blackOnOrange += 1; sample('blackOnOrange', el) } const svg = el.querySelector('svg'); if (svg) { const sc = parse(getComputedStyle(svg).stroke) || parse(getComputedStyle(svg).color); if (sc && lum(sc) < 0.2) { out.blackOnOrange += 1; sample('blackOnOrange', el) } } }
    const sh = cs.boxShadow + ' ' + cs.textShadow + ' ' + cs.filter
    const glows = (sh.match(/rgba?\([^)]+\)\s+-?[\d.]+px\s+-?[\d.]+px\s+([\d.]+)px/g) || []).concat(sh.match(/-?[\d.]+px\s+-?[\d.]+px\s+([\d.]+)px[^,]*?rgba?\([^)]+\)/g) || [])
    if (glows.some((g) => { const blur = parseFloat((g.match(/px\s+([\d.]+)px/) || [])[1] || 0); const c = (g.match(/rgba?\([^)]+\)/) || [])[0]; return blur >= 8 && isOrange(c, 0.15) })) { out.glow += 1; sample('glow', el) }
    if (el.classList && (el.classList.contains('icon-orb') || el.classList.contains('orb'))) {
      out.orb += 1
      const g = el.querySelector('svg'); const gc = g && (parse(getComputedStyle(g).stroke) || parse(getComputedStyle(g).color))
      if (gc && lum(gc) < 0.2) { out.blackOnOrange += 1; sample('blackOnOrange', el) }   // 橙球上的黑字形（维护者 禁止）
    }
    if (el.classList && (el.classList.contains('gr-btn--primary') || el.classList.contains('btn--primary'))) out.primary += 1
    if (text && text.length > 0 && !(el instanceof SVGElement)) {
      const fs = Math.round(parseFloat(cs.fontSize)); out.sizes[fs] = (out.sizes[fs] || 0) + 1
      if (!SIZES.has(fs)) { out.sizeViolations += 1; sample('size', el) }
      const fw = Number(cs.fontWeight)
      if (CJK.test(text)) {
        if (fs < 12) { out.cjk11 += 1; sample('cjk11', el) }   // 中文最小 12 px
        if (fw === 500 && /[A-Za-z0-9]/.test(text)) { out.cjk500 += 1; sample('cjk500', el) }
        const solidBtn = el.closest('.gr-btn--primary, .btn--primary, .btn--kill, .gr-btn--danger.is-armed, [data-solid]')
        if (fw >= 600 && fs < 16 && !solidBtn) { out.cjkBoldSmall += 1; sample('cjkBoldSmall', el) }
        if (parseFloat(cs.letterSpacing) < 0) { out.cjkNegTrack += 1; sample('cjkNegTrack', el) }
        if (/text/.test(cs.backgroundClip || cs.webkitBackgroundClip || '')) { out.gradientCjk += 1; sample('gradientCjk', el) }
      }
      if (/^[+\-−]?0(\.0+)?%?$/.test(text.replace(/[,\s]/g, ''))) { const c = parse(cs.color); if (c) { const { h, s } = hsl(c); if (s > 0.45 && (h < 15 || (h > 120 && h < 170))) { out.coloredZero += 1; sample('coloredZero', el) } } }
    }
    if ((el.tagName === 'BUTTON' || el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'tab') && el.scrollWidth > el.clientWidth + 2) { out.truncated += 1; sample('truncated', el) }
  }
  out.orange = orangeEls.size
  out.pageSub = document.querySelectorAll('.gr-page__sub').length
  // 全圆胶囊：可点件里宽 > 2× 高、圆角 ≥ 高 / 2 的（只有开关轨可以是全圆）
  const CLICK = 'button, a[href], [role="button"], [role="tab"], [role="radio"], [role="menuitem"], [role="menuitemradio"], [role="option"], summary, select'
  out.capsule = 0
  for (const el of all) {
    if (!onR5 && (!el.matches(CLICK) || el.matches('[role="switch"]'))) continue
    const r = el.getBoundingClientRect(); const raw = getComputedStyle(el).borderTopLeftRadius
    if (onR5 && (r.width <= 4 || r.height <= 4)) continue
    const rad = /%$/.test(raw) ? (parseFloat(raw) / 100) * r.height : parseFloat(raw)
    if (r.width > 2 * r.height && rad >= r.height / 2 - 0.5) { out.capsule += 1; sample('capsule', el) }
  }
  // text-3 对比度：按令牌值认出 text-3 文字，背景沿祖先链合成（实底 + 渐变里最亮的白色层，偏保守），对比 < 4.5:1 计数
  const hex = (v) => { const m = /^#([0-9a-f]{6})$/i.exec((v || '').trim()); return m ? { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) } : null }
  const t3 = hex(getComputedStyle(document.documentElement).getPropertyValue('--gr-text-3'))
  const canvas = hex(getComputedStyle(document.documentElement).getPropertyValue('--gr-ink-0')) || { r: 10, g: 10, b: 11 }
  const whiteMax = (img) => { let a = 0; for (const m of img.matchAll(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/g)) if (+m[1] > 240 && +m[2] > 240 && +m[3] > 240) a = Math.max(a, +m[4]); return a }
  const bgOf = (el) => {
    const layers = []
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n)
      const w = /gradient/.test(cs.backgroundImage) ? whiteMax(cs.backgroundImage) : 0
      if (w) layers.push({ r: 255, g: 255, b: 255, a: w })
      const c = parse(cs.backgroundColor)
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break }
    }
    let acc = canvas
    for (let i = layers.length - 1; i >= 0; i -= 1) { const l = layers[i]; acc = { r: l.r * l.a + acc.r * (1 - l.a), g: l.g * l.a + acc.g * (1 - l.a), b: l.b * l.a + acc.b * (1 - l.a) } }
    return acc
  }
  out.text3 = 0; out.text3Low = 0; out.text3Min = null
  if (t3) for (const el of all) {
    if (el instanceof SVGElement || !ownText(el)) continue
    const c = parse(getComputedStyle(el).color)
    if (!c || c.a < 1 || c.r !== t3.r || c.g !== t3.g || c.b !== t3.b) continue
    const a = lum(c), b = lum(bgOf(el))
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    out.text3 += 1
    out.text3Min = out.text3Min === null ? ratio : Math.min(out.text3Min, ratio)
    if (ratio < 4.5) { out.text3Low += 1; sample('text3Low', el) }
  }
  if (out.text3Min !== null) out.text3Min = Math.round(out.text3Min * 100) / 100
  // r4 只加严（施工单 7.2-2）：tintChip / boxedTag / fillDepth / cardRadius / rowClip
  const CLICKISH = CLICK + ', input, textarea, [role="switch"]'
  const chars = (el) => Array.from((el.textContent || '').trim()).length
  const own = new Set()
  const counted = (el) => [...own].some((p) => p.contains(el))
  out.tintChip = 0; out.boxedTag = 0
  for (const el of all) {
    if (el instanceof SVGElement || el.closest('[data-audit-exempt]')) continue
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const n = chars(el)
    if (!n || r.height > 32) continue
    const bg = parse(cs.backgroundColor)
    // 语义色小件：8–16% 的饱和色底 + 文字（色相不限，橙 / 涨 / 跌 / 警都算）
    if (bg && bg.a >= 0.075 && bg.a <= 0.165 && hsl(bg).s > 0.35 && r.width <= 200) { out.tintChip += 1; sample('tintChip', el) }
    // 框住的短标签：≤ 4 字、不可点，被描边 / 内环 / 底色包住
    if (n > 4 || r.width > 96 || el.matches(CLICKISH) || el.closest(CLICKISH) || counted(el)) continue
    // 四边都描或一整圈内环（单边线 / 单边内阴影是表头与行分隔，不算框）
    const ring = ['Top', 'Right', 'Bottom', 'Left'].every((k) => parseFloat(cs['border' + k + 'Width']) > 0 && (parse(cs['border' + k + 'Color'])?.a ?? 0) > 0.05) || /(?:^|\s)0px 0px [\d.]+px (?!0px)[\d.]+px inset/.test(cs.boxShadow)
    // 底色只在和所在面不同时才算「包住」（表头吸顶用的卡底色不算）
    let under = null
    for (let p = el.parentElement; p && !under; p = p.parentElement) { const c = parse(getComputedStyle(p).backgroundColor); if (c && c.a > 0) under = c }
    const fill = bg && bg.a > 0.02 && !(under && under.r === bg.r && under.g === bg.g && under.b === bg.b && Math.abs(under.a - bg.a) < 0.01)
    if (ring || fill) { own.add(el); out.boxedTag += 1; sample('boxedTag', el) }
  }
  // 底套底：可见底色（> 2% 或渐变）的面一层层数，卡算第 1 层；整页宽的面（画布、顶栏）与 < 16 px 的标记（细条、开关钮、点）不算面；
  // 收口裁决：表单控件与按钮（含直接包着 input / select / textarea 的输入框外壳）不算一层，只数表面层
  const CTRL = 'input, select, textarea, button, [role="button"]'
  const surface = (el) => { if (el instanceof SVGElement || el.closest('.g5-venue') || el.matches(CTRL) || el.querySelector(':scope > input, :scope > select, :scope > textarea')) return false; const r = el.getBoundingClientRect(); if (Math.min(r.width, r.height) < 16 || r.width >= vw * 0.95) return false; const cs = getComputedStyle(el); const p = parse(cs.backgroundColor); return (p && p.a > 0.02) || /gradient/.test(cs.backgroundImage) }
  out.fillDepth = 0
  for (const el of all) {
    if (!surface(el) || el.closest('[data-audit-exempt]')) continue
    let d = 0
    for (let p = el; p && p !== document.body; p = p.parentElement) if (surface(p)) d += 1
    if (d > out.fillDepth) out.fillDepth = d
    if (d > LIMITS.fillDepth) sample('fillDepth', el)
  }
  // 卡圆角：[data-card] 卡（总览条不是卡）四角都必须是 10
  out.cardRadius = 0
  for (const el of document.querySelectorAll('[data-card]:not([data-card="overview"])')) {
    if (!visible(el)) continue
    const cs = getComputedStyle(el)
    if (['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].some((k) => Math.round(parseFloat(cs['border' + k + 'Radius'])) !== 10)) { out.cardRadius += 1; sample('cardRadius', el) }
  }
  // 活动卡静止态（列表没滚动）不许有半行条目：条目在祖先裁切框里只露出一部分即计数
  out.rowClip = 0
  for (const list of document.querySelectorAll('.gb-feed__list')) {
    const vp = list.closest('.gr-scrollarea__in')
    if (vp && vp.scrollTop > 0) continue
    let top = -Infinity, bottom = Infinity
    for (let p = list.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') { const b = p.getBoundingClientRect(); top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom) }
      if (p.matches('[data-card]')) break
    }
    top = Math.max(top, 0); bottom = Math.min(bottom, vh)
    for (const li of list.children) {
      const b = li.getBoundingClientRect(); const seen = Math.min(b.bottom, bottom) - Math.max(b.top, top)
      if (seen > 0.5 && seen < b.height - 1) { out.rowClip += 1; sample('rowClip', li) }
    }
  }
  // 容器嵌套：有底色 + 圆角的块套三层
  const boxy = (el) => { const cs = getComputedStyle(el); const p = parse(cs.backgroundColor); return (p && p.a > 0.02 || /gradient/.test(cs.backgroundImage)) && parseFloat(cs.borderTopLeftRadius) >= 6 && el.getBoundingClientRect().width > 80 }
  for (const el of all) { if (!boxy(el) || el.closest('[data-audit-exempt]')) continue; let d = 1, p = el.parentElement; while (p && p !== document.body) { if (boxy(p)) d += 1; p = p.parentElement } if (d >= 3) { out.nestDepth3 += 1; sample('nest', el) } }
  out.pass = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, out[k] <= v]))
  window.__grAudit = { LIMITS, out }
  return out
})()
