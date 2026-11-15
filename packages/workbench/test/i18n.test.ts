// SPDX-License-Identifier: CPAL-1.0
// 界面语言层：t() 查表 / 回退 / 占位符，tk() 模板映射，语言来源判定顺序（用户选择 > navigator.language > 英文）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { EN } from '../src/ui/lib/i18n-en.js'
import { getLang, missingKeys, pickLang, setLang, t, tk } from '../src/ui/lib/i18n.js'

afterAll(() => setLang('zh')) // 固定中文是测试进程的默认（见根目录 vitest.setup.ts）

describe('pickLang：判定顺序', () => {
  it('用户的选择优先于浏览器语言', () => {
    expect(pickLang('en', 'zh-CN')).toBe('en')
    expect(pickLang('zh', 'en-US')).toBe('zh')
  })
  it('没设过：zh 开头用中文，其余用英文', () => {
    expect(pickLang(undefined, 'zh-CN')).toBe('zh')
    expect(pickLang(null, 'zh-TW')).toBe('zh')
    expect(pickLang(undefined, 'en-US')).toBe('en')
    expect(pickLang(undefined, 'fr')).toBe('en')
    expect(pickLang(undefined, undefined)).toBe('en')
  })
  it('不认识的选择值当没设过', () => {
    expect(pickLang('auto', 'zh-CN')).toBe('zh')
    expect(pickLang('xx', 'en-US')).toBe('en')
  })
})

describe('getLang：从偏好存储与 navigator 读', () => {
  const g = globalThis as Record<string, unknown>
  const saved = { ls: Object.getOwnPropertyDescriptor(g, 'localStorage'), nav: Object.getOwnPropertyDescriptor(g, 'navigator') }
  const put = (name: string, value: unknown) => Object.defineProperty(g, name, { value, configurable: true, writable: true })
  beforeEach(() => setLang(null)) // 回到自动判定
  afterAll(() => {
    for (const [name, d] of [['localStorage', saved.ls], ['navigator', saved.nav]] as const) { if (d) Object.defineProperty(g, name, d); else delete g[name] }
  })
  it('偏好里的 lang 优先', () => {
    put('navigator', { language: 'zh-CN' })
    put('localStorage', { getItem: () => JSON.stringify({ theme: 'deep', lang: 'en' }) })
    expect(getLang()).toBe('en')
  })
  it('偏好没有 lang：看 navigator.language', () => {
    put('localStorage', { getItem: () => JSON.stringify({ theme: 'deep' }) })
    put('navigator', { language: 'zh-HK' })
    setLang(null)
    expect(getLang()).toBe('zh')
    put('navigator', { language: 'en-GB' })
    setLang(null)
    expect(getLang()).toBe('en')
  })
  it('存储读不了或数据坏了：退回 navigator', () => {
    put('navigator', { language: 'en-US' })
    put('localStorage', { getItem: () => { throw new Error('denied') } })
    expect(getLang()).toBe('en')
    put('localStorage', { getItem: () => '{坏数据' })
    setLang(null)
    expect(getLang()).toBe('en')
  })
})

describe('t()：查表、占位符、回退', () => {
  it('中文模式：原样返回，占位符照填', () => {
    setLang('zh')
    expect(t('停止新开仓')).toBe('停止新开仓')
    expect(t('{0} 分 {1} 秒', 3, 5)).toBe('3 分 5 秒')
  })
  it('英文模式：查字典，占位符照填', () => {
    setLang('en')
    expect(t('停止新开仓')).toBe(EN['停止新开仓'])
    expect(t('停止新开仓')).toBe('Stop new positions')
    expect(t('{0} 分 {1} 秒', 3, 5)).toBe('3 min 5 s')
  })
  it('查不到：原样返回中文，并记一条缺词', () => {
    setLang('en')
    const word = '字典里一定没有的句子 ' + Math.random()
    expect(t(word)).toBe(word)
    expect(missingKeys()).toContain(word)
  })
  it('不含汉字的键不算缺词', () => {
    setLang('en')
    expect(t('BTC or hyperliquid:BTC')).toBe('BTC or hyperliquid:BTC')
    expect(missingKeys()).not.toContain('BTC or hyperliquid:BTC')
  })
  it('参数里有节点（对象）时返回数组，节点原样放在占位符位置', () => {
    setLang('en')
    const node = { type: 'b' }
    expect(t('{0} 分 {1} 秒', node, 5)).toEqual([node, ' min ', 5, ' s'])
  })
  it('字典的占位符与中文键一致', () => {
    for (const [zh, en] of Object.entries(EN) as Array<[string, string]>) {
      const ph = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',')
      // 英文可以只用到其中一部分占位符，但不能用中文键里没有的
      for (const i of ph(en).split(',').filter(Boolean)) expect(zh, zh).toContain(`{${i}}`)
    }
  })
})

describe('tk()：内核 / 协议中文自由文本', () => {
  it('中文模式不动', () => {
    setLang('zh')
    expect(tk('杠杆 3 超过上限 2 倍')).toBe('杠杆 3 超过上限 2 倍')
  })
  it('整句查字典', () => {
    setLang('en')
    expect(tk('这一步需要你输入 PIN 确认')).toBe('This step needs your PIN to confirm')
  })
  it('模板映射：片段再翻译，单位换成英文', () => {
    setLang('en')
    expect(tk('杠杆 5 倍 超过上限 3 倍')).toBe('Leverage 5 x exceeds the limit 3 x')
    expect(tk('行情已 12.5 秒没更新（上限 10 秒）')).toBe('Market data not updated for 12.5 s (limit 10 s)')
  })
  it('认不出的原样返回', () => {
    setLang('en')
    expect(tk('完全没见过的内核文案')).toBe('完全没见过的内核文案')
    expect(tk('plain english')).toBe('plain english')
  })
})
