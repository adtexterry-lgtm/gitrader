// SPDX-License-Identifier: CPAL-1.0
// pack-deps.mjs 的验收用例：真 packages/cli/package.json 无运行时依赖，所有 @gitrader/* 都在
// devDependencies（从 dependencies 移过去的 17 个 connector 一个不少），伪造的运行时依赖会被标出来。
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkPackDeps } from '../pack-deps.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_PKG = resolve(HERE, '..', '..', '..', 'packages', 'cli', 'package.json')
const pkg = JSON.parse(readFileSync(CLI_PKG, 'utf8'))

// 从 dependencies 移到 devDependencies 的 17 个 connector（包名一字不差）
const MOVED = [
  '@gitrader/connector-alpaca-data',
  '@gitrader/connector-alpaca-trade',
  '@gitrader/connector-binance-data',
  '@gitrader/connector-bitget-data',
  '@gitrader/connector-bybit-data',
  '@gitrader/connector-coinbase-data',
  '@gitrader/connector-deribit-data',
  '@gitrader/connector-dydx-data',
  '@gitrader/connector-gateio-data',
  '@gitrader/connector-kraken-data',
  '@gitrader/connector-kucoin-data',
  '@gitrader/connector-okx-data',
  '@gitrader/connector-binance-trade',
  '@gitrader/connector-okx-trade',
  '@gitrader/connector-bybit-trade',
  '@gitrader/connector-bitget-trade',
  '@gitrader/connector-gateio-trade',
]

const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies']

describe('pack deps', () => {
  it('cli package has no runtime dependencies', () => {
    expect(checkPackDeps(pkg)).toEqual([])
  })

  it('every @gitrader/* workspace package is a devDependency', () => {
    const dev = pkg.devDependencies ?? {}
    const devNames = Object.keys(dev)
    // 运行时字段里一个 @gitrader/* 都不许有
    const runtime = RUNTIME_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {}))
      .filter((name) => name.startsWith('@gitrader/'))
    expect(runtime).toEqual([])
    // 移过去的 17 个 connector 全在 devDependencies
    expect(MOVED).toHaveLength(17)
    const missing = MOVED.filter((name) => !devNames.includes(name))
    expect(missing).toEqual([])
    // 真 package.json 里出现过的每个 @gitrader/* 名字都在 devDependencies
    const gitraderNames = new Set(MOVED)
    for (const field of [...RUNTIME_FIELDS, 'devDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (name.startsWith('@gitrader/')) gitraderNames.add(name)
      }
    }
    expect(gitraderNames.size).toBeGreaterThanOrEqual(MOVED.length)
    for (const name of gitraderNames) {
      expect(devNames, `${name} 不在 devDependencies`).toContain(name)
    }
  })

  it('flags runtime deps', () => {
    expect(checkPackDeps({ dependencies: { '@gitrader/x': '*' } })).not.toEqual([])
  })
})
