// SPDX-License-Identifier: CPAL-1.0
// 独立的 protobuf 线格式读取器（测试专用）：故意不复用 src/proto.ts 的 readFields，
// 只用 DataView + 手写 varint 循环，按官方 proto 的字段表逐字段断言。
// 目的（IBKR 教训）：假节点 / 断言的解码器不能和编码器共用一份实现，否则循环自证。
export interface RawField {
  field: number
  wire: number
  num?: bigint
  data?: Uint8Array
  text?: string
}

export function walk(buf: Uint8Array): RawField[] {
  const out: RawField[] = []
  let i = 0
  const varint = (): bigint => {
    let r = 0n
    let s = 0n
    for (;;) {
      if (i >= buf.length) throw new Error('tlv: truncated varint')
      const b = buf[i++]!
      r += BigInt(b & 0x7f) << s
      if (b < 0x80) return r
      s += 7n
    }
  }
  while (i < buf.length) {
    const key = Number(varint())
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      out.push({ field, wire, num: varint() })
    } else if (wire === 2) {
      const len = Number(varint())
      if (i + len > buf.length) throw new Error('tlv: truncated bytes')
      const data = buf.slice(i, i + len)
      i += len
      out.push({ field, wire, data, text: ascii(data) })
    } else if (wire === 5) {
      const dv = new DataView(buf.buffer, buf.byteOffset + i, 4)
      out.push({ field, wire, num: BigInt(dv.getUint32(0, true)) })
      i += 4
    } else if (wire === 1) {
      const dv = new DataView(buf.buffer, buf.byteOffset + i, 8)
      out.push({ field, wire, num: dv.getBigUint64(0, true) })
      i += 8
    } else {
      throw new Error(`tlv: unsupported wire type ${wire}`)
    }
  }
  return out
}

export function one(fields: readonly RawField[], field: number): RawField {
  const hit = fields.find((f) => f.field === field)
  if (hit === undefined) throw new Error(`tlv: field ${field} missing`)
  return hit
}

export function maybe(fields: readonly RawField[], field: number): RawField | undefined {
  return fields.find((f) => f.field === field)
}

export function ascii(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return s
}

export function hex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}
