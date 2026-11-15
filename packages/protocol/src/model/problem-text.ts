// SPDX-License-Identifier: Apache-2.0
// 问题码 / 规则码的中文表面文案：给 UI、CLI 与 Agent 共用。文案只描述现象与下一步，不暴露内部英文原文。

export type ProblemSurface = 'ui' | 'cli' | 'agent'

export interface HumanText {
  zh: string
  next?: string
}

export interface ProblemLike {
  name: string
  message?: string
  retryAfterMs?: number
  details?: unknown
  ruleHits?: Array<{ code: string; limit?: string; actual?: string; unit?: string }>
}

/** 一条人话文案；键为 ProblemName 或 `ProblemName:子码`。 */
export const PROBLEM_TEXT: Readonly<Record<string, HumanText>> = {
  PARSE_ERROR: { zh: '请求内容读不懂，可能是版本不一致', next: '升级到最新版本后重试' },
  INVALID_REQUEST: { zh: '请求格式不对，已被拒绝', next: '运行 gitrader doctor 检查版本与服务状态' },
  METHOD_NOT_FOUND: { zh: '这个功能当前的引擎不支持', next: '运行 gitrader --version 确认版本是否匹配' },
  INVALID_PARAMS: { zh: '参数不对或缺少必填项', next: '运行 gitrader help 查看参数写法；--out 只写名字，例如 --out 2026-10' },
  INTERNAL_ERROR: { zh: '引擎内部出错，这次操作没有完成', next: '重试一次；仍失败请运行 gitrader doctor' },

  INSTRUMENT_UNKNOWN: { zh: '没有这个标的的行情源', next: '检查网络是否离线，或标的写法（例如 hyperliquid:BTC）' },
  PRECISION: { zh: '价格或数量精度不对', next: '按交易所精度调整价格和数量的小数位' },
  MIN_NOTIONAL: { zh: '下单金额太小，没到交易所的最小值', next: '把下单金额调大一些再试' },
  ORDER_TYPE_UNSUPPORTED: { zh: '这个交易场所不支持这种订单类型', next: '换成限价单或市价单再试' },
  ACCOUNT_NOT_BOUND: { zh: '还没绑定交易账户', next: '运行 gitrader account add 绑定账户' },
  PRICE_DRIFT: { zh: '价格变化太快，确认时已经偏离', next: '重新发起一次下单并确认' },
  CONFIRM_TOKEN_INVALID: { zh: '确认凭证已失效', next: '重新点一次确认按钮' },
  PROPOSAL_EXPIRED: { zh: '这张提案已失效或已被拒绝，不能再批', next: '重新提交一张提案' },
  ATTESTATION_REQUIRED: { zh: '这一步需要你输入 PIN 确认', next: '在弹出的 PIN 层输入 PIN 后重试' },
  EXPERIMENT_FIELD_READONLY: { zh: '实验里这个字段不能改', next: '换一个可改的字段，或新建实验' },
  EXPERIMENT_FIELD_FROZEN: { zh: '实验已冻结，这个字段不能再改', next: '先解冻实验再修改' },
  EXPERIMENT_TRANSITION_DENIED: { zh: '实验不能从当前状态切到目标状态', next: '查看实验状态说明后按顺序切换' },
  EXPERIMENT_EVIDENCE_INCOMPLETE: { zh: '实验证据还没补齐', next: '补齐证据后再推进实验' },
  EXPERIMENT_APPEND_ONLY: { zh: '实验记录只能追加，不能改旧记录', next: '追加一条新记录，别改历史' },
  EXPERIMENT_FORBIDDEN: { zh: '当前账号不能做这个实验操作', next: '换有权限的账号，或让管理员开权限' },

  RULE_DENIED: { zh: '风控规则拦下了这笔单', next: '查看下面的规则明细，调整后重试' },
  TRADING_STATE: { zh: '交易已暂停：有对账待处理，处理完才能恢复', next: '打开对账页处理完待办，再恢复交易' },
  // fix-r4：通用句不再写死「实盘」；只读档与实盘档位不够各有子码
  MANDATE_LEVEL: { zh: '这把钥匙的档位不允许这个操作', next: '在钥匙设置里调整档位' },
  'MANDATE_LEVEL:readonly': { zh: '这把钥匙是只读档，不能下单或提案', next: '在工作台把它的档位改成「需确认」或更高' },
  'MANDATE_LEVEL:live': { zh: '这把钥匙的档位不允许实盘下单', next: '在钥匙设置里调高档位，或改用纸面账户' },
  'MANDATE_LEVEL:not_owner': { zh: '这把钥匙只能停自己启动的策略', next: '在工作台里停止它，或把钥匙档位调到「需确认」以上' },
  MANDATE_LIMIT: { zh: '超出这把钥匙的限额', next: '调低下单金额，或调整钥匙限额' },
  MANDATE_EXPIRED: { zh: '这把钥匙已被撤销或过期', next: '重新创建一把钥匙' },
  PROTECTOR_PAUSE: { zh: '保护单没挂上，交易已暂停', next: '检查保护单设置，恢复后重试' },
  STALE_PRICE: { zh: '行情太久没更新，这笔单被拦下', next: '等行情恢复后重试' },
  RATE_BUDGET: { zh: '下单太频繁，已触发限流', next: '等一会儿再试' },
  NEEDS_APPROVAL: { zh: '这一步需要你确认后才能继续', next: '在审批卡上点确认' },
  GATE_TICKET_INVALID: { zh: '风控通行证无效', next: '重新发起下单，让系统再核一次' },
  GATE_TICKET_EXPIRED: { zh: '风控通行证已过期', next: '重新发起下单获取新的通行证' },

  VENUE_REJECTED: { zh: '交易场所拒了这笔单', next: '查看交易所返回的原因后调整' },
  VENUE_RATE_LIMITED: { zh: '交易场所限流了', next: '等一会儿再试' },
  VENUE_UNAVAILABLE: { zh: '交易场所暂时连不上', next: '稍后重试；持续失败请运行 gitrader doctor' },
  VENUE_INSUFFICIENT_MARGIN: { zh: '交易所侧保证金不够', next: '降低仓位或划入更多保证金' },
  VENUE_AUTH: { zh: '交易所密钥无效或权限不够', next: '检查 API 密钥与权限后重新绑定账户' },
  VENUE_OUTCOME_UNKNOWN: { zh: '结果未知，可能已成交', next: '先按 clientOrderId 查，不要直接重发' },

  INTERNAL: { zh: '引擎内部出错，这次操作没有完成', next: '重试一次；仍失败请运行 gitrader doctor' },
  STRATEGY_ERROR: { zh: '策略运行出错，已停止', next: '查看策略日志，修好后重启策略' },
  BACKTEST_FAILED: { zh: '回测没跑成功', next: '检查数据区间和参数后重跑' },
  BUSY: { zh: '引擎忙，请稍后再试', next: '等几秒再试' },
  DATA_UNAVAILABLE: { zh: '数据暂时取不到', next: '等一下再刷新' },

  VERSION_UNSUPPORTED: { zh: '版本不匹配，当前版本不支持', next: '升级 gitrader 后重试' },
  CAPABILITY_UNSUPPORTED: { zh: '当前引擎不支持这个能力', next: '升级 gitrader 或换支持的交易场所' },
  AUTH_FAILED: { zh: '登录已过期，需要重新登录', next: '在 serve 窗口按 Enter 拿新链接；或运行 gitrader session login' },
  SESSION_GAP: { zh: '会话中间缺了一段数据', next: '重新连接后会自动补齐' },
  SEQUENCE_ERROR: { zh: '消息顺序乱了，已被拒绝', next: '重新连接后重试' },
  SECRET_FIELD_REJECTED: { zh: '请求里带了不该传的密钥字段', next: '去掉密钥字段，密钥只留在本机' },
  PAYLOAD_TOO_LARGE: { zh: '请求内容太大', next: '拆小后再发' },
  PLUGIN_TOOL_UNKNOWN: { zh: '插件没有声明这个工具', next: '在插件清单里声明后再调用' },
  PLUGIN_RESULT_INVALID: { zh: '插件返回的结果不符合约定', next: '检查插件版本与输出格式' },

  'AUTH_FAILED:invalid_pin': { zh: 'PIN 不对，请再输一次', next: '重新输入 PIN' },
  'AUTH_FAILED:locked': { zh: 'PIN 试错次数过多，请稍后再试', next: '等一会儿再试；忘了 PIN 可用 gitrader pin reset' },
  'AUTH_FAILED:pin_required': { zh: '这一步需要你输入 PIN 确认', next: '在弹出的 PIN 层输入 PIN 后重试' },
  'AUTH_FAILED:token_revoked': { zh: '令牌无效或已被撤销，请重新创建钥匙', next: '运行 gitrader key create 创建新钥匙' },
  'AUTH_FAILED:pin_not_set': { zh: '本机还没设置 PIN', next: '在工作台「设置 → 钥匙」里设置 PIN，或在终端运行 gitrader init 按提示设置' },
  'INVALID_PARAMS:pin_format': { zh: 'PIN 要 6–12 位数字，或 8–64 位口令', next: '重新输入符合要求的 PIN' },
  'INVALID_PARAMS:reason': { zh: '参数不对：原因说明缺失或不合规', next: '补上原因说明后重试' },
  'INVALID_PARAMS:workspace_path': { zh: '只能导出到 <home>/exports 下的相对路径', next: '用 --out <名字>（相对路径），例如 --out 2026-10' },

  /** 另一分支新增的码，提前占位。 */
  STATE_FILE_CORRUPT: {
    zh: '本机安全文件损坏：PIN 或钥匙文件读不出来',
    next: '运行 gitrader doctor 查看；忘了 PIN 可用 gitrader pin reset',
  },
  'STATE_FILE_CORRUPT:paper_state': {
    zh: '纸面状态文件和账本对不上（或被删 / 截断 / 改过）',
    next: '见 gitrader doctor：用备份或 paper-state.json.prev 还原，或停服务后 gitrader paper rebuild-from-ledger',
  },
  'STATE_FILE_CORRUPT:ledger_db': { zh: '账本数据库不见了或打不开', next: '从备份还原 data/gitrader.sqlite' },

  'RATE_BUDGET:op_rate': { zh: '调用太频繁，这把钥匙被限流了', next: '等几秒再试；批量调用请放慢' },
  'RATE_BUDGET:venue_weight': { zh: '场所请求额度用完了（场所权重预算）', next: '等一分钟再试' },
  'VENUE_REJECTED:interrupted': { zh: '内核在这张单发到纸面场所之前停了，这张单从没下出去', next: '需要的话重新下单' },
  'VENUE_UNAVAILABLE:not_ready': { zh: '行情尚未就绪（标的列表还在加载），3 秒后重试', next: '等 3 秒再试一次；超过 2 分钟仍这样，运行 gitrader doctor' },
  'VENUE_REJECTED:order_unknown': { zh: '纸面场所不认识这张单（没下出去、已撤或已成交）', next: '查一下订单状态，需要的话重新下单' },
}

