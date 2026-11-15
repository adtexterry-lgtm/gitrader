// SPDX-License-Identifier: CPAL-1.0
// E0 判据 j「全程用户可见报错 = 0」的纯函数（不读盘、不联网、不看时钟）。
// 与 b 的边界：b 是对 stderr 全文按宽泛词表（error/failed/invalid…）扫；j 是 维护者 口径的「用户眼睛看到的报错」——
// 只认 CLI 输出里以 error: / Error: / npm error / npm ERR! 开头的整行、用户命令的非零退出（带输出）、界面上的红色规则行 / 报错 toast / 错误页 / HTTP≥400 导航。
// 同一事件被 a/b/c 一并命中是允许的（各项各自计数）；j 内部则去重：同一行垫片日志与转录里的同一行只算一次。
import { stepOfCommand } from './patterns.mjs'

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const flat = (s) => String(s ?? '').replace(ANSI, '').replace(/\s+/g, ' ').trim()

/** CLI 报错行：行首（允许缩进）为 error: / Error: / npm error / npm ERR!。 */
export const CLI_ERROR_LINE = /^\s*(?:(?:error|Error|ERROR):|npm error\b|npm ERR!)/
export const errorLines = (text) => String(text ?? '').replace(ANSI, '').split(/\r?\n/).filter((l) => CLI_ERROR_LINE.test(l)).map(flat)

/** 界面上红色「禁止 / 拒绝」规则行的选择器（读自 blocks-r5 views/activity.tsx 与 pending.tsx 的现行渲染）：
 *  活动流规则行 .g5-l2（排除「待批」琥珀行 .g5-await 与中性说明 .g5o-why）、待批浮层 .g5-blocked（排除成功 .g5-ok 与琥珀 .g5-await）、
 *  任何 role=alert 的 .g5-blocked、data-tone="err" 的行。取整提示是中性说明（data-note / .g5o-why），不在其内。 */
export const RULE_SELECTORS = [
  '.g5-ar .g5-tx .g5-l2:not(.g5-await):not(.g5o-why)',
  '.g5-pendpop .g5-blocked:not(.g5-ok):not(.g5-await)',
  '.g5-blocked[role="alert"]',
  '[data-tone="err"]',
]

/** 错误页：标题或正文含这些词（会话已失效卡、浏览器自己的错误页）。 */
export const PAGE_ERROR_RE = /会话已失效|无法连接内核|无法访问此网站|ERR_[A-Z_]+|This site can.t be reached/

/** 页面快照 { title, body, rules: string[] } -> 可见报错 [{ kind: 'rule'|'page', text }]。 */
export function pageVisibleErrors(snap = {}) {
  const out = []
  for (const t of snap.rules ?? []) { const x = flat(t); if (x) out.push({ kind: 'rule', text: x.slice(0, 200) }) }
  const all = `${snap.title ?? ''}\n${snap.body ?? ''}`
  const hit = PAGE_ERROR_RE.exec(all)
  if (hit) out.push({ kind: 'page', text: flat(all.split(/\r?\n/).find((l) => PAGE_ERROR_RE.test(l)) ?? hit[0]).slice(0, 200) })
  return out
}

/** 按 kind+text 去重并累积截图路径（同一条红字挂在多次检查点上只算一次）。 */
export function addVisible(list, item, shot) {
  const hit = list.find((v) => v.kind === item.kind && v.text === item.text)
  if (hit) { if (shot && !hit.shots.includes(shot)) hit.shots.push(shot); return hit }
  const v = { kind: item.kind, text: item.text, shots: shot ? [shot] : [] }; list.push(v); return v
}

// 用户命令 = 某段命令以 gitrader / gitrader-mcp / npm / npx / pnpm 开头（Agent 读源码、跑别的脚本不算）。
const USER_CMD = /^(?:gitrader(?:-mcp)?|npm|npx|pnpm)(?:\s|$)/
export const isUserCommand = (cmd) => String(cmd ?? '').split(/&&|\|\||[;|&]/).some((seg) => USER_CMD.test(seg.trim().replace(/^(?:\w+=\S*\s+)+/, '')))
/** Agent 探测性调用（--help / -h / --version / help 子命令）：非零退出只列出来人工看，不判败。 */
export const isProbe = (cmd) => /(?:^|\s)(?:--help|-h|--version|-v|help)(?:\s|$)/.test(String(cmd ?? ''))

const KIND = { rule: '红色规则行', page: '错误页', toast: '报错 toast', http: 'HTTP≥400', nav: '导航失败' }

/**
 * 输入：stderr / cliOut [{ src, argv?, text }]（垫片日志、安装日志、serve 输出）、transcript（parseTranscript 产出）、
 *       browserVisible [{ kind, text, shots[] }]。
 * 输出：{ fails: [{ step, what }], manual: [string] }。
 */
export function judgeVisibleErrors({ stderr = [], cliOut = [], transcript = [], browserVisible = [] } = {}) {
  const fails = []; const manual = []; const seen = new Map() // 垫片日志已计的行 -> 剩余次数，转录里同一行不再重复计
  for (const s of [...stderr, ...cliOut]) {
    const step = s.src === 'install' ? 1 : stepOfCommand(String(s.argv ?? s.src))
    const probe = isProbe(s.argv)
    for (const l of errorLines(s.text)) {
      seen.set(l, (seen.get(l) ?? 0) + 1)
      const d = { step, what: `[步${step}] CLI(${s.src}${s.argv ? ` ${String(s.argv).slice(0, 60)}` : ''}): ${l.slice(0, 160)}` }
      ;(probe ? manual : fails).push(d)
    }
  }
  let hw = 1
  for (const c of transcript) {
    if (c.name !== 'Bash') continue
    const cmd = String(c.input?.command ?? ''); hw = Math.max(hw, stepOfCommand(cmd))
    if (!isUserCommand(cmd)) continue
    const out = String(c.output ?? '')
    const m = /Exit code (\d+)/.exec(out); const code = m ? Number(m[1]) : c.isError ? 1 : 0
    const body = out.replace(/^.*Exit code \d+.*$/m, '').trim()
    const lines = errorLines(out); const bucket = isProbe(cmd) ? manual : fails
    const tag = `[步${hw}] 转录 Bash: ${flat(cmd).slice(0, 100)}`
    for (const l of lines) { const n = seen.get(l) ?? 0; if (n > 0) { seen.set(l, n - 1); continue } bucket.push({ step: hw, what: `${tag} → ${l.slice(0, 160)}` }) }
    if (!lines.length && code !== 0 && body) bucket.push({ step: hw, what: `${tag} → exit ${code}: ${flat(body).slice(0, 140)}` })
  }
  for (const v of browserVisible) fails.push({ step: v.kind === 'rule' ? 5 : 3, what: `[浏览器·${KIND[v.kind] ?? v.kind}] ${v.text} — 截图 ${v.shots?.length ? v.shots.join('、') : '无'}` })
  return { fails, manual: manual.map((d) => d.what) }
}
