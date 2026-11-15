// SPDX-License-Identifier: CPAL-1.0
// 视觉轮 r4 · A2：motion.js 的曲线常量与 leave / enter 助手（WAAPI）。node 环境：用假元素记下 animate 的参数，不起浏览器。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// motion.js 在载入时取一次 matchMedia；先装一个可切换的假的，再载入
const mq = vi.hoisted(() => {
  const state = { matches: false }
  ;(globalThis as unknown as { matchMedia: unknown }).matchMedia = () => state
  return state
})
// @ts-expect-error motion.js 是纯 JS 模块（无声明文件），测试只按运行时行为断言
import * as M from '../src/ui/motion.js'

type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions }
function fakeEl() {
  const calls: Call[] = []
  const anims: Array<{ cancel: ReturnType<typeof vi.fn>; finished: Promise<unknown> }> = []
  const el = {
    calls,
    anims,
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ keyframes, options })
      const a = { cancel: vi.fn(), finished: Promise.resolve() }
      anims.push(a)
      return a
    },
  }
  return el
}
const theme = readFileSync(fileURLToPath(new URL('../src/ui/theme.css', import.meta.url)), 'utf8')
const norm = (s: string) => s.replace(/\s+/g, '').replace(/0\./g, '.')
const token = (name: string) => {
  const m = theme.match(new RegExp(`${name}:\\s*([^;]+);`))
  return m ? norm(m[1]!) : null
}

describe('motion.js · r4 曲线', () => {
  it('EASE_OUT / EASE_EXIT 是 r4 值，并与 theme.css 的 --gr-ease-out / --gr-ease-exit 同值', () => {
    expect(norm(M.EASE_OUT)).toBe('cubic-bezier(.16,1,.3,1)')
    expect(norm(M.EASE_EXIT)).toBe('cubic-bezier(.4,0,1,1)')
    expect(token('--gr-ease-out')).toBe(norm(M.EASE_OUT))
    expect(token('--gr-ease-exit')).toBe(norm(M.EASE_EXIT))
  })
})

describe('motion.js · leave / enter', () => {
  it('leave 缺省：上移 8 px 淡出、200 ms、退场曲线、停在隐藏态；返回 Promise', async () => {
    mq.matches = false
    const el = fakeEl()
    const p = M.leave(el)
    expect(p).toBeInstanceOf(Promise)
    await p
    const { keyframes, options } = el.calls[0]!
    expect(keyframes).toEqual([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }])
    expect(options).toMatchObject({ duration: 200, easing: M.EASE_EXIT, fill: 'forwards' })
  })

  it('enter 缺省：从下 12 px 落位、280 ms、出场曲线、delay 0；参数可改', async () => {
    mq.matches = false
    const el = fakeEl()
    await M.enter(el)
    expect(el.calls[0]!.keyframes).toEqual([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }])
    expect(el.calls[0]!.options).toMatchObject({ duration: 280, delay: 0, easing: M.EASE_OUT, fill: 'backwards' })
    await M.enter(el, { dy: 6, dur: 320, delay: 40 })
    expect(el.calls[1]!.keyframes[0]).toEqual({ opacity: 0, transform: 'translateY(6px)' })
    expect(el.calls[1]!.options).toMatchObject({ duration: 320, delay: 40 })
    await M.leave(el, { dy: -6, dur: 120 })
    expect(el.calls[2]!.keyframes[1]).toEqual({ opacity: 0, transform: 'translateY(-6px)' })
    expect(el.calls[2]!.options.duration).toBe(120)
  })

  it('减少动效：leave / enter 都只做 120 ms 淡入淡出，没有位移、没有延迟', async () => {
    mq.matches = true
    try {
      const el = fakeEl()
      await M.leave(el, { dy: -8, dur: 200 })
      await M.enter(el, { dy: 12, dur: 280, delay: 300 })
      for (const c of el.calls) {
        expect(c.options.duration).toBe(120)
        for (const k of c.keyframes) expect(k).not.toHaveProperty('transform')
      }
      expect(el.calls[0]!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }])
      expect(el.calls[1]!.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
      expect(el.calls[1]!.options.delay).toBe(0)
    } finally { mq.matches = false }
  })

  it('同一元素 leave 后再 enter：先撤掉退场动画（否则 forwards 末帧会把元素盖回透明）', async () => {
    const el = fakeEl()
    await M.leave(el)
    await M.enter(el)
    expect(el.anims[0]!.cancel).toHaveBeenCalledTimes(1)
    expect(el.anims[1]!.cancel).not.toHaveBeenCalled()
  })

  it('动画被打断（finished 拒绝）也 resolve，不抛', async () => {
    const el = { animate: () => ({ cancel() {}, finished: Promise.reject(new DOMException('aborted', 'AbortError')) }) }
    await expect(M.leave(el)).resolves.toBeUndefined()
    await expect(M.enter(el)).resolves.toBeUndefined()
  })

  it('没有 el.animate 的环境（旧浏览器）与空元素：直接 resolve，不抛错', async () => {
    await expect(M.leave({})).resolves.toBeUndefined()
    await expect(M.enter({})).resolves.toBeUndefined()
    await expect(M.leave(null)).resolves.toBeUndefined()
    await expect(M.enter(undefined)).resolves.toBeUndefined()
  })
})
