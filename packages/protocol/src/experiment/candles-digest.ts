// SPDX-License-Identifier: Apache-2.0
import type { Candle } from '../model/instrument'
import type { Sha256Digest } from '../model/ids'
import { CANDLES_DIGEST_METHOD } from '../model/experiment'
import { canonicalize } from '../ledger/canonicalize'

export async function candlesDigest(candles: readonly Candle[]): Promise<Sha256Digest> {
  if (!Array.isArray(candles)) throw new TypeError('candles')
  const rows: [number, number, number, number, number, number][] = candles.map((candle, index) => {
    const path = `candles[${index}]`
    if (candle === null || typeof candle !== 'object' || Array.isArray(candle)) throw new TypeError(path)
    const { t, o, h, l, c, v } = candle
    if (typeof t !== 'number' || typeof o !== 'number' || typeof h !== 'number' || typeof l !== 'number' || typeof c !== 'number' || typeof v !== 'number') throw new TypeError(path)
    if (!Number.isSafeInteger(t) || t < 0) throw new RangeError(`${path}.t`)
    if (![o, h, l, c, v].every(Number.isFinite)) throw new RangeError(path)
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0 || l > Math.min(o, c) || Math.max(o, c) > h) throw new RangeError(path)
    return [t, o, h, l, c, v]
  })
  rows.sort((a, b) => a[0] - b[0])
  for (let index = 1; index < rows.length; index++) {
    const previousRow = rows[index - 1]
    const currentRow = rows[index]
    if (previousRow === undefined || currentRow === undefined) throw new RangeError('candles.t')
    if (previousRow[0] === currentRow[0]) throw new RangeError('candles.t')
  }
  const cryptoApi = globalThis.crypto?.subtle
  if (!cryptoApi) throw new Error('candles.digest')
  try {
    const bytes = new TextEncoder().encode(`${CANDLES_DIGEST_METHOD}\n${canonicalize(rows)}`)
    const hash = await cryptoApi.digest('SHA-256', bytes)
    return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}` as Sha256Digest
  } catch {
    throw new Error('candles.digest')
  }
}
