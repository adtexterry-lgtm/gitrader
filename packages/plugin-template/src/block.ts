// SPDX-License-Identifier: Apache-2.0
// 指标块（iframe 沙箱里运行的第三方块）：EMA 读数。入口：宿主把本模块放进 sandbox="allow-scripts" 的 iframe，
// 这里用 connectHostBridge 握手拿到块桥，之后只经桥读行情（清单里声明了什么才能读什么），不碰网络、不碰凭据、不发命令。
// 打包：npm run build（esbuild → example/ema-reading/block.js，再钉版本 + 哈希）。
import { connectHostBridge, type BlockBridge } from '@gitrader/blocks-sdk'
import { CloseBuffer, candlesOf, reading, type Reading } from './ema'

const PERIODS = [9, 21, 55] as const
const INTERVAL = '15m'

// 只用 currentColor 与透明度，跟随宿主给 iframe 的字色；不写颜色字面量。
const STYLE = `
.ema{box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:center;gap:8px;padding:12px 14px}
.ema__top{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.7}
.ema__top button{font:inherit;color:inherit;background:none;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;opacity:.7}
.ema__top button[aria-pressed="true"]{opacity:1;background:color-mix(in srgb, currentColor 16%, transparent)}
.ema__v{font-size:28px;line-height:1.1;font-variant-numeric:tabular-nums}
.ema__sub{display:flex;gap:12px;font-size:13px;font-variant-numeric:tabular-nums;opacity:.8}
.ema__wait{font-size:13px;opacity:.6}
`

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '')

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export function draw(root: HTMLElement, r: Reading, onPeriod: (p: number) => void): void {
  const wrap = el('div', 'ema')
  const top = el('div', 'ema__top')
  top.append(el('span', undefined, `EMA ${r.period}`))
  for (const p of PERIODS) {
    const b = el('button', undefined, String(p))
    b.type = 'button'
    b.setAttribute('aria-pressed', String(p === r.period))
    b.addEventListener('click', () => onPeriod(p))
    top.append(b)
  }
  wrap.append(top)
  if (r.ema === null) wrap.append(el('div', 'ema__wait', r.bars === 0 ? '等行情' : `还差 ${r.period - r.bars} 根 K 线`))
  else {
    wrap.append(el('div', 'ema__v', nf.format(r.ema)))
    const sub = el('div', 'ema__sub')
    sub.append(el('span', undefined, `收盘 ${r.last === null ? '—' : nf.format(r.last)}`))
    if (r.diffPct !== null) sub.append(el('span', undefined, `${r.trend === 'up' ? '▲' : r.trend === 'down' ? '▼' : '–'} ${sign(r.diffPct)}${Math.abs(r.diffPct).toFixed(2)}%`))
    wrap.append(sub)
  }
  root.replaceChildren(wrap)
}

export async function start(root: HTMLElement, bridge: BlockBridge): Promise<() => void> {
  const style = el('style', undefined, STYLE)
  document.head.append(style)
  const buf = new CloseBuffer(500)
  let period = 21
  let symbol = (await bridge.hello()).links.symbol as string | undefined
  let off: (() => void) | null = null
  const paint = () => draw(root, reading(buf.closes, period), (p) => { period = p; paint() })

  const attach = async () => {
    off?.()
    buf.clear()
    paint()
    const filter = symbol ? { instrumentId: symbol } : undefined
    try { buf.push(candlesOf(await bridge.query('market.candles', { instrumentId: symbol, interval: INTERVAL, limit: 200 }))) } catch { /* 查不到历史就只用实时 */ }
    off = bridge.subscribe('market.candles', (e) => { buf.push(candlesOf(e.data)); paint() }, { ...(filter ? { filter } : {}), maxHz: 1 })
    paint()
  }
  const offLink = bridge.link.subscribe('symbol', (v) => { symbol = typeof v === 'string' ? v : undefined; void attach() })
  await attach()
  return () => { off?.(); offLink(); style.remove() }
}

// iframe 里自动启动（单测 import 本模块时没有 window.__GITRADER_BLOCK__，不会触发）。
if (typeof window !== 'undefined' && (window as unknown as { __GITRADER_BLOCK__?: unknown }).__GITRADER_BLOCK__) {
  const root = document.getElementById('root') ?? document.body
  void connectHostBridge().then((b) => start(root, b)).catch((e: Error) => { root.textContent = e.message })
}
