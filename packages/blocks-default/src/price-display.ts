// SPDX-License-Identifier: CPAL-1.0
import type { InstrumentPriceRule } from '@gitrader/protocol/types'
import { useRes } from './hooks'
import { formatPrice, formatPriceCopy } from './display'
import { isRec, listOf } from './util'

/** One catalogue query per owning view, shared by its rows. */
export function usePriceDisplay() {
  const query = useRes<unknown>('market.instruments', { limit: 1000 })
  const rules = new Map<string, InstrumentPriceRule>()
  for (const item of listOf(query.data, 'instruments')) {
    if (isRec(item) && typeof item.instrumentId === 'string' && isRec(item.price)) rules.set(item.instrumentId, item.price as InstrumentPriceRule)
  }
  return {
    /** 标的的价格规则；取不到（目录没到 / 没有这个标的）= undefined，调用方自己决定退回写法。 */
    rule: (id?: string): InstrumentPriceRule | undefined => (id ? rules.get(id) : undefined),
    price: (value: unknown, id?: string) => formatPrice(value, id ? rules.get(id) : undefined),
    copy: (value: string, id?: string) => formatPriceCopy(value, id ? rules.get(id) : undefined),
  }
}
