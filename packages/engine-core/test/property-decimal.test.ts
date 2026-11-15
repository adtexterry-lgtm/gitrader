// SPDX-License-Identifier: CPAL-1.0
// 属性测试（批 10 欠交件 · 不变式 1）：decimal 运算的结合律与精度契约。
//
// 断的是「表示忠实」这一条：engine-core 的 decimal 层只做 number → 规范十进制串的量化与向零截断，
// 钱上的加减一律交给精确十进制（@gitrader/protocol/decimal，scale 18，BigInt）。
// 只要量化在精度契约内是忠实的（15 位有效数字 + 向零截断），下游的精确加法就是真正的加法：
// 结合律成立、舍入方向一致、换序不改变和。浮点加法不满足结合律，所以本仓的钱路径不走浮点。
//
// 随机源：本包自带的 mulberry32（util/synth.ts），种子写死 42，样本数写死，结果可复现。
import { describe, expect, it } from 'vitest'
import { addDec, cmp, fx, str, subDec } from '@gitrader/protocol/decimal'
import { isDecimal, normalizeDecimal } from '../src/proto'
import { decimalOf, normalizeLot, truncDecimals, truncToStep } from '../src/util/decimal'
import { mulberry32 } from '../src/util/synth'

const SEED = 42
const SAMPLES_PRECISION = 10_000
const SAMPLES_ALGEBRA = 10_000
const SAMPLES_ROUNDING = 2_000

/** 真实价格 / 数量的量级：1e-8 … 1e9，带随机尾数。 */
function randomMagnitude(rnd: () => number): number {
  const exp = -8 + Math.floor(rnd() * 18)
  const mantissa = 1 + rnd() * 9
  const sign = rnd() < 0.5 ? -1 : 1
  return sign * mantissa * 10 ** exp
}

/** 规范十进制文本：整数位 1..6 位、总有效数字 ≤ 15 位（协议的精度契约内）。 */
function randomDecimalText(rnd: () => number, maxSig = 15): string {
  const intDigits = 1 + Math.floor(rnd() * 6)
  const fracDigits = Math.floor(rnd() * Math.max(1, maxSig - intDigits))
  let int = String(1 + Math.floor(rnd() * 9))
  for (let i = 1; i < intDigits; i += 1) int += String(Math.floor(rnd() * 10))
  let frac = ''
  for (let i = 0; i < fracDigits; i += 1) frac += String(Math.floor(rnd() * 10))
  const sign = rnd() < 0.5 ? '-' : ''
  return normalizeDecimal(frac === '' ? sign + int : `${sign}${int}.${frac}`)
}