type RuleHitText = { action?: string; ruleId?: string; limit?: string; actual?: string; unit?: string }

/** 数值后面的单位说明；`violations` 这类内部字面量不展示。 */
function unitLabel(unit: string | undefined): string {
  if (!unit || unit === 'violations') return ''
  if (unit === 'ms') return '毫秒'
  if (unit === 'bp') return '基点（万分之一）'
  if (unit === 'ratio') return '占权益比'
  if (unit === 'x') return '倍'
  if (unit === 's') return '秒'
  if (unit === '%') return '%'
  return unit
}

function shown(value: string | undefined, unit: string | undefined): string {
  const raw = value ?? '未知'
  const label = unitLabel(unit)
  return label ? `${raw} ${label}` : raw
}

/** 毫秒换算成秒，保留 1 位小数；其它单位原样。 */
function asSeconds(value: string | undefined, unit: string | undefined): string {
  const num = Number(value)
  if (!Number.isFinite(num)) return '未知'
  return unit === 'ms' ? (num / 1000).toFixed(1) : String(num)
}

/** 规则码到人话；参数缺失时用「未知」占位，绝不回显英文错误串。 */
export const RULE_TEXT: Readonly<Record<string, (h: RuleHitText) => string>> = {
  LEVERAGE: ({ limit, actual, unit }) => `杠杆 ${shown(actual, unit)} 超过上限 ${shown(limit, unit)}`,
  ORDER_NOTIONAL: ({ limit, actual, unit }) => `单笔名义 ${shown(actual, unit)} 超过上限 ${shown(limit, unit)}`,
  POSITION_NOTIONAL: ({ limit, actual, unit }) => `该标的持仓名义 ${shown(actual, unit)} 超过上限 ${shown(limit, unit)}`,
  TOTAL_NOTIONAL: ({ limit, actual, unit }) => `账户总持仓名义 ${shown(actual, unit)} 超过上限 ${shown(limit, unit)}`,
  OPEN_POSITIONS: ({ limit, actual, unit }) => `持仓数量 ${shown(actual, unit)} 已达上限 ${shown(limit, unit)}`,
  DAILY_LOSS: ({ limit, actual, unit }) => `当日亏损 ${shown(actual, unit)} 达到上限 ${shown(limit, unit)}`,
  COOLDOWN: ({ ruleId, limit, actual, unit }) => {
    // fix-r4 C13：重复意图窗口复用 COOLDOWN 码（actual 恒为 0）；它不是「开仓冷却」，不说「还需 N 秒」
    if (ruleId?.endsWith('#duplicateIntent')) return `刚提交过一笔相同的单，${asSeconds(limit, unit)} 秒内不重复提交`
    const remain = Math.max(0, Number(limit ?? 0) - Number(actual ?? 0))
    const secs = Number.isFinite(remain) ? (unit === 'ms' ? (remain / 1000).toFixed(1) : String(remain)) : '未知'
    return `开仓冷却中，还需 ${secs} 秒`
  },
  INSUFFICIENT_MARGIN: ({ limit, actual, unit }) => `保证金不够：需要 ${shown(limit, unit)}，当前 ${shown(actual, unit)}`,
  REDUCE_ONLY: () => '只减仓模式：这张单会增加仓位',
  INSTRUMENT_NOT_ALLOWED: () => '该标的不在这把钥匙的白名单里',
  TRADING_STATE: () => '当前交易状态不允许这笔操作',
  DAILY_NOTIONAL: ({ limit, actual, unit }) => `今日成交名义 ${shown(actual, unit)} 超过上限 ${shown(limit, unit)}`,
  VENUE_NOT_ALLOWED: () => '这个交易场所不在这把钥匙的白名单里',
  SLIPPAGE: ({ limit, actual, unit }) => `滑点 ${shown(actual, unit)} 超过上限 ${shown(limit, unit)}`,
  STALE_PRICE: ({ limit, actual, unit }) => `行情已 ${asSeconds(actual, unit)} 秒没更新（上限 ${asSeconds(limit, unit)} 秒）`,
  RATE_BUDGET: ({ limit, actual, unit }) => unit === 'weight/min'
    ? `场所请求权重超限：当前 ${actual ?? '未知'}，上限 ${limit ?? '未知'}（每分钟）`
    : `下单频率超限：当前 ${shown(actual, unit)}，上限 ${shown(limit, unit)}`,
  MANDATE_LEVEL: () => '这把钥匙的档位不允许这个操作', // fix-r4：不再写死「实盘开仓」（纸面账户也会命中）；具体原因在内核 message 里
  MANDATE_EXPIRED: () => '这把钥匙已过期或被撤销',
  MANDATE_LIMIT: ({ limit, unit }) => `超出这把钥匙的限额（上限 ${shown(limit, unit)}）`,
  NEEDS_APPROVAL: () => '这一步需要你确认后才能继续',
  PROTECTOR: () => '保护单没挂上，交易已暂停',
  LLM_LIVE_ENTRY: () => 'AI 不能直接实盘开仓，只能走纸面单或提案',
  KILL_SWITCH: () => '总开关已关闭，所有下单暂停',
  ACCOUNT_UNKNOWN: () => '账户还没连上或状态未知',
  PROTECTOR_UNAVAILABLE: () => '保护单服务不可用，交易已暂停',
  VENUE_RULE: () => '交易所有规则限制，这笔单被拒',
  MANDATE_INCOMPLETE: () => '「需确认」档需要补：场所、标的、单笔上限、日额上限',
  SIZE_PRECISION: (h) => (h.action === 'limit' ? '数量已按最小步长取整' : '下单数量精度不对'),
  REDUCE_ONLY_MISMATCH: () => '只减仓方向不对：这张单会加仓',
  INTENT_EXPIRED: () => '这笔委托意图已过期，请重新发起',
  TPSL_INVALID: () => '止损止盈价位不合规',
  STOP_REQUIRED: () => 'Agent 开仓必须带止损',
}

