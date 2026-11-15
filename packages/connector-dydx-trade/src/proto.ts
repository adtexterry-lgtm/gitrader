// SPDX-License-Identifier: CPAL-1.0
// 最小 protobuf 编解码（proto3 wire format：varint / length-delimited / fixed32 / fixed64）。
// 只实现 dYdX 交易用到的四个 wire type，不生成代码、不依赖 protobufjs：
//   字段编号与类型以官方 proto 为准（dydxprotocol/clob/{order,tx}.proto、subaccounts/subaccount.proto、
//   cosmos/tx/v1beta1/tx.proto），每个消息的字段表写在 src/msgs.ts 与 src/tx.ts 的注释里。
// 设计参照（只借「proto3 省略零值 / oneof 只写一个分支 / uint64 用 varint」这些语义，代码从零写）：
//   nautilus_trader crates/adapters/dydx/src/execution/order_builder.rs@55c0e820。

export const WIRE_VARINT = 0
export const WIRE_FIXED64 = 1
export const WIRE_BYTES = 2
export const WIRE_FIXED32 = 5

/** protobuf 写入器：按调用顺序追加字段（字段号递增调用可得到规范字节序）。 */
export class ProtoWriter {
  readonly #parts: Uint8Array[] = []

  /** varint 字段；值为 0 时不写（proto3 默认省略）。 */
  uint64(field: number, value: number | bigint): this {
    const v = BigInt(value)
    if (v < 0n) throw new RangeError(`uint64 field ${field} must not be negative`)
    if (v === 0n) return this
    return this.#varintField(field, v)
  }

  /** 即使为 0 也写（调用方明确要显式零值时用，例如 client_metadata=0 需要保留时）。 */
  uint64Always(field: number, value: number | bigint): this {
    const v = BigInt(value)
    if (v < 0n) throw new RangeError(`uint64 field ${field} must not be negative`)
    return this.#varintField(field, v)
  }

  /** 枚举 / bool（0 / false 省略）。 */
  enum(field: number, value: number): this {
    return this.uint64(field, value)
  }

  bool(field: number, value: boolean): this {
    return value ? this.#varintField(field, 1n) : this
  }

  /** string 字段；空串省略。 */
  string(field: number, value: string): this {
    if (value.length === 0) return this
    return this.bytes(field, new TextEncoder().encode(value))
  }

  /** length-delimited 字段；空 Uint8Array 也会写（调用方需要「存在但为空」的子消息时用它）。 */
  bytes(field: number, value: Uint8Array): this {
    this.#parts.push(varint(BigInt((field << 3) | WIRE_BYTES)))
    this.#parts.push(varint(BigInt(value.length)))
    this.#parts.push(value)
    return this
  }

  /** 子消息：总是写（proto3 里 message 字段为空消息时序列化为 tag + 长度 0）。 */
  message(field: number, sub: ProtoWriter): this {
    return this.bytes(field, sub.finish())
  }

  /** fixed32（小端）。 */
  fixed32(field: number, value: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, value >>> 0, true)
    this.#parts.push(varint(BigInt((field << 3) | WIRE_FIXED32)))
    this.#parts.push(b)
    return this
  }

  #varintField(field: number, value: bigint): this {
    this.#parts.push(varint(BigInt(field << 3)))
    this.#parts.push(varint(value))
    return this
  }

  finish(): Uint8Array {
    return concatBytes(this.#parts)
  }

  get length(): number {
    return this.#parts.reduce((s, p) => s + p.length, 0)
  }
}

export interface ProtoField {
  field: number
  wire: number
  /** varint / fixed32 / fixed64 的数值。 */
  value?: bigint
  /** length-delimited 的原始字节。 */
  bytes?: Uint8Array
  /** length-delimited 的 UTF-8 文本（读的时候顺带给出）。 */
  text?: string
}

/** 解码器：只做一层 TLV 拆分，子消息由调用方递归。遇到未知字段原样保留（前向兼容）。 */
export function readFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = []
  let off = 0
  while (off < buf.length) {
    const tag = readVarint(buf, off)
    off = tag.offset
    const key = Number(tag.value)
    const field = key >>> 3
    const wire = key & 7
    if (field === 0) throw new Error('protobuf field number 0 is invalid')
    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, off)
      off = v.offset
      out.push({ field, wire, value: v.value })
    } else if (wire === WIRE_BYTES) {
      const len = readVarint(buf, off)
      off = len.offset
      const end = off + Number(len.value)
      if (end > buf.length) throw new Error('truncated length-delimited field')
      const slice = buf.subarray(off, end)
      out.push({ field, wire, bytes: slice, text: tryUtf8(slice) })
      off = end
    } else if (wire === WIRE_FIXED32) {
      if (off + 4 > buf.length) throw new Error('truncated fixed32 field')
      const v = new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, true)
      out.push({ field, wire, value: BigInt(v) })
      off += 4
    } else if (wire === WIRE_FIXED64) {
      if (off + 8 > buf.length) throw new Error('truncated fixed64 field')
      const v = new DataView(buf.buffer, buf.byteOffset + off, 8).getBigUint64(0, true)
      out.push({ field, wire, value: v })
      off += 8
    } else {
      throw new Error(`unsupported protobuf wire type ${wire} for field ${field}`)
    }
  }
  return out
}

/** 取某字段的全部出现（repeated 字段）。 */
export function fieldsOf(fields: readonly ProtoField[], field: number): ProtoField[] {
  return fields.filter((f) => f.field === field)
}

/** 取某字段的第一个出现。 */
export function firstField(fields: readonly ProtoField[], field: number): ProtoField | undefined {
  return fields.find((f) => f.field === field)
}

export function readVarint(buf: Uint8Array, offset: number): { value: bigint; offset: number } {
  let result = 0n
  let shift = 0n
  let off = offset
  for (;;) {
    if (off >= buf.length) throw new Error('truncated varint')
    const b = buf[off]!
    off += 1
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
    if (shift > 63n) throw new Error('varint exceeds 64 bits')
  }
  return { value: result, offset: off }
}

export function varint(value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError('varint must not be negative')
  const out: number[] = []
  let v = value
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
  return new Uint8Array(out)
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64')
}

export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

function tryUtf8(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return ''
  }
}
