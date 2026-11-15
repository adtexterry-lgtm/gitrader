// SPDX-License-Identifier: CPAL-1.0
// E0 门禁的判据常量（ADR-12）。错误模式表只有这一处；排除清单只允许三类：判据自身日志、品牌与 URL 片段、测试注入（测试里造的坏数据本就该判败，不是排除）。

/** 错误模式（ADR-12）。STALE 只认 STALE_ 开头的错误码（STALE_PRICE…）：裸词 stale 会误中状态 JSON 里的 "stale": false、stalePriceMs 等字段（基线第一次跑就踩到）。 */
export const ERROR_RE = /\b(error|failed|invalid|corrupt|unauthorized|E404|ECONN\w*|STALE_[A-Z_]+|INSTRUMENT_NOT_ALLOWED|INVALID_PARAMS)\b/i

/** 屏上英文内部码：全大写下划线词（STALE_PRICE、RISK_LIMIT_EXCEEDED…）。 */
export const SCREEN_CODE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/

/** 排除（2）：品牌与 URL 片段。其余一律不排除。 */
const BRAND = /gitrader-mcp|gitrader\.json|gitrader/gi
const URL_RE = /https?:\/\/\S+/gi
export function exclude(text) { return String(text ?? '').replace(URL_RE, ' ').replace(BRAND, ' ') }

export const matchesError = (text) => ERROR_RE.test(exclude(text))
export const screenCode = (text) => SCREEN_CODE_RE.exec(exclude(text))?.[0] ?? ERROR_RE.exec(exclude(text))?.[0] ?? null

/** 人类模拟器动作白名单。 */
export const HUMAN_ALLOWED = ['setPin', 'approve']

/** 七步。 */
export const STEPS = ['装', '起', '设 PIN', '接 Agent', '第一单（带止损）', '批准', '看结果']

/** Bash 命令 → 七步的里程碑（取最先命中的最高档；调用方再做单调取最大。启发式：报告按「最早出错的步」读，不是精确归因）。 */
const MILESTONES = [
  [7, /\bledger\b|\bpositions?\b|\bfills?\b|\baccount\b/],
  [6, /\bapprov|\bproposals?\b/],
  [5, /\bpropose\b|\border\b|\bplace\b|\bplugins call\b/],
  [4, /\bkeys new agent\b|\bmcp snippet\b|\.mcp\.json|\bclaude mcp\b|gitrader-mcp/],
  [3, /\bpin\b|\bopen\b|\bsession link\b/],
  [2, /\bserve\b|\bstatus\b/],
]
export function stepOfCommand(cmd) { for (const [n, re] of MILESTONES) if (re.test(cmd)) return n; return 1 }

/** DeepSeek 估算价（¥ / 百万 token）。估算偏保守，实际以账单为准；只用于成本上限。 */
export const PRICE_YUAN_PER_M = { input: 1.0, cacheRead: 0.2, output: 2.0 }
export const costYuan = (u = {}) => ((u.input_tokens ?? 0) * PRICE_YUAN_PER_M.input + (u.cache_read_input_tokens ?? 0) * PRICE_YUAN_PER_M.cacheRead + (u.cache_creation_input_tokens ?? 0) * PRICE_YUAN_PER_M.input + (u.output_tokens ?? 0) * PRICE_YUAN_PER_M.output) / 1e6

/** 不许占用的端口。 */
export const RESERVED_PORTS = new Set([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831])
export const portReserved = (p) => RESERVED_PORTS.has(p) || (p >= 47900 && p <= 49999)
