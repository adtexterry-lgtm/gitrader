// SPDX-License-Identifier: CPAL-1.0
// IB socket 线协议底层：握手、uint32BE 长度前缀帧、以 '\0' 分隔的字段编解码。
// 参照 ib_async client.py / decoder.py（BSD-2-Clause）的字段序；未复制源码。
// 只支持 API 服务器版本 178（= ib_async 的 MaxClientVersion）。
export const API_VERSION = 178
export const HANDSHAKE_VERSIONS = 'v178..178'
/** 帧上限：一条 openOrder / contractDetails 通常 < 4 KiB；8 MiB 足够且防对端喂垃圾。 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export type WireField = string | number | boolean | null | undefined

function fieldText(value: WireField): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new RangeError('wire field must not contain a NUL character')
    return value
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`wire number must be a safe integer (got ${String(value)}); pass decimals as text`)
  }
  return String(value)
}

/** 握手请求：'API\0' + uint32BE(9) + 'v178..178'（共 17 字节）。 */
export function encodeHandshake(): Buffer {
  const versions = Buffer.from(HANDSHAKE_VERSIONS, 'latin1')
  const head = Buffer.allocUnsafe(8)
  head.write('API\0', 0, 'latin1')
  head.writeUInt32BE(versions.length, 4)
  return Buffer.concat([head, versions])
}

/** 出帧：每个字段转文本后接 '\0'，整段 UTF-8，前面加 uint32BE 长度。 */
export function encodeMessage(fields: readonly WireField[]): Buffer {
  const parts: string[] = []
  for (const field of fields) parts.push(`${fieldText(field)}\0`)
  const payload = Buffer.from(parts.join(''), 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(payload.length, 0)
  return Buffer.concat([head, payload])
}

/** 流式帧读取器：喂入任意切片，吐出完整帧的字段数组。分片 / 粘包都能还原。 */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0)

  constructor(readonly maxFrameBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): string[][] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk])
    const out: string[][] = []
    for (;;) {
      if (this.#buf.length < 4) break
      const len = this.#buf.readUInt32BE(0)
      if (len > this.maxFrameBytes) throw new RangeError(`frame length ${String(len)} exceeds cap ${String(this.maxFrameBytes)}`)
      if (this.#buf.length < 4 + len) break
      const payload = this.#buf.subarray(4, 4 + len)
      this.#buf = this.#buf.subarray(4 + len)
      const text = payload.toString('utf8')
      if (!text.endsWith('\0')) throw new RangeError('frame payload does not end with a NUL separator')
      const fields = text.split('\0')
      fields.pop()
      out.push(fields)
    }
    return out
  }

  get buffered(): number {
    return this.#buf.length
  }
}

/** 握手后服务器的第一条帧是 2 个字段 [serverVersion, connTime]。 */
export function parseHandshakeReply(fields: string[]): { serverVersion: number; connectionTime: string } | undefined {
  if (fields.length !== 2) return undefined
  const versionText = fields[0]!
  const serverVersion = Number(versionText)
  if (versionText.trim() === '' || !Number.isInteger(serverVersion)) return undefined
  return { serverVersion, connectionTime: fields[1]! }
}

/** 版本协商：ok 仅当 serverVersion === 178。 */
export function negotiateVersion(serverVersion: number): { ok: boolean; apiVersion: number; reason?: string } {
  if (serverVersion === API_VERSION) return { ok: true, apiVersion: API_VERSION }
  return {
    ok: false,
    apiVersion: 0,
    reason: `本包只支持 API 服务器版本 ${String(API_VERSION)}（服务器报 ${String(serverVersion)}）`,
  }
}
