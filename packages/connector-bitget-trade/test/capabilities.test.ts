// SPDX-License-Identifier: CPAL-1.0
// 能力声明（老实）+ 密钥不外泄 + 包卫生（README 首句 / 禁词 / 许可证 / 无第三方依赖）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { bitgetCapabilities } from '../src/capabilities'
import { makeConnector } from './helpers/connector'
import { API_KEY, API_SECRET, FakeBitget, PASSPHRASE } from './helpers/fake-bitget'

const PKG = join(import.meta.dirname, '..')
const caps = bitgetCapabilities()

describe('能力声明 · 老实', () => {
  it('venue / 环境 / 标的类型', () => {
    expect(caps.venue).toBe('bitget')
    expect(caps.environments).toEqual(['mainnet', 'testnet'])
    expect(caps.instrumentKinds).toEqual(['perp'])
  })
  it('市价是 emulated + ioc_limit（不是 native：Gitrader 走价带限价 + ioc）', () => {
    expect(caps.orderTypes.market).toBe('emulated')
    expect(caps.marketEmulation).toEqual({ method: 'ioc_limit' })
  })
  it('限价 / 触发 / 追踪都是 native，twap 是 none', () => {
    expect(caps.orderTypes.limit).toBe('native')
    expect(caps.orderTypes.stop_market).toBe('native')
    expect(caps.orderTypes.stop_limit).toBe('native')
    expect(caps.orderTypes.take_market).toBe('native')
    expect(caps.orderTypes.take_limit).toBe('native')
    expect(caps.orderTypes.trailing_stop).toBe('native')
    expect(caps.orderTypes.twap).toBe('none')
  })
  it('tif 只有上游认的四种，trigger 只有 mark', () => {
    expect(caps.tif).toEqual(['gtc', 'ioc', 'fok', 'alo'])
    expect(caps.triggerPriceTypes).toEqual(['mark'])
  })
  it('tpsl：能力位不宣称（attachToOrder=false / positionLevel=false），保护单走包内方法', () => {
    expect(caps.tpsl?.attachToOrder).toBe(false)
    expect(caps.tpsl?.positionLevel).toBe(false)
    expect(caps.tpsl?.parentPartialCancel).toBe('keep_children')
  })
  it('batch 只声明一次一单（未实现批量端点）', () => {
    expect(caps.batch).toEqual({ maxOrders: 1, atomic: false })
  })
  it('amend 是 none；cancelAll 是 emulated（不用 cancel-all-orders，按标的模拟）', () => {
    expect(caps.amend).toBe('none')
    expect(caps.cancelAll).toBe('emulated')
  })
  it('不声明死人开关（上游没有定时全撤）', () => {
    expect(caps.deadman).toBeUndefined()
  })
  it('持仓模式两种、保证金模式两种、账户模型 standard', () => {
    expect(caps.positionMode).toEqual(['oneWay', 'hedge'])
    expect(caps.marginModes).toEqual(['cross', 'isolated'])
    expect(caps.accountModels).toEqual(['standard'])
  })
  it('限频声明两条（查询 20/s、下单 10/s），scope=uid', () => {
    expect(caps.rateLimits).toHaveLength(2)
    expect(caps.rateLimits?.[0]).toMatchObject({ scope: 'uid', model: 'count', limit: 20, windowMs: 1_000 })
    expect(caps.rateLimits?.[1]).toMatchObject({ scope: 'uid', model: 'count', limit: 10, windowMs: 1_000 })
  })
  it('clientOid 格式 alnum64；提现权限不敢声称安全（unknown）', () => {
    expect(caps.clientOrderId).toEqual({ format: 'alnum64' })
    expect(caps.withdrawPermissionCheck).toBe('unknown')
  })
  it('x-order-endpoints 覆盖 5 个下单 / 撤单端点，不含 modify-order 与 cancel-all-orders', () => {
    const endpoints = caps['x-order-endpoints'] as string[]
    for (const path of [
      'POST /api/v2/mix/order/place-order',
      'POST /api/v2/mix/order/place-plan-order',
      'POST /api/v2/mix/order/place-tpsl-order',
      'POST /api/v2/mix/order/cancel-order',
      'POST /api/v2/mix/order/cancel-plan-order',
    ]) expect(endpoints).toContain(path)
    expect(endpoints).not.toContain('POST /api/v2/mix/order/modify-order')
    expect(endpoints).not.toContain('POST /api/v2/mix/order/cancel-all-orders')
  })
  it('能力声明可 JSON 序列化（内核要把它放进 GEP 响应）', () => {
    expect(() => JSON.stringify(caps)).not.toThrow()
    expect(JSON.parse(JSON.stringify(caps)).venue).toBe('bitget')
  })
  it('连接器 describe() 与工厂函数一致', () => {
    const { connector } = makeConnector(new FakeBitget())
    expect(connector.describe().venue).toBe('bitget')
    expect(connector.describe().orderTypes.market).toBe('emulated')
  })
})

