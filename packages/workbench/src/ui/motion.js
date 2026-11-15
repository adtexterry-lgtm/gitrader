// SPDX-License-Identifier: CPAL-1.0
// 动效封装（CSS transition / Web Animations API / requestAnimationFrame，不依赖任何动画库）。
// 规矩：只动 transform / opacity；全部尊重 prefers-reduced-motion（降级为 ≤ 120 ms 淡入淡出或直接到位）；克制：没有回弹、没有倾斜、没有放大。
// 页面和块里只调这里的函数（方便统一降级）。

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
/** 用户是否要求减少动效。 */
export const reduced = () => !!(mq && mq.matches)

/** = theme.css --gr-ease-out（r4：尾巴更利落，没有回弹）。 */
export const EASE_OUT = 'cubic-bezier(.16, 1, .3, 1)'
/** = theme.css --gr-ease-exit（r4：退场加速离开）。 */
export const EASE_EXIT = 'cubic-bezier(.4, 0, 1, 1)'
const animate = (el, keyframes, options) => (el && typeof el.animate === 'function' ? el.animate(keyframes, options) : null)
// Animation → Promise：播完或被取消都 resolve（取消 = 被下一段动效打断，不算错）；没有 el.animate 的环境直接 resolve。
const settle = (a) => (a && a.finished ? a.finished.then(() => {}, () => {}) : Promise.resolve())
// leave 用 fill: forwards 停在隐藏态；同一个元素随后 enter 时先撤掉它，否则 enter 播完后又被 leave 的末帧盖回透明。
const left = new WeakMap()

/**
 * 退场（r4 动效 D / D′：当前单上移淡出）：opacity 1 → 0、上移 |dy| px，dur ms，EASE_EXIT。元素停在隐藏态（调用方随后卸载它，或对同一元素调 enter）。
 * reduced() 时只做 120 ms 淡出、无位移。返回 Promise（播完 / 被打断都 resolve；没有 el.animate 直接 resolve）。
 */
