// SPDX-License-Identifier: CPAL-1.0
export const DEFAULT_ENGINE_ID = 'gitrader-core'

export type EngineChoice = { ok: true; engineId: string } | { ok: false; message: string }

/** 显式 id 优先；否则：随包 gitrader-core 在线就用它；它不在线而恰有一个别的引擎在线就用那个；多个在线却没有默认就报错，不替人猜。 */
export function pickDefaultEngine(statuses: { engineId: string; state: string }[]): EngineChoice {
  const ready = statuses.filter((s) => s.state === 'ready').map((s) => s.engineId)
  if (ready.includes(DEFAULT_ENGINE_ID)) return { ok: true, engineId: DEFAULT_ENGINE_ID }
  if (ready.length === 1) return { ok: true, engineId: ready[0]! }
  if (ready.length === 0) return { ok: false, message: 'no engine is connected (gitrader engines bind / check engines.list)' }
  return { ok: false, message: `default engine ${DEFAULT_ENGINE_ID} is not ready; ready engines: ${ready.join(', ')}. Pass engineId explicitly` }
}
