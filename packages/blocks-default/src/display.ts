// SPDX-License-Identifier: CPAL-1.0
import type { InstrumentPriceRule } from '@gitrader/protocol/types'
import { t } from '@gitrader/workbench/i18n'

/** Display only: truncate decimal digits; never use this text to submit an order. */
export function formatPrice(value: unknown, rule?: InstrumentPriceRule): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const raw = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? value : n.toFixed(12)
  const [integer = '0', fraction = ''] = raw.split('.')
  const tick = typeof rule?.tick === 'string' ? rule.tick.replace(/0+$/, '') : undefined
  let digits = tick ? (tick.split('.')[1]?.length ?? 0) : rule?.maxDecimals
  if (digits === undefined) digits = Math.abs(n) >= 1 ? 2 : 5
  if (rule?.sigFigs && n !== 0 && fraction && /[1-9]/.test(fraction)) {
    digits = Math.min(digits, Math.max(0, rule.sigFigs - 1 - Math.floor(Math.log10(Math.abs(n)))))
  }
  digits = Math.max(0, Math.min(12, Math.floor(digits)))
  const part = fraction.slice(0, digits).replace(/0+$/, '')
  const whole = integer.replace(/^(-?)0+(?=\d)/, '$1').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${whole}${part ? `.${part}` : ''}`
}

/** Format prices in generated activity/chain copy; quantities and upstream evidence stay intact. */
export function formatPriceCopy(text: string, rule?: InstrumentPriceRule): string {
  return text.replace(/(@\s*|开仓价\s*|(?:挂|改)?止损\s+|止盈\s+)(-?\d[\d,]*(?:\.\d+)?)/g,
    (_all, prefix: string, value: string) => prefix + formatPrice(value.replace(/,/g, ''), rule))
}

export function accountLabel(id: string, alias?: string | null): string {
  return alias?.trim() && alias !== id ? alias.trim() : id.slice(-6)
}

export function visibleResult(what: string, result?: { label: string; tone: string }): typeof result {
  return result && !what.includes(result.label) ? result : undefined
}

export const approvalRule = (text: string): boolean => /需人批准|需要.{0,3}确认|待批/.test(text)

export const TERM_HELP: Record<string, string> = {
  bp: t('1 bp 等于 0.01%，用于表示费率或价格偏离。'),
  总敞口: t('全部持仓的名义金额合计，相对于账户权益衡量。'),
  保护器: t('按确定性规则监控风险并限制交易的组件。'),
  冷却: t('触发规则后，在设定时段内暂停新的开仓。'),
  接管: t('由你直接停止新开仓、撤销挂单或全部平仓。'),
  L0: t('L0 只允许读取信息，不能提出或执行交易。'),
  L1: t('L1 允许在纸面账户中交易。'),
  L2: t('L2 交易提案需要你逐次批准。'),
}
