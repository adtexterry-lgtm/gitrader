// SPDX-License-Identifier: Apache-2.0
// 契约 §2.8：Problem 对象与错误码表（GEP、GSP、MCP 结果、订单 problem 字段共用）；RuleHit 见 §2.7。
import type { Decimal } from './decimal'
import type { PrecheckId } from './ids'

export const PROBLEM_CATEGORIES = ['REJECTED', 'RISK', 'VENUE', 'ENGINE', 'PROTOCOL'] as const
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number]

/** RuleHit.code：取值见 §7.3 的 RiskCode 迁移行。 */
export const RULE_CODES = [
  'LEVERAGE', 'ORDER_NOTIONAL', 'POSITION_NOTIONAL', 'TOTAL_NOTIONAL', 'OPEN_POSITIONS', 'DAILY_LOSS', 'COOLDOWN',
  'INSUFFICIENT_MARGIN', 'REDUCE_ONLY', 'INSTRUMENT_NOT_ALLOWED', 'TRADING_STATE', 'DAILY_NOTIONAL',
  'VENUE_NOT_ALLOWED', 'SLIPPAGE', 'STALE_PRICE', 'RATE_BUDGET', 'MANDATE_LEVEL', 'MANDATE_EXPIRED',
  'MANDATE_LIMIT', 'NEEDS_APPROVAL', 'PROTECTOR',
  /** v0.1.2：denyLlmLiveEntries 生效，LLM 来源的实盘开仓被拒。 */
  'LLM_LIVE_ENTRY',
  'KILL_SWITCH', 'ACCOUNT_UNKNOWN', 'PROTECTOR_UNAVAILABLE', 'VENUE_RULE', 'MANDATE_INCOMPLETE',
  'SIZE_PRECISION', 'REDUCE_ONLY_MISMATCH', 'INTENT_EXPIRED',
  'TPSL_INVALID', 'STOP_REQUIRED',
] as const
export type RuleCode = (typeof RULE_CODES)[number]

export const RULE_HIT_ACTIONS = ['deny', 'warn', 'review', 'limit'] as const
export type RuleHitAction = (typeof RULE_HIT_ACTIONS)[number]

export interface RuleHit {
  /** 例 `pol_01JAB1#maxLeverage`、`mdt_01JAB6M2T4#autoMaxOrderNotional`。 */
  ruleId: string
  code: RuleCode
  message?: string
  limit: Decimal
  actual: Decimal
  unit: string
  action: RuleHitAction
  /** 作用域：org / group / account / mandate / strategy / instrument 等。 */
  scope: string
}

export interface ProblemVenue {
  id: string
  code?: string | number
  /** 原样保存上游报错，不翻译、不改写。 */
  message: string
}

export interface Problem {
  code: number
  /** 大写蛇形。 */
  name: string
  category: ProblemCategory
  message: string
  retryable: boolean
  retryAfterMs?: number
  /** category=RISK 必填。 */
  ruleHits?: RuleHit[]
  precheckId?: PrecheckId
  /** category=VENUE 必填。 */
  venue?: ProblemVenue
  correlationId?: string
  /** fix-r2：下单类调用结果未知（3006）时回传本次用到的 clientOrderId，按它查单 / 用同一个 id 重试。 */
  clientOrderIds?: string[]
}

export interface ProblemCodeInfo {
  code: number
  name: string
  category: ProblemCategory
  retryable: boolean
}

const c = (code: number, name: string, category: ProblemCategory, retryable = false): ProblemCodeInfo => ({ code, name, category, retryable })