/** 按 message 关键字挑子码；只认表里列出的几种。 */
function subcodeOf(name: string, message: string): string | undefined {
  const m = message.toLowerCase()
  if (name === 'AUTH_FAILED') {
    if (m.includes('too many failed')) return 'locked'
    if (m.includes('invalid pin')) return 'invalid_pin'
    if (m.includes('presence proof')) return 'pin_required'
    if (m.includes('revoked') || m.includes('authentication required')) return 'token_revoked'
    if (m.includes('pin not set')) return 'pin_not_set'
    return undefined
  }
  if (name === 'MANDATE_LEVEL') {
    if (m.startsWith('stop_strategy:')) return 'not_owner'
    if (m.startsWith('live ') || m.includes('direct live')) return 'live'
    if (m.includes('this key is l0')) return 'readonly'
    return undefined
  }
  if (name === 'STATE_FILE_CORRUPT') {
    if (m.includes('paper state')) return 'paper_state'
    if (m.includes('ledger database')) return 'ledger_db'
    return undefined
  }
  if (name === 'RATE_BUDGET') {
    if (m.includes('operation rate limit')) return 'op_rate'
    if (m.includes('venue weight') || m.includes('weight/min')) return 'venue_weight'
    return undefined
  }
  if (name === 'VENUE_UNAVAILABLE') {
    if (message.startsWith('market data not ready')) return 'not_ready'
    return undefined
  }
  if (name === 'VENUE_REJECTED') {
    if (message.startsWith('INTERRUPTED_BEFORE_VENUE')) return 'interrupted'
    if (m.includes('kernel-sim: order unknown')) return 'order_unknown'
    return undefined
  }
  if (name === 'INVALID_PARAMS') {
    if (m.includes('invalid workspace path')) return 'workspace_path'
    if (m.includes('pin must be')) return 'pin_format'
    if (m.includes('reason')) return 'reason'
    return undefined
  }
  return undefined
}

