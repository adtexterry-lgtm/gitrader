// SPDX-License-Identifier: CPAL-1.0
// 能力声明要老实（教训 9）+ 包卫生（README 首句、许可证、禁词、依赖只有工作区包）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPromiseLanguage } from '@gitrader/protocol'
import { bybitCapabilities, FALLBACK_MIN_NOTIONAL } from '../src/capabilities'
import { SUPPORTED_ORDER_TYPES, SUPPORTED_TIF, SUPPORTED_TRIGGER_TYPES } from '../src/parse'

const root = join(__dirname, '..')
const caps = bybitCapabilities()

describe('VenueCapabilities（只声明真做到的）', () => {
  it('venue / 环境 / 标的类型', () => {
    expect(caps.venue).toBe('bybit')
    expect(caps.environments).toEqual(['mainnet', 'testnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
  })

  it('市价声明 emulated，并写明实现方式是 ioc_limit', () => {
    expect(caps.orderTypes.market).toBe('emulated')
    expect(caps.marketEmulation).toEqual({ method: 'ioc_limit' })
  })

  it('限价与四类触发单都是 native', () => {
    for (const type of ['limit', 'stop_market', 'stop_limit', 'take_market', 'take_limit'] as const) {
      expect(caps.orderTypes[type]).toBe('native')
    }
  })

  it('twap / trailing_stop 声明 none（Bybit 没有建单级追踪单，追踪只能做持仓级）', () => {
    expect(caps.orderTypes.twap).toBe('none')
    expect(caps.orderTypes.trailing_stop).toBe('none')
  })

  it('tpsl 两处都 false：submit 对带 tpsl 的意图回 1004（教训 9）', () => {
    expect(caps.tpsl).toEqual({ attachToOrder: false, positionLevel: false, parentPartialCancel: 'keep_children' })
  })

  it('amend 声明 emulated（只有 Limit 系原生改单），cancelAll 仍是 native', () => {
    expect(caps.amend).toBe('emulated')
    expect(caps.cancelAll).toBe('native')
  })

  it('不声明 deadman（Bybit 没有场所级定时撤单）', () => {
    expect(caps.deadman).toBeUndefined()
  })

  it('持仓模式 / 保证金模式 / 账户模型', () => {
    expect(caps.positionMode).toEqual(['oneWay', 'hedge'])
    expect(caps.marginModes).toEqual(['cross', 'isolated'])
    expect(caps.accountModels).toEqual(['unified'])
  })

  it('signers 是 api-key，且 withdrawCapable = false', () => {
    expect(caps.signers).toMatchObject({ type: 'api-key', withdrawCapable: false, noncePerSigner: false })
  })

  it('rateLimits：600 次 / 5 s 按 IP + 下单 10/1s + 公共行情 IP 120/5s', () => {
    const limits = caps.rateLimits ?? []
    expect(limits[0]).toMatchObject({ scope: 'ip', model: 'weight', limit: 600, windowMs: 5_000 })
    expect(String(limits[0]?.note)).toContain('per IP')
    expect(limits).toContainEqual(expect.objectContaining({ scope: 'uid', model: 'count', limit: 10, windowMs: 1_000 }))
    expect(limits).toContainEqual(expect.objectContaining({ scope: 'ip', model: 'count', limit: 120, windowMs: 5_000 }))
  })

  it('tif / triggerPriceTypes 与实现一致', () => {
    expect(caps.tif).toEqual([...SUPPORTED_TIF])
    expect(caps.triggerPriceTypes).toEqual([...SUPPORTED_TRIGGER_TYPES])
  })

  it('rules.minOrderNotional 缺省 5，可覆盖', () => {
    expect(String(caps.rules?.minOrderNotional)).toBe(FALLBACK_MIN_NOTIONAL)
    expect(String(bybitCapabilities({ minOrderNotional: '10' }).rules?.minOrderNotional)).toBe('10')
  })

  it('clientOrderId 格式 / 历史 K 线 / 扩展键都写了', () => {
    expect(caps.clientOrderId).toEqual({ format: 'bybit-36' })
    expect(caps.history?.maxCandles).toBe(1_000)
    expect(caps['x-orderTypes']).toEqual(SUPPORTED_ORDER_TYPES)
    expect(String(caps['x-tpslModel'])).toContain('buildProtectionOrders')
    expect(String(caps['x-amendScope'])).toContain('limit')
  })

  it('withdrawPermissionCheck 是 not_applicable（本连接器不碰提现）', () => {
    expect(caps.withdrawPermissionCheck).toBe('not_applicable')
  })
})

describe('包卫生', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    license: string; exports: Record<string, string>; dependencies: Record<string, string>; private: boolean; type: string
  }

  it('README 首行是许可证声明（CPAL-1.0）', () => {
    expect(readme.split('\n', 1)[0]).toContain('CPAL-1.0')
  })

  it('README 首句是「未经真网验证，不得接实盘。」', () => {
    // fix-r3 E（裁决：README 状态句与 packages/cli/src/connectors.ts 注册表对齐——该连接器已注册进内核；「未经真网验证，不得接实盘」仍是首句）
    expect(readme).toContain('未经真网验证，不得接实盘。')
  })

  it('README 没有承诺类语言（findPromiseLanguage 为 null）', () => {
    expect(findPromiseLanguage(readme)).toBeNull()
  })

  it('package.json：CPAL-1.0 / private / ESM / 只依赖工作区包', () => {
    expect(pkg.license).toBe('CPAL-1.0')
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
    expect(pkg.exports['.']).toBe('./src/index.ts')
    for (const dep of Object.keys(pkg.dependencies)) expect(dep.startsWith('@gitrader/'), dep).toBe(true)
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@gitrader/connector-bybit-data', '@gitrader/protocol'])
  })

  it('README 写明已注册进内核（与 CLI 注册表一致）', () => {
    // fix-r3 E（裁决：README 状态句与 packages/cli/src/connectors.ts 注册表对齐——该连接器已注册进内核；「未经真网验证，不得接实盘」仍是首句）
    expect(readme).toContain('已注册进内核')
  })
})
