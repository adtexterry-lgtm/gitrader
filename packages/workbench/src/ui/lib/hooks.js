// SPDX-License-Identifier: CPAL-1.0
// 通用钩子（壳与块共用）。数据一律经块桥（@gitrader/blocks-sdk/preact），这里没有任何直连内核的轮询。
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

/** localStorage 持久化 state（读写都包 try，iframe / 隐私模式下退化为内存）。 */
export function useLocalStorage(key, initial) {
  const read = () => {
    try { const v = localStorage.getItem(key); return v === null ? initial : JSON.parse(v) } catch (_e) { return initial }
  }
  const [v, setV] = useState(read)
  const set = useCallback((next) => {
    setV((prev) => {
      const val = typeof next === 'function' ? next(prev) : next
      try { localStorage.setItem(key, JSON.stringify(val)) } catch (_e) { /* 无存储 */ }
      return val
    })
  }, [key])
  return [v, set]
}

/** 全局快捷键。combo 例：'k' + {mod:true}（⌘/Ctrl）、'Escape'、'?'。在输入框内默认不触发（allowInInput 例外）。 */
export function useHotkey(key, handler, { mod = false, allowInInput = false } = {}) {
  const h = useRef(handler)
  h.current = handler
  useEffect(() => {
    const on = (e) => {
      const tag = e.target && e.target.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)
      if (typing && !allowInInput) return
      const hasMod = e.metaKey || e.ctrlKey
      if (mod !== hasMod) return
      if (!mod && (e.altKey || hasMod)) return
      if (e.key.toLowerCase() !== key.toLowerCase()) return
      h.current(e)
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [key, mod, allowInInput])
}

/** 点击元素外部时回调（弹出菜单用）。 */
export function useClickAway(ref, onAway, active = true) {
  const cb = useRef(onAway)
  cb.current = onAway
  useEffect(() => {
    if (!active) return undefined
    const on = (e) => { if (ref.current && !ref.current.contains(e.target)) cb.current(e) }
    document.addEventListener('pointerdown', on, true)
    return () => document.removeEventListener('pointerdown', on, true)
  }, [ref, active])
}

/** 元素尺寸（ResizeObserver）。 */
export function useSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [ref])
  return size
}

/** 媒体查询是否命中（随系统 / 视口变化更新）：useMedia('(pointer: coarse)')、useMedia('(max-width: 599px)')。没有 matchMedia 的环境恒为 false。 */
export function useMedia(query) {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false)
  const [on, setOn] = useState(get)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined
    const mq = matchMedia(query)
    const fn = () => setOn(mq.matches)
    fn()
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [query])
  return on
}
