// SPDX-License-Identifier: Apache-2.0
// 测试辅助：加载夹具。契约示例里的占位符（<64hex> / <40hex> / <base64>）在加载时替换成合法值；
// v0.1.2 起 Origin.actorType 必填，契约 v0.1.1 的示例没有它，加载时按 actor 前缀补齐（语义同内核盖章）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveOriginActorType } from '../src/model/origin'
import type { Actor } from '../src/model/ids'

const here = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = join(here, '..')

export const HEX64 = 'a'.repeat(64)
export function fillPlaceholders(text: string): string {
  return text.replaceAll('<64hex>', HEX64).replaceAll('<40hex>', 'b'.repeat(40)).replaceAll('<base64>', 'c2lnbmF0dXJl')
}

export function stampOrigins<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stampOrigins) as T
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(o)) out[k] = stampOrigins(v)
    if (typeof out['actor'] === 'string' && typeof out['requestId'] === 'string' && typeof out['via'] === 'string' && out['actorType'] === undefined) {
      out['actorType'] = deriveOriginActorType(out['actor'] as Actor)
    }
    return out as T
  }
  return value
}

export function contract(name: string): any {
  return stampOrigins(JSON.parse(fillPlaceholders(readFileSync(join(here, 'fixtures', 'contract', `${name}.json`), 'utf8'))))
}

const samples = JSON.parse(fillPlaceholders(readFileSync(join(here, 'fixtures', 'handwritten', 'samples.json'), 'utf8'))) as Record<string, unknown>
export function sample(name: string): any {
  const v = samples[name]
  if (v === undefined) throw new Error(`no sample ${name}`)
  return stampOrigins(structuredClone(v))
}

export function clone<T>(v: T): T {
  return structuredClone(v)
}
