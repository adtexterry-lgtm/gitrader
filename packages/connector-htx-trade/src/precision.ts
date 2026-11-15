// SPDX-License-Identifier: CPAL-1.0
// HTX 合约精度（USDT 本位永续按**张**下单，不是币数量）：
//   · swap_contract_info 的 `contract_size` —— 一张合约的面值（币）。volume = 币数量 / contract_size，
//     向零截断成整数张（QD live_trading/htx.py:546-556 `_base_to_contracts` 同向：Decimal 除法后 floor 到整数）；
//   · swap_contract_info 的 `price_tick` —— 价格必须是它的整数倍（官方《合约信息》字段）；
//   · 最小下单量：HTX 永续的下限是 1 张（官方规格页），本包按 `volume >= 1` 判，不做「小于 1 张也发」的猜测。
// 价格与数量一律定点（bigint Fx），不经 JS 浮点。
import { fx, str } from '@gitrader/protocol/decimal'
import type { Fx } from '@gitrader/protocol/decimal'
import type { Decimal } from '@gitrader/protocol'

/** 解析成正的定点数；非法 / 非正返回 undefined。 */
export function toFx(value: string | number | undefined | null): Fx | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'number' ? String(value) : value.trim()
  if (text === '') return undefined
  try {
    const x = fx(text)
    return x > 0n ? x : undefined
  } catch {
    return undefined
  }
}

/** tick / step 的小数位数（文档与断言用；规整本身走定点除法）。 */
export function decimalsOf(step: string): number {
  const i = step.indexOf('.')
  return i < 0 ? 0 : step.length - i - 1
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/htx.py:546-556; adapted.
/**
 * 币数量 → 合约张数（整数，向零截断）。contractSize 必须是正数；不足一张返回 0（调用方按 1002 PRECISION 拒单）。
 * 与 QD 的区别：QD 走 Decimal 除法再 floor，本函数走定点整数除法（同一方向、无浮点误差）。
 */
export function baseToContracts(qtyBase: string | number, contractSize: string | number): number {
  const qty = toFx(qtyBase)
  const size = toFx(contractSize)
  if (qty === undefined || size === undefined) return 0
  const contracts = qty / size
  return contracts > 0n ? Number(contracts) : 0
}

/** 合约张数 → 币数量（字符串，定点）。 */
export function contractsToBase(volume: number, contractSize: string | number): Decimal {
  const size = toFx(contractSize)
  if (size === undefined || !Number.isInteger(volume) || volume <= 0) return str(0n) as Decimal
  return str(BigInt(volume) * size) as Decimal
}

/** value 是否正好是 step 的整数倍。 */
export function isMultipleOf(value: string, step: string): boolean {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) return false
  return x % s === 0n
}

/** 把价格贴到 tick 上：down = 向小取整，up = 向大取整（卖出被动挂单用 up，买入用 down）。 */
export function snapToTick(price: string, tick: string, dir: 'down' | 'up'): Decimal {
  const p = toFx(price)
  const t = toFx(tick)
  if (p === undefined || t === undefined) throw new RangeError(`snapToTick needs positive values (price=${price}, tick=${tick})`)
  const down = (p / t) * t
  if (dir === 'down') return str(down) as Decimal
  return str(down === p ? p : down + t) as Decimal
}

/** 向零截断到 step 的整数倍（价格规整的正数路径用）。 */
export function truncateToStep(value: string, step: string): Decimal {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) throw new RangeError(`truncateToStep needs positive values (value=${value}, step=${step})`)
  return str((x / s) * s) as Decimal
}
