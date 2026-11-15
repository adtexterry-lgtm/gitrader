// SPDX-License-Identifier: CPAL-1.0
// 研究作业转给引擎：x-gitrader.research.* 是引擎的扩展方法（能力位 RESEARCH_CAPABILITY）。
// 请求一律走 GepHost.callEngine（方法白名单 CALLABLE 是安全边界，这里不绕）；引擎由 GepHost.readyEngineIds 按能力位挑。
import { RESEARCH_CAPABILITY, makeProblem } from '../proto'
import type { Kernel } from '../kernel'
import { KernelError } from '../util/errors'

/** 第一个握手完成且声明了研究能力的引擎。 */
function researchEngineId(k: Kernel): string {
  const id = k.gep.readyEngineIds(RESEARCH_CAPABILITY)[0]
  if (id) return id
  throw new KernelError(k.gep.readyEngineIds().length
    ? makeProblem('CAPABILITY_UNSUPPORTED', `no connected engine declares ${RESEARCH_CAPABILITY} (the bundled gitrader-core engine does; check gitrader engines list)`)
    : makeProblem('VENUE_UNAVAILABLE', 'no engine is connected (gitrader engines bind / check engines.list)'))
}

export function callResearchEngine(k: Kernel, method: string, params: Record<string, unknown>): Promise<unknown> {
  return k.gep.callEngine(researchEngineId(k), method, params)
}