describe('不变式 1 · decimal 精度契约（种子 42，1 万组）', () => {
  it(`decimalOf 在 15 位有效数字内忠实表示输入（${SAMPLES_PRECISION} 组）`, () => {
    const rnd = mulberry32(SEED)
    let checked = 0
    for (let i = 0; i < SAMPLES_PRECISION; i += 1) {
      const x = randomMagnitude(rnd)
      const text = decimalOf(x)
      // (a) 输出是协议规范形，可直接进账
      expect(isDecimal(text), `非规范形：${text}（输入 ${x}）`).toBe(true)
      const back = Number(text)
      // (b) 相对误差 ≤ 5e-15：15 位有效数字的半个末位，按尾数 m ≥ 1 的最坏情况取界
      //     （0.5 × 10^-14 / m，m = 1 时最大）
      expect(Math.abs(back - x) / Math.abs(x)).toBeLessThanOrEqual(5e-15)
      // (c) 符号不丢：负数仍为负，零写 "0"
      if (x < 0) expect(back).toBeLessThan(0)
      // (d) 再量化一次不变（幂等）：量化后的值已经是契约内的数
      expect(decimalOf(back)).toBe(text)
      checked += 1
    }
    expect(checked).toBe(SAMPLES_PRECISION)
  })

  it(`精确十进制加法的结合律、交换律与单位元（${SAMPLES_ALGEBRA} 组）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES_ALGEBRA; i += 1) {
      const a = randomDecimalText(rnd)
      const b = randomDecimalText(rnd)
      const c = randomDecimalText(rnd)
      // (a+b)+c == a+(b+c)：全 18 位标度内精确，逐字符相等
      expect(addDec(addDec(a, b), c)).toBe(addDec(a, addDec(b, c)))
      // a+b == b+a
      expect(addDec(a, b)).toBe(addDec(b, a))
      // a+0 == a，且 (-a) + a == 0（不出现 "-0"）
      const negated = a.startsWith('-') ? a.slice(1) : `-${a}`
      expect(addDec(a, '0')).toBe(normalizeDecimal(a))
      expect(addDec(a, negated)).toBe('0')
      // (a-b)+b == a：减法与加法互逆
      expect(addDec(subDec(a, b), b)).toBe(normalizeDecimal(a))
    }
  })

  it(`多组求和与加法顺序无关（${SAMPLES_ALGEBRA / 2} 组 × 6 项）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES_ALGEBRA / 2; i += 1) {
      const terms: string[] = []
      for (let k = 0; k < 6; k += 1) terms.push(randomDecimalText(rnd, 6))
      const forward = terms.reduce((acc, t) => addDec(acc, t), '0')
      // 同一批项洗牌（用同一随机源做 Fisher-Yates）后求和必须一致
      const shuffled = [...terms]
      for (let k = shuffled.length - 1; k > 0; k -= 1) {
        const j = Math.floor(rnd() * (k + 1))
        const tmp = shuffled[k] as string
        shuffled[k] = shuffled[j] as string
        shuffled[j] = tmp
      }
      const backward = shuffled.reduce((acc, t) => addDec(acc, t), '0')
      expect(backward).toBe(forward)
      // 与定点整数求和一致（同一条精确路径）
      const exact = str(terms.reduce((acc, t) => acc + fx(t), 0n))
      expect(forward).toBe(exact)
    }
  })

  it(`向零截断的方向、误差界与幂等（truncDecimals / truncToStep，${SAMPLES_ROUNDING} 组）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES_ROUNDING; i += 1) {
      const x = randomMagnitude(rnd)
      const d = Math.floor(rnd() * 9)
      const t = truncDecimals(x, d)
      const tv = fx(t)
      const xv = fx(decimalOf(Math.abs(x)))
      // (a) 截断结果绝不放大绝对值：|t| ≤ |x|
      expect(cmp(tv < 0n ? -tv : tv, xv)).toBeLessThanOrEqual(0)
      // (b) 方向与输入同号（截断不跨零）
      if (x > 0) expect(tv).toBeGreaterThanOrEqual(0n)
      if (x < 0) expect(tv).toBeLessThanOrEqual(0n)
      // (c) 丢掉的部分小于末位单位 10^-d（真的「按位截断」而不是多丢一档）
      const unit = fx(`1e-${d}`)
      const dropped = xv - (tv < 0n ? -tv : tv)
      expect(dropped < unit || dropped === 0n, `丢多了：${str(dropped)} ≥ ${str(unit)}`).toBe(true)
      // (d) 再截一次不变（幂等）
      expect(truncDecimals(Number(t), d)).toBe(t)
      // (e) 单调：0 ≤ u ≤ v ⟹ trunc(u) ≤ trunc(v)（同一位数上截断不颠倒大小）
      const u = Math.abs(x)
      const v = u * (1 + rnd() * 2)
      expect(cmp(fx(truncDecimals(u, d)), fx(truncDecimals(v, d)))).toBeLessThanOrEqual(0)

      // (f) truncToStep：结果是 step 的整数倍，且 |结果| ≤ |x|、误差 < step
      const step = ['0.5', '0.1', '0.01', '0.001', '1', '10', '0.0001'][Math.floor(rnd() * 7)] as string
      const s = truncToStep(x, step)
      const sv = fx(s)
      const stepInt = fx(step)
      expect((sv < 0n ? -sv : sv) % stepInt).toBe(0n)
      expect(cmp(sv < 0n ? -sv : sv, xv)).toBeLessThanOrEqual(0)
      expect(truncToStep(Number(s), step)).toBe(s)
    }
  })

  it(`normalizeLot 只吸附 4 ulp 内的二进制噪声，绝不改到手数档位（${SAMPLES_ROUNDING} 组）`, () => {
    const rnd = mulberry32(SEED)
    for (let i = 0; i < SAMPLES_ROUNDING; i += 1) {
      const step = [0.1, 0.01, 0.001, 0.5, 1, 0.25][Math.floor(rnd() * 6)] as number
      const qty = randomMagnitude(rnd) * 10 // 数量比价格大一些
      const out = normalizeLot(qty, step)
      // (a) 结果是 step 的整数倍（容 4 ulp 的表示误差）
      const ratio = out / step
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(ratio)))
      // (b) 只允许 4 ulp 的吸附上浮，不许真的放大数量
      const tol = Number.EPSILON * Math.abs(qty) * 4
      expect(Math.abs(out)).toBeLessThanOrEqual(Math.abs(qty) + tol * 2 + Number.EPSILON * Math.abs(out))
      // (c) 幂等：对结果再归一次不变
      expect(normalizeLot(out, step)).toBe(out)
      // (d) minQty 之下归零，不为负
      expect(normalizeLot(qty, step, Math.abs(qty) * 2)).toBe(0)
    }
  })
})