/** 问题 → 中文文案；先查 `name:子码`，再查 `name`，都没有就明确透传码名。 */
export function humanizeProblem(p: ProblemLike, o: { surface?: ProblemSurface } = {}): HumanText {
  const surface = o.surface ?? 'ui'
  const message = p.message ?? ''
  const sub = subcodeOf(p.name, message)
  const subEntry = sub === undefined ? undefined : PROBLEM_TEXT[`${p.name}:${sub}`]
  const entry = subEntry ?? PROBLEM_TEXT[p.name]
  const text: HumanText = entry ? { ...entry } : { zh: '出错了（' + p.name + '）' }
  if (p.name === 'AUTH_FAILED' && sub === 'locked' && typeof p.retryAfterMs === 'number' && p.retryAfterMs > 0) {
    text.zh = `PIN 试错次数过多，请 ${Math.ceil(p.retryAfterMs / 1000)} 秒后再试`
  }
  if (p.name === 'RATE_BUDGET' && sub === 'op_rate' && typeof p.retryAfterMs === 'number' && p.retryAfterMs > 0) {
    text.next = `约 ${Math.ceil(p.retryAfterMs / 1000)} 秒后再试；批量调用请放慢`
  }
  if (p.name === 'VENUE_UNAVAILABLE' && sub === 'not_ready' && typeof p.retryAfterMs === 'number' && p.retryAfterMs > 0) {
    text.zh = `行情尚未就绪（标的列表还在加载），${Math.ceil(p.retryAfterMs / 1000)} 秒后重试`
  }
  if (surface === 'agent') text.next = '原文：' + message
  return text
}

/** 规则命中 → 一句人话；未知规则码也给出中文兜底。 */
export function humanizeRuleHit(h: { code: string; action?: string; ruleId?: string; limit?: string; actual?: string; unit?: string }): string {
  const fn = RULE_TEXT[h.code]
  if (fn) return fn(h)
  return '规则未通过（' + h.code + '）'
}
