// SPDX-License-Identifier: CPAL-1.0
// 命令行语言与启动器名（0.1.1 UX-11 / UX-04）。
//   语言：--lang zh|en → 环境变量 GITRADER_LANG → 系统 locale（zh 开头取 zh，其余取 en）。
//   启动器名：便携包里没有全局 gitrader 命令，bin\gitrader.cmd 设 GITRADER_LAUNCHER；所有「下一步」命令经 cmdName() 拼出。
export type Lang = 'zh' | 'en'

const norm = (v: string | undefined): Lang | undefined => {
  const s = (v ?? '').trim().toLowerCase()
  return s.startsWith('zh') ? 'zh' : s.startsWith('en') ? 'en' : undefined
}

export function systemLang(): Lang {
  try { return norm(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en' } catch { return 'en' }
}

export function resolveLang(flagValue: string | true | undefined, env: Record<string, string | undefined>): Lang {
  return norm(typeof flagValue === 'string' ? flagValue : undefined) ?? norm(env.GITRADER_LANG) ?? norm(process.env.GITRADER_LANG) ?? systemLang()
}

/** 调用 CLI 的命令名：GITRADER_LAUNCHER 有值就用它（含空格加双引号），否则 gitrader。 */
export function cmdName(env: Record<string, string | undefined> = process.env): string {
  const l = (env.GITRADER_LAUNCHER ?? '').trim()
  return !l ? 'gitrader' : /\s/.test(l) && !l.startsWith('"') ? `"${l}"` : l
}

/** `gitrader serve` → 用启动器名拼出 `<launcher> serve`。 */
export const cmd = (env: Record<string, string | undefined>, rest: string): string => `${cmdName(env)} ${rest}`

/** 按语言选文案。io 只需要 lang 与 env。 */
export interface LangIo { lang?: Lang; env: Record<string, string | undefined> }
export const langOf = (io: LangIo): Lang => io.lang ?? resolveLang(undefined, io.env)
export const tr = (io: LangIo, zh: string, en: string): string => (langOf(io) === 'en' ? en : zh)

/** 本地时区的时间戳，带时区（UX-28）：2026-12-14 08:12 (UTC+8)。 */
export function fmtLocal(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const tz = off === 0 ? 'UTC' : `UTC${off > 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${p(Math.abs(off) % 60)}` : ''}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (${tz})`
}

/** 本地日期（不带时分）：到期日用。 */
export function fmtLocalDate(ms: number): string { return fmtLocal(ms).slice(0, 10) }

/** 把文本里的「gitrader <子命令>」换成启动器名（GITRADER_LAUNCHER 有值时才动）。json=true 时按 JSON 字符串转义，不破坏引号。 */
const CLI_CMD = /(?<![\w.\/-])gitrader(?= (?:init|serve|open|doctor|stop|status|keys|session|agent|mcp|skill|engines|pin|reconcile|plugins|paper|ledger|examples|config|risk|lab|notify|accounts|research)\b)/g
export function applyLauncher(env: Record<string, string | undefined>, text: string, json = false): string {
  const l = cmdName(env)
  if (l === 'gitrader') return text
  const rep = json ? JSON.stringify(l).slice(1, -1) : l
  return text.replace(CLI_CMD, () => rep)
}

/** 内核/协议说「要 PIN 在场」（缺在场证明）。 */
export const isPinRequired = (p: { name?: string; message?: string }): boolean =>
  p.name === 'ATTESTATION_REQUIRED' || (p.name === 'AUTH_FAILED' && /presence proof/i.test(p.message ?? ''))

/** 没有交互终端时的「要 PIN」文案（UX-E0-ds2）：协议里的「弹出的 PIN 层」是网页的说法，终端里没有那个层。 */
export function pinNeedsHuman(lang: Lang, env: Record<string, string | undefined>): { text: string; next: string } {
  const c = cmdName(env)
  return lang === 'en'
    ? { text: 'This step needs the PIN, and an agent cannot type it for you', next: `ask the user to run \`${c} open\` in their own terminal (it prompts for the PIN), or continue in the already signed-in workbench. Do not restart the service: that invalidates the browser's signed-in session.` }
    : { text: '这一步要 PIN，Agent 不能代输', next: `请让用户在自己的终端运行 \`${c} open\`（会提示输入 PIN），或回到已登录的工作台继续。不要重启服务：重启会让浏览器里已登录的会话失效。` }
}
