// SPDX-License-Identifier: CPAL-1.0
// Gate.io 价格 / 数量规整（契约 §1.3）。Gate USDT 永续的精度来自合约元数据：
//   · 价格：`order_price_round`（最小变动单位，如 "0.1"）→ tick；价格在体里是 **定点十进制字符串**（QD gate.py:32-38
//     `_gate_decimal_text`，绝不允许科学计数法）；
//   · 数量：Gate 的 `size` 是**张数**，不是币数；一张 = `quanto_multiplier` 币。份额化下单要带
//     `X-Gate-Size-Decimal: 1` 头，且精度必须与 `order_size_min` 的小数位对齐（QD gate.py:730-782）；
//   · 数量一律「向零截断」到精度步长（与 QD `floor_decimal_to_step` 同向）；
//   · 价格按 rounding 决定向下 / 向上贴 tick，永不朝成交方向放宽（passive：买单向下、卖单向上）。
// 全部走 @gitrader/protocol 的定点十进制（fx / str / floorToStep），不做 JS 浮点加减。
import { floorToStep, fx, str } from '@gitrader/protocol/decimal'
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

/** step / tick 的小数位数（文档与断言用；规整本身走定点除法）。 */
export function decimalsOf(step: string): number {
  const i = step.indexOf('.')
  return i < 0 ? 0 : step.length - i - 1
}

// Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/utils/numeric_precision.py:1-40; adapted.
/** 向零截断到 step 的整数倍（正数即 floor）。 */
export function truncateToStep(value: string, step: string): Decimal {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) throw new RangeError(`truncateToStep needs positive values (value=${value}, step=${step})`)
  return floorToStep(str(x), str(s))
}

/** value 是否正好是 step 的整数倍。 */
export function isMultipleOf(value: string, step: string): boolean {
  const x = toFx(value)
  const s = toFx(step)
  if (x === undefined || s === undefined) return false
  return x % s === 0n
}

/** 把价格贴到 tick 上：down = 向小取整，up = 向大取整（正好整除时不动）。 */
export function snapToTick(price: string, tick: string, dir: 'down' | 'up'): Decimal {
  const p = toFx(price)
  const t = toFx(tick)
  if (p === undefined || t === undefined) throw new RangeError(`snapToTick needs positive values (price=${price}, tick=${tick})`)
  const down = (p / t) * t
  if (dir === 'down') return str(down) as Decimal
  return str(down === p ? p : down + t) as Decimal
}

/** 定点数 × bps/10000（滑点带用）。 */
export function applyBps(price: string, bps: number, dir: 'up' | 'down'): Decimal {
  const p = fx(price)
  const delta = (p * BigInt(Math.abs(Math.trunc(bps)))) / 10_000n
  return str(dir === 'up' ? p + delta : p - delta) as Decimal
}

/**
 * Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/live_trading/gate.py:730-782; adapted.
 * 币数量 → 有符号张数（Gate 的 `size` 字段），并给出是否需要 `X-Gate-Size-Decimal`。
 *   · contracts = baseQty / quanto_multiplier；
 *   · `order_size_min` 有小数位（如 "0.1"）→ 该合约支持份额化：按该精度截断，返回带小数的字符串 + 头；
 *   · 没有小数位 → 整数张，向下取整，不带头；
 *   · 结果 < order_size_min 时返回 '0'（调用方据此拒单，绝不发 0 张给场所）。
 * 有符号口径与 QD 一致：卖为负、买为正（Gate 用 size 的符号表示方向）。
 */
export function signedContracts(
  baseQty: string,
  side: 'buy' | 'sell',
  meta: { contractSize: string; orderSizeMin: string },
): { size: string; decimalHeader: boolean } {
  const qm = toFx(meta.contractSize)
  const req = toFx(baseQty)
  if (req === undefined) return { size: '0', decimalHeader: false }
  if (qm === undefined) throw new RangeError('quanto_multiplier is unavailable for this contract')
  const ONE = 10n ** 18n
  // 定点口径：contracts 与 orderSizeMin 都以 1e-18 为单位，比较与截断都在整数域做。
  const contractsFx = (req * ONE) / qm
  const orderMinFx = toFx(meta.orderSizeMin) ?? ONE
  const dp = decimalsOf(meta.orderSizeMin)
  const negative = side === 'sell'
  if (dp > 0) {
    const stepFx = 10n ** BigInt(18 - dp)
    const q = (contractsFx / stepFx) * stepFx
    if (q < orderMinFx) return { size: '0', decimalHeader: true }
    const text = trimZeros(str(q))
    return { size: negative ? `-${text}` : text, decimalHeader: true }
  }
  const iv = contractsFx / ONE
  const intMin = orderMinFx / ONE > 1n ? orderMinFx / ONE : 1n
  if (iv < intMin) return { size: '0', decimalHeader: false }
  return { size: String(negative ? -iv : iv), decimalHeader: false }
}

/** 有符号张数 → 币数量（持仓 / 成交方向由符号给出）。 */
export function contractsToBase(contractsSigned: string, contractSize: string): Decimal {
  const c = fx(contractsSigned)
  const qm = toFx(contractSize)
  if (qm === undefined) throw new RangeError('quanto_multiplier is unavailable for this contract')
  return str((c * qm) / 10n ** 18n) as Decimal
}

/** 去掉小数尾随 0 与孤立小数点（Gate 接受 "0.1"，不接受 "0.10" 之外的怪形；QD 同口径）。 */
export function trimZeros(text: string): string {
  if (!text.includes('.')) return text
  const out = text.replace(/0+$/, '').replace(/\.$/, '')
  return out === '' || out === '-' ? '0' : out
}

/** 十进制文本 → 定点整数（不限正负）；非法返回 undefined。 */
export function fxOf(value: string | number | undefined | null): Fx | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'number' ? String(value) : value.trim()
  if (text === '') return undefined
  try {
    return fx(text)
  } catch {
    return undefined
  }
}