/** §2.8 错误码表。3006 不得盲目重发（必须先按 clientOrderId 查状态），故 retryable=false。 */
export const PROBLEM_CODES = {
  PARSE_ERROR: c(-32700, 'PARSE_ERROR', 'PROTOCOL'),
  INVALID_REQUEST: c(-32600, 'INVALID_REQUEST', 'PROTOCOL'),
  METHOD_NOT_FOUND: c(-32601, 'METHOD_NOT_FOUND', 'PROTOCOL'),
  INVALID_PARAMS: c(-32602, 'INVALID_PARAMS', 'PROTOCOL'),
  INTERNAL_ERROR: c(-32603, 'INTERNAL_ERROR', 'PROTOCOL'),

  INSTRUMENT_UNKNOWN: c(1001, 'INSTRUMENT_UNKNOWN', 'REJECTED'),
  PRECISION: c(1002, 'PRECISION', 'REJECTED'),
  MIN_NOTIONAL: c(1003, 'MIN_NOTIONAL', 'REJECTED'),
  ORDER_TYPE_UNSUPPORTED: c(1004, 'ORDER_TYPE_UNSUPPORTED', 'REJECTED'),
  ACCOUNT_NOT_BOUND: c(1005, 'ACCOUNT_NOT_BOUND', 'REJECTED'),
  PRICE_DRIFT: c(1007, 'PRICE_DRIFT', 'REJECTED'),
  CONFIRM_TOKEN_INVALID: c(1008, 'CONFIRM_TOKEN_INVALID', 'REJECTED'),
  PROPOSAL_EXPIRED: c(1009, 'PROPOSAL_EXPIRED', 'REJECTED'),
  /** v0.1.3：人面动作缺在场证明（UI 通道）；壳弹出 PIN 层后带 attestation 重发。 */
  ATTESTATION_REQUIRED: c(1010, 'ATTESTATION_REQUIRED', 'REJECTED'),
  EXPERIMENT_FIELD_READONLY: c(1011, 'EXPERIMENT_FIELD_READONLY', 'REJECTED'),
  EXPERIMENT_FIELD_FROZEN: c(1012, 'EXPERIMENT_FIELD_FROZEN', 'REJECTED'),
  EXPERIMENT_TRANSITION_DENIED: c(1013, 'EXPERIMENT_TRANSITION_DENIED', 'REJECTED'),
  EXPERIMENT_EVIDENCE_INCOMPLETE: c(1014, 'EXPERIMENT_EVIDENCE_INCOMPLETE', 'REJECTED'),
  EXPERIMENT_APPEND_ONLY: c(1015, 'EXPERIMENT_APPEND_ONLY', 'REJECTED'),
  EXPERIMENT_FORBIDDEN: c(1016, 'EXPERIMENT_FORBIDDEN', 'REJECTED'),

  RULE_DENIED: c(2001, 'RULE_DENIED', 'RISK'),
  TRADING_STATE: c(2002, 'TRADING_STATE', 'RISK'),
  MANDATE_LEVEL: c(2003, 'MANDATE_LEVEL', 'RISK'),
  MANDATE_LIMIT: c(2004, 'MANDATE_LIMIT', 'RISK'),
  MANDATE_EXPIRED: c(2005, 'MANDATE_EXPIRED', 'RISK'),
  PROTECTOR_PAUSE: c(2006, 'PROTECTOR_PAUSE', 'RISK'),
  STALE_PRICE: c(2007, 'STALE_PRICE', 'RISK', true),
  RATE_BUDGET: c(2008, 'RATE_BUDGET', 'RISK', true),
  NEEDS_APPROVAL: c(2009, 'NEEDS_APPROVAL', 'RISK'),
  GATE_TICKET_INVALID: c(2010, 'GATE_TICKET_INVALID', 'RISK'),
  GATE_TICKET_EXPIRED: c(2011, 'GATE_TICKET_EXPIRED', 'RISK', true),

  VENUE_REJECTED: c(3001, 'VENUE_REJECTED', 'VENUE'),
  VENUE_RATE_LIMITED: c(3002, 'VENUE_RATE_LIMITED', 'VENUE', true),
  VENUE_UNAVAILABLE: c(3003, 'VENUE_UNAVAILABLE', 'VENUE', true),
  VENUE_INSUFFICIENT_MARGIN: c(3004, 'VENUE_INSUFFICIENT_MARGIN', 'VENUE'),
  VENUE_AUTH: c(3005, 'VENUE_AUTH', 'VENUE'),
  VENUE_OUTCOME_UNKNOWN: c(3006, 'VENUE_OUTCOME_UNKNOWN', 'VENUE'),

  INTERNAL: c(4001, 'INTERNAL', 'ENGINE'),
  STRATEGY_ERROR: c(4002, 'STRATEGY_ERROR', 'ENGINE'),
  BACKTEST_FAILED: c(4003, 'BACKTEST_FAILED', 'ENGINE'),
  BUSY: c(4004, 'BUSY', 'ENGINE', true),
  DATA_UNAVAILABLE: c(4005, 'DATA_UNAVAILABLE', 'ENGINE'),

  VERSION_UNSUPPORTED: c(5001, 'VERSION_UNSUPPORTED', 'PROTOCOL'),
  CAPABILITY_UNSUPPORTED: c(5002, 'CAPABILITY_UNSUPPORTED', 'PROTOCOL'),
  AUTH_FAILED: c(5003, 'AUTH_FAILED', 'PROTOCOL'),
  SESSION_GAP: c(5004, 'SESSION_GAP', 'PROTOCOL'),
  SEQUENCE_ERROR: c(5005, 'SEQUENCE_ERROR', 'PROTOCOL'),
  SECRET_FIELD_REJECTED: c(5006, 'SECRET_FIELD_REJECTED', 'PROTOCOL'),
  PAYLOAD_TOO_LARGE: c(5007, 'PAYLOAD_TOO_LARGE', 'PROTOCOL'),
  /** v0.1.9：调用了插件清单 `tools[]` 里没声明的工具。 */
  PLUGIN_TOOL_UNKNOWN: c(5008, 'PLUGIN_TOOL_UNKNOWN', 'PROTOCOL'),
  /** v0.1.9：插件工具的返回值不符合 `tools[].output`；结果不转发。 */
  PLUGIN_RESULT_INVALID: c(5009, 'PLUGIN_RESULT_INVALID', 'PROTOCOL'),
  /** B3-05A：本机安全状态文件损坏或读后被删除，必须人工恢复原文件并重启。 */
  STATE_FILE_CORRUPT: c(5010, 'STATE_FILE_CORRUPT', 'PROTOCOL'),
} as const satisfies Record<string, ProblemCodeInfo>