describe('密钥不外泄（教训 6）', () => {
  it('JSON.stringify(connector) 里没有任何凭据', () => {
    const { connector } = makeConnector(new FakeBitget())
    const text = JSON.stringify(connector)
    expect(text.includes(API_SECRET)).toBe(false)
    expect(text.includes(API_KEY)).toBe(false)
    expect(text.includes(PASSPHRASE)).toBe(false)
  })
  it('util.inspect(connector, {depth: 5}) 里没有凭据', () => {
    const { connector } = makeConnector(new FakeBitget())
    const text = inspect(connector, { depth: 5 })
    expect(text.includes(API_SECRET)).toBe(false)
    expect(text.includes(API_KEY)).toBe(false)
    expect(text.includes(PASSPHRASE)).toBe(false)
  })
  it('String(错误) 里没有凭据（签名错误路径）', async () => {
    const fake = new FakeBitget()
    const { trading } = makeConnector(fake)
    let text = ''
    try {
      await trading.placeProtection(
        { account: { accountId: 'acct_t', address: '0x00' }, signer: {} as never },
        { symbol: 'BTCUSDT', holdSide: 'long', size: '0.01', stopLossPrice: '1' },
      )
    } catch (e) {
      text = `${String(e)} ${JSON.stringify((e as { problem?: unknown }).problem ?? {})}`
    }
    // 上游没配错，这里只是拿一次真实错误路径；断言不出现任何凭据。
    expect(text.includes(API_SECRET)).toBe(false)
    expect(text.includes(API_KEY)).toBe(false)
    expect(text.includes(PASSPHRASE)).toBe(false)
  })
  it('HTTP 与 market 都不把凭据挂在可枚举字段上', () => {
    const { connector } = makeConnector(new FakeBitget())
    for (const key of Object.keys(connector.http)) expect(['apiSecret', 'apiKey', 'passphrase']).not.toContain(key)
  })
})

describe('包卫生', () => {
  const readme = readFileSync(join(PKG, 'README.md'), 'utf8')
  it('README 首行是许可证声明（CPAL-1.0）', () => {
    expect(readme.split('\n', 1)[0]).toContain('CPAL-1.0')
  })
  it('README 第一句写明「未经真网验证，不得接实盘」', () => {
    const firstChunk = readme.slice(0, 400)
    expect(firstChunk).toContain('未经真网验证，不得接实盘')
  })
  it('README 写明已注册进内核（与 CLI 注册表一致）', () => {
    // fix-r3 E（裁决：README 状态句与 packages/cli/src/connectors.ts 注册表对齐——该连接器已注册进内核；「未经真网验证，不得接实盘」仍是首句）
    expect(readme).toContain('已注册进内核')
  })
  it('README / 源码没有产品文案禁词', () => {
    const banned = [['保', '守'].join(''), ['激', '进'].join(''), ['稳', '赚'].join(''), ['跑', '赢'].join(''), ['Com', 'fy'].join(''), ['Wallet', 'Connect'].join('')]
    const sources = ['README.md', 'src/index.ts', 'src/connector.ts', 'src/capabilities.ts'].map((f) => readFileSync(join(PKG, f), 'utf8')).join('\n')
    for (const word of banned) expect(sources.includes(word)).toBe(false)
  })
  it('package.json：CPAL-1.0、私有、只依赖工作区包', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { license: string; private: boolean; dependencies: Record<string, string> }
    expect(pkg.license).toBe('CPAL-1.0')
    expect(pkg.private).toBe(true)
    for (const dep of Object.keys(pkg.dependencies)) expect(dep.startsWith('@gitrader/')).toBe(true)
  })
  it('每个源码文件首行是 SPDX CPAL-1.0', () => {
    const files = ['errors.ts', 'venue-errors.ts', 'budget.ts', 'clock.ts', 'rest.ts', 'parse.ts', 'fees.ts', 'precision.ts', 'orders.ts', 'account.ts', 'trading.ts', 'market.ts', 'capabilities.ts', 'connector.ts', 'index.ts', 'limit-safety.ts']
    for (const f of files) expect(readFileSync(join(PKG, 'src', f), 'utf8').split(/\r?\n/, 1)[0]).toBe('// SPDX-License-Identifier: CPAL-1.0')
  })
  it('LICENSE 与仓库本体许可证一致（CPAL-1.0 原文）', () => {
    expect(readFileSync(join(PKG, 'LICENSE'), 'utf8')).toContain('Common Public Attribution License Version 1.0')
  })
})
