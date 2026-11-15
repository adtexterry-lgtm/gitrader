// SPDX-License-Identifier: CPAL-1.0
// 极薄的界面语言层：中文原文当键，查 zh→en 字典；查不到原样返回中文（并在调试开关打开时记一条缺词）。没有框架、没有 catalog 文件。
//   t('共 {0} 条', n)  —— 占位符 {0}{1}…；参数全是字符串 / 数字时返回字符串，含 Preact 节点时返回数组（可直接当子节点）。
//   tk(text)           —— 翻译「内核传来的中文自由文本」：先整句查字典，再按模板（正则）映射；认不出原样返回。
// 语言来源：设置里的选择（prefs.lang，存在 localStorage 的 gitrader.prefs，由内核偏好通道同步）→ 没设过看 navigator.language：zh 开头中文，其余英文。
// 切换语言 = 写偏好后重新加载页面（模块级常量里的文案在加载时就已翻好，不做运行时热切换）。
import { EN, TPL } from './i18n-en.js'

// 内核 / 协议中文自由文本的模板：{n} 匹配任意片段，片段自己再翻译（见 i18n-en.js 的 TPL）
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const UNITS = [['基点（万分之一）', 'bp'], ['占权益比', 'of equity'], ['毫秒', 'ms'], ['未知', 'unknown'], ['倍', 'x'], ['秒', 's'], ['次', 'times']] // protocol 的 unitLabel 产出
const unit = (s, tk) => { const r = tk(s); return r !== s ? r : UNITS.reduce((a, [zh, en]) => a.split(zh).join(en), s) }
const PATTERNS = Object.entries(TPL).map(([zh, en]) => [
  new RegExp('^' + zh.split(/(\{\d+\})/).map((p) => (/^\{\d+\}$/.test(p) ? '(.+?)' : esc(p))).join('') + '$', 's'),
  (m, tk) => en.replace(/\{(\d+)\}/g, (_, i) => unit(m[Number(i) + 1] ?? '', tk)),
])

const PREFS_KEY = 'gitrader.prefs'
const DEBUG_KEY = 'gitrader.i18n.debug'
const norm = (v) => (v === 'zh' || v === 'en' ? v : null)

/** 判定顺序：用户的选择 > navigator.language（zh 开头 = 中文）> 英文。 */
export function pickLang(saved, navLang) {
  return norm(saved) ?? (/^zh/i.test(String(navLang || '')) ? 'zh' : 'en')
}

function detect() {
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').lang } catch { /* 无存储 / 坏数据：按浏览器语言 */ }
  let nav = ''
  try { nav = navigator.language } catch { /* 无 navigator */ }
  return pickLang(saved, nav)
}

let lang = null
export const getLang = () => lang ?? (lang = detect())
/** 显式指定当前语言（测试 / 启动时用）；传 null 回到自动判定。同时更新 <html lang>。 */
export function setLang(l) { lang = norm(l); applyHtmlLang() }
export function applyHtmlLang() {
  try { document.documentElement.lang = getLang() === 'zh' ? 'zh-CN' : 'en' } catch { /* 无 DOM */ }
}
/** 当前语言对应的 Intl 区域（日期等格式化用）。 */
export const intlLocale = () => (getLang() === 'zh' ? 'zh-CN' : 'en-US')

const missing = new Set()
export const missingKeys = () => [...missing]
function noteMissing(key) {
  if (missing.has(key)) return
  missing.add(key)
  let on = false
  try { on = globalThis.__GR_I18N_DEBUG__ === true || localStorage.getItem(DEBUG_KEY) === '1' } catch { /* 无存储 */ }
  if (on) console.warn('[i18n] missing en:', key)
}

const isPlain = (v) => v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
function fill(s, args) {
  if (args.every(isPlain)) return s.replace(/\{(\d+)\}/g, (m, i) => (i < args.length && args[i] != null ? String(args[i]) : ''))
  return s.split(/(\{\d+\})/).map((p) => { const m = /^\{(\d+)\}$/.exec(p); return m ? args[Number(m[1])] : p }).filter((p) => p !== '')
}

export function t(zh, ...args) {
  let s = zh
  if (getLang() === 'en') {
    const e = EN[zh]
    if (e !== undefined) s = e
    else if (/[㐀-鿿]/.test(zh)) noteMissing(zh)
  }
  return args.length ? fill(s, args) : s
}

/** 内核传来的中文自由文本（拒绝原因、闸门说明、事件摘要等）：整句查字典，再按模板映射；认不出原样返回。 */
export function tk(text, quiet = false) {
  if (getLang() !== 'en' || typeof text !== 'string' || !/[㐀-鿿]/.test(text)) return text
  const e = EN[text]
  if (e !== undefined) return e
  for (const [re, fn] of PATTERNS) { const m = re.exec(text); if (m) return fn(m, (x) => tk(x, true)) }
  if (!quiet) noteMissing(text)
  return text
}