export type ProblemName = keyof typeof PROBLEM_CODES

/** 默认规则码到问题码映射；内核可按既有规则表映射，调用侧可补充未列规则。 */
export const RULE_PROBLEM_DEFAULTS: Partial<Record<RuleCode, ProblemName>> = {
  TRADING_STATE: 'TRADING_STATE', MANDATE_LEVEL: 'MANDATE_LEVEL', MANDATE_LIMIT: 'MANDATE_LIMIT', MANDATE_EXPIRED: 'MANDATE_EXPIRED',
  PROTECTOR: 'PROTECTOR_PAUSE', STALE_PRICE: 'STALE_PRICE', RATE_BUDGET: 'RATE_BUDGET', NEEDS_APPROVAL: 'NEEDS_APPROVAL',
  KILL_SWITCH: 'TRADING_STATE', ACCOUNT_UNKNOWN: 'STALE_PRICE', PROTECTOR_UNAVAILABLE: 'PROTECTOR_PAUSE',
  VENUE_RULE: 'RULE_DENIED', MANDATE_INCOMPLETE: 'NEEDS_APPROVAL',
  SIZE_PRECISION: 'PRECISION', REDUCE_ONLY_MISMATCH: 'NEEDS_APPROVAL', INTENT_EXPIRED: 'GATE_TICKET_EXPIRED',
  TPSL_INVALID: 'RULE_DENIED', STOP_REQUIRED: 'RULE_DENIED',
}

/** 按码段推断类别：1000–1999 REJECTED，2000–2999 RISK，3000–3999 VENUE，4000–4999 ENGINE，其余 PROTOCOL。 */
export function categoryOfCode(code: number): ProblemCategory {
  if (code >= 1000 && code < 2000) return 'REJECTED'
  if (code >= 2000 && code < 3000) return 'RISK'
  if (code >= 3000 && code < 4000) return 'VENUE'
  if (code >= 4000 && code < 5000) return 'ENGINE'
  return 'PROTOCOL'
}

/** 由码表构造一个 Problem；`extra` 里的字段覆盖默认值。 */
export function makeProblem(name: ProblemName, message: string, extra: Partial<Problem> = {}): Problem {
  const info = PROBLEM_CODES[name]
  return { code: info.code, name: info.name, category: info.category, message, retryable: info.retryable, ...extra }
}
