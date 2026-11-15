// SPDX-License-Identifier: Apache-2.0
// 仓位计算：qty = equity × riskPct ÷ 100 ÷ |entry − stop|，8 位小数向下取整。纯本地计算，不读任何数据。
import { pathToFileURL } from 'node:url'
import { absDiff, format, mulDiv, parse } from './decimal.mjs'
import { InvalidParams, serve } from './gsp.mjs'

export function positionSize({ equity, riskPct, entry, stop }) {
  const gap = absDiff(parse(entry), parse(stop))
  if (gap === 0n) throw new InvalidParams('entry and stop must differ')
  return { qty: format(mulDiv(parse(equity), parse(riskPct), 100n * gap)) }
}

// 被测试 import 时不起循环：只有作为插件进程入口（node index.mjs）才 serve
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve({ tools: { position_size: async (args) => positionSize(args) } })