export function leave(el, { dy = -8, dur = 200 } = {}) {
  const rm = reduced()
  const a = animate(el, rm ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateY(${dy}px)` }], { duration: rm ? 120 : dur, easing: EASE_EXIT, fill: 'forwards' })
  if (a) left.set(el, a)
  return settle(a)
}

/**
 * 入场（r4 动效 D：下一张从下 dy px 落位）：opacity 0 → 1、位移 dy → 0，dur ms，delay ms 后开始（延迟期间保持隐藏），EASE_OUT。
 * reduced() 时只做 120 ms 淡入、无位移、无延迟。返回 Promise（同 leave）。
 */
export function enter(el, { dy = 12, dur = 280, delay = 0 } = {}) {
  const prev = el && left.get(el)
  if (prev) { left.delete(el); prev.cancel() }
  const rm = reduced()
  return settle(animate(el, rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'none' }], { duration: rm ? 120 : dur, delay: rm ? 0 : delay, easing: EASE_OUT, fill: 'backwards' }))
}

/** 带流光（CSS 动画 gr-flow，在自身或 ::before / ::after 上）的元素。 */
const FLOW_HOSTS = '.gr-btn--primary, .gr-nav__item, .gr-tile-p'
const FLOW_FAST = 4

/**
 * 流光的运行时，壳启动时调一次（返回卸载函数）：
 * ① 页面不可见（切走 / 最小化）时给 :root 加 data-hidden，theme.css 把所有常驻动画暂停，省 GPU；
 * ② 指针 / 焦点落在流光元素上时，把指针所在路径上每个宿主「自己的」gr-flow 动画调到 4 倍速，离开回 1 倍——
 *    用 updatePlaybackRate 改速率，位置连续不跳帧（像光照进液体，局部加速）。减少动效时只做 ①。
 */
export function installFlow(doc = document) {
  const root = doc.documentElement
  const vis = () => root.toggleAttribute('data-hidden', doc.hidden)
  vis()
  doc.addEventListener('visibilitychange', vis)
  if (reduced()) return () => doc.removeEventListener('visibilitychange', vis)
  let lit = new Set()
  const own = (el) => (typeof el.getAnimations === 'function' ? el.getAnimations({ subtree: true }).filter((a) => /^gr-flow/.test(a.animationName || '') && a.effect && a.effect.target === el) : [])
  const light = (target) => {
    const next = new Set()
    for (let el = target && target.closest ? target.closest(FLOW_HOSTS) : null; el; el = el.parentElement ? el.parentElement.closest(FLOW_HOSTS) : null) next.add(el)
    for (const el of lit) if (!next.has(el)) own(el).forEach((a) => a.updatePlaybackRate(1))
    for (const el of next) if (!lit.has(el)) own(el).forEach((a) => a.updatePlaybackRate(FLOW_FAST))
    lit = next
  }
  const onOver = (e) => light(e.target)
  const onOut = (e) => { if (!e.relatedTarget) light(null) }
  doc.addEventListener('pointerover', onOver)
  doc.addEventListener('pointerout', onOut)
  doc.addEventListener('focusin', onOver)
  return () => {
    light(null)
    doc.removeEventListener('visibilitychange', vis)
    doc.removeEventListener('pointerover', onOver)
    doc.removeEventListener('pointerout', onOut)
    doc.removeEventListener('focusin', onOver)
  }
}

/** 页面切换：内容淡入 + 上移 8 px，240 ms。root 为页面根元素；targets 缺省取 .gr-page__head 与 .gr-page__body 的直接子项（最多 8 个，错开 30 ms）。 */
export function pageEnter(root, targets) {
  if (!root) return null
  const items = targets ? [].concat(targets) : Array.from(root.querySelectorAll(':scope > .gr-page__head, :scope > .gr-page__body > *')).slice(0, 8)
  const rm = reduced()
  items.forEach((el, i) => animate(el, rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: rm ? 120 : 240, delay: rm ? 0 : i * 30, easing: EASE_OUT, fill: 'backwards' }))
  return items.length ? items : null
}

/** 卡片悬停：v3 规范里已不放大、不倾斜（悬停只换底色，由 CSS 负责）。保留函数签名供旧调用，返回空解绑函数。 */
export function cardHover() { return () => {} }

const easeOutQuad = (t) => 1 - (1 - t) * (1 - t)

/** 通用的 0→1 进度驱动：duration 秒，ease-out，每帧 onFrame(p)。返回 { kill }（kill 后不再回调）。 */
function tween(duration, onFrame) {
  let raf = 0
  let dead = false
  const t0 = performance.now()
  const step = (now) => {
    if (dead) return
    const p = Math.min(1, (now - t0) / (duration * 1000))
    onFrame(easeOutQuad(p))
    if (p < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return { kill() { dead = true; cancelAnimationFrame(raf) } }
}

/**
 * 数字滚动：从 from 到 to，300 ms ease-out，每帧调 onUpdate(当前值)，结束时精确落在 to。
 * 典型：counter(prev, next, (v) => { el.textContent = F.usd(v) })。reduced 时直接到位。返回 { kill }。
 */
export function counter(from, to, onUpdate, { duration = 0.3 } = {}) {
  if (reduced() || !Number.isFinite(from) || !Number.isFinite(to) || from === to) { onUpdate(to); return { kill() {} } }
  return tween(duration, (p) => onUpdate(p >= 1 ? to : from + (to - from) * p))
}

/** toast 滑入：淡入 + 位移 16 px + 2px 模糊 + scale .97 → 1，350 ms，不回弹（from = 'top' 时从上往下，手机顶部用）。 */
export function toastIn(el, { from = 'bottom' } = {}) {
  const rm = reduced()
  const dy = from === 'top' ? '-16px' : '16px'
  return animate(el, rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${dy}) scale(.97)`, filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: rm ? 120 : 350, easing: EASE_OUT })
}

/** toast 退场：250 ms 淡出 + 缩到 .97（减少动效时 120 ms 只淡出）。返回 Animation（可 await .finished）。 */
export function toastOut(el) {
  const rm = reduced()
  return animate(el, rm ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.97)' }], { duration: rm ? 120 : 250, easing: EASE_EXIT, fill: 'forwards' })
}

/** 错误抖动（PIN 错、命令失败）：左右 6 px，80 + 60 ms × 2。减少动效时不抖（调用方另给红字）。 */
export function shake(el) {
  if (reduced()) return null
  return animate(el, [{ transform: 'none' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], { duration: 280, easing: EASE_OUT })
}

/**
 * 图表绘入：驱动一个 0→1 的进度 p（默认 600 ms，ease-out），每帧调 onUpdate(p)。
 * K 线：按 p 只画前 ceil(p·N) 根；权益曲线：按 p 裁剪路径。reduced 时直接 onUpdate(1)。返回 { kill }（kill 时补一帧 1）。
 */
export function chartDrawIn(onUpdate, { duration = 0.6 } = {}) {
  if (reduced()) { onUpdate(1); return { kill() {} } }
  const tw = tween(duration, (p) => onUpdate(p))
  return { kill() { tw.kill(); onUpdate(1) } }
}

/** 脉冲一次（新拦截徽标等）：不放大，只让透明度 1 → .55 → 1。 */
export function pulse(el) {
  if (reduced()) return null
  return animate(el, [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }], { duration: 280, easing: 'ease-in-out' })
}

/** 淡入 + 上移 6 px（抽屉 / 面板等通用入场），不回弹、不缩放。 */
export function popIn(el, { delay = 0 } = {}) {
  const rm = reduced()
  return animate(el, rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: rm ? 120 : 240, delay, easing: EASE_OUT, fill: 'backwards' })
}
