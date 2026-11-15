// SPDX-License-Identifier: CPAL-1.0
// 界面用词（只用五个词 + Agent 权限四档）与协议枚举的对应。
// 常量取自 @gitrader/protocol/constants（protocol v0.1.6 的浏览器安全子路径，不带 ajv）；界面中文用词留在本文件。类型走 /types。
import { AGENT_PERMISSION_TIERS } from '@gitrader/protocol/constants'
import type { AgentPermissionTier, MandateLevel, RuleCode, TakeoverLevel, TradingState } from '@gitrader/protocol/types'
import { t } from '@gitrader/workbench/i18n'

export const TIER_ORDER: readonly AgentPermissionTier[] = AGENT_PERMISSION_TIERS
export const TIER_LABEL: Record<AgentPermissionTier, string> = { read_only: t('只读'), paper: t('纸面'), confirm: t('需确认'), auto_limited: t('限额自动') }
/** 界面选一档落到哪一级（限额自动默认 L3；放量 L4 只能经晋级）。 */
export const LEVEL_OF_TIER: Record<AgentPermissionTier, MandateLevel> = { read_only: 'L0', paper: 'L1', confirm: 'L2', auto_limited: 'L3' }
export const TIER_OF_LEVEL: Record<MandateLevel, AgentPermissionTier> = { L0: 'read_only', L1: 'paper', L2: 'confirm', L3: 'auto_limited', L4: 'auto_limited' }

export const STATE_LABEL: Record<TradingState, string> = { ACTIVE: t('正常交易'), REDUCING: t('只减仓'), HALTED: t('已停止') }

/** 接管三档（IXD G2 / G8：按钮、确认动词、进行时文案同名）。 */
export const TAKEOVER_LEVELS: ReadonlyArray<{ level: TakeoverLevel; label: string; icon: string; confirm: string; busy: string }> = [
  { level: 'halt_new', label: t('停止新开仓'), icon: 'stop', confirm: t('确认停止'), busy: t('停止中…') },
  { level: 'cancel_all', label: t('撤销挂单'), icon: 'close', confirm: t('确认撤单'), busy: t('撤单中…') },
  { level: 'flatten_all', label: t('全部平仓'), icon: 'eject', confirm: t('确认平仓'), busy: t('平仓中…') },
]
/** 接管成功的回声（内核 TakeoverRecord.ok = true 才用；没平完不出成功提示，见 model-risk takeoverOutcome）。 */
export const TAKEOVER_DONE: Record<TakeoverLevel, string> = { halt_new: t('已停止新开仓'), cancel_all: t('已撤销挂单'), flatten_all: t('已全部平仓 · 交易已停止') }

/** 风控规则名（RuleHit.code → 中文）。 */
export const RULE_LABEL: Record<RuleCode, string> = {
  LEVERAGE: t('杠杆'), ORDER_NOTIONAL: t('单笔上限'), POSITION_NOTIONAL: t('单标的敞口'), TOTAL_NOTIONAL: t('总敞口'), OPEN_POSITIONS: t('持仓个数'),
  DAILY_LOSS: t('日亏上限'), COOLDOWN: t('冷却'), INSUFFICIENT_MARGIN: t('保证金不足'), REDUCE_ONLY: t('只减仓'), INSTRUMENT_NOT_ALLOWED: t('标的不在白名单'),
  TRADING_STATE: t('交易状态'), DAILY_NOTIONAL: t('日成交额'), VENUE_NOT_ALLOWED: t('场所不在白名单'), SLIPPAGE: t('滑点'), STALE_PRICE: t('行情陈旧'),
  RATE_BUDGET: t('速率预算'), MANDATE_LEVEL: t('Agent 权限档位'), MANDATE_EXPIRED: t('Agent 权限已过期'), MANDATE_LIMIT: t('Agent 额度'),
  NEEDS_APPROVAL: t('需人批准'), PROTECTOR: t('保护器'), LLM_LIVE_ENTRY: t('大模型实盘开仓保护'),
  KILL_SWITCH: t('断电器'), ACCOUNT_UNKNOWN: t('账户状态未知'), PROTECTOR_UNAVAILABLE: t('保护器不可用'), VENUE_RULE: t('场所规则'), MANDATE_INCOMPLETE: t('授权书不完整'),
  INTENT_EXPIRED: t('意图期限不足'), REDUCE_ONLY_MISMATCH: t('减仓条件不符'), SIZE_PRECISION: t('数量精度'),
  TPSL_INVALID: t('止损止盈价位不合规'), STOP_REQUIRED: t('开仓必须带止损'),
}

export const PROTECTOR_LABEL: Record<string, string> = {
  cooldown: t('冷却'), stoploss_guard: t('止损保护'), drawdown_pause: t('回撤暂停'), low_profit_lock: t('低收益锁定'), max_consecutive_failures: t('连续失败暂停'), plugin: t('插件保护器'),
}

export const CONTROL_LABEL: Record<string, string> = { start_strategy: t('启动策略'), run_workflow: t('运行工作流'), request_promotion: t('申请调整权限'), install_plugin: t('安装插件') }

export const VENUE_NAME: Record<string, string> = {
  kraken: 'Kraken', kucoin: 'KuCoin', dydx: 'dYdX', deribit: 'Deribit',
  hyperliquid: 'Hyperliquid', 'kernel-sim': t('模拟场所'), binance: 'Binance', okx: 'OKX', bybit: 'Bybit', bitget: 'Bitget', gateio: 'Gate.io',
}
