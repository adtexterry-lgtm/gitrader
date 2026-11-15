// SPDX-License-Identifier: CPAL-1.0
// 测试公用件：临时目录、写文件、独立算摘要（不调用被测代码的 sha256Digest，避免自证）。
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MIN = 60_000
export const HOUR = 3_600_000
/** 2024-01-01T00:00:00Z */
export const T0 = Date.UTC(2024, 0, 1)

export function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'data-files-test-'))
}

export function dropTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

export function writeFixture(dir: string, name: string, text: string): string {
  const path = join(dir, name)
  writeFileSync(path, text, 'utf8')
  return path
}

export function digestOf(data: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/** n 根 1 小时 K 线，价格随 i 平移，ohlc 合法。 */
export function csvCandles(count: number): string {
  const lines = ['t,o,h,l,c,v']
  for (let i = 0; i < count; i++) {
    const o = 100 + i
    lines.push(`${T0 + i * HOUR},${o},${o + 10},${o - 10},${o + 5},${10 + i}`)
  }
  return `${lines.join('\n')}\n`
}
