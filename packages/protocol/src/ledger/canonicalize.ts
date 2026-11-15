// SPDX-License-Identifier: Apache-2.0
// RFC 8785 JSON Canonicalization Scheme（JCS）的纯函数实现，用于账本哈希链（契约 §6.3）与插件签名摘要（§3.4）。
//
// 规则（RFC 8785）：
//  - 对象成员按键名的 UTF-16 码元序升序排列；
//  - 数字按 ECMAScript Number.prototype.toString 序列化（JSON.stringify 就是这个格式），-0 写成 0，NaN / ±Infinity 非法；
//  - 字符串按 JSON.stringify 的最小转义（控制字符用小写 \u00xx，不转义非 ASCII）；
//  - 无空白。
// 输入必须是 JSON 数据模型（null / boolean / number / string / 数组 / 纯对象）；undefined、函数、bigint、Symbol 一律抛错，
// 避免"悄悄丢字段"导致两端哈希不一致。

export class CanonicalizeError extends TypeError {}

export function canonicalize(value: unknown): string {
  return ser(value, '$')
}

function ser(v: unknown, path: string): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalizeError(`non-finite number at ${path}`)
      return JSON.stringify(v)
    case 'string':
      return JSON.stringify(v)
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x, i) => ser(x, `${path}[${i}]`)).join(',')}]`
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizeError(`non-plain object at ${path}`)
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj).sort() // 默认排序即 UTF-16 码元序
      return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(obj[k], `${path}.${k}`)}`).join(',')}}`
    }
    default:
      throw new CanonicalizeError(`unsupported ${typeof v} at ${path}`)
  }
}
