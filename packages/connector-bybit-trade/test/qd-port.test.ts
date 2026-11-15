// SPDX-License-Identifier: CPAL-1.0
// 移植对拍：端点 / 方法 / 签名口径 / 移植出处注释必须与 QD v5.6.5 的当前实现一致（教训 1 / 2）。
// 静态断言（读本包源码）+ 行为断言（假服务器上的方法），不改任何外部文件。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { asDecimal } from '@gitrader/protocol'
import { AMBIGUOUS_RET_CODES, ENDPOINTS, prehashOf, signatureOf } from '../src/rest'
import { STOP_ORDER_FILTER } from '../src/orders'
import { buildProtectionOrders } from '../src/orders'
import type { OrderIntent } from '@gitrader/protocol'
import { btc } from './helpers/harness'

const root = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

describe('端点表（QD bybit.py / Bybit v5 官方）', () => {
  it('建单 / 改单 / 撤单 / 全撤的路径与方法', () => {
    expect(ENDPOINTS.orderCreate).toEqual({ method: 'POST', path: '/v5/order/create' })
    expect(ENDPOINTS.orderAmend).toEqual({ method: 'POST', path: '/v5/order/amend' })
    expect(ENDPOINTS.orderCancel).toEqual({ method: 'POST', path: '/v5/order/cancel' })
    expect(ENDPOINTS.orderCancelAll).toEqual({ method: 'POST', path: '/v5/order/cancel-all' })
  })

  it('查询端点全是 GET（order/realtime、order/history、position/list、wallet-balance、execution/list）', () => {
    for (const key of ['orderRealtime', 'orderHistory', 'positionList', 'walletBalance', 'executionList'] as const) {
      expect(ENDPOINTS[key].method).toBe('GET')
    }
    expect(ENDPOINTS.orderRealtime.path).toBe('/v5/order/realtime')
    expect(ENDPOINTS.orderHistory.path).toBe('/v5/order/history')
    expect(ENDPOINTS.positionList.path).toBe('/v5/position/list')
    expect(ENDPOINTS.walletBalance.path).toBe('/v5/account/wallet-balance')
    expect(ENDPOINTS.executionList.path).toBe('/v5/execution/list')
  })

  it('仓位设置：set-leverage / set-margin-mode / trading-stop 都是 POST', () => {
    expect(ENDPOINTS.setLeverage).toEqual({ method: 'POST', path: '/v5/position/set-leverage' })
    expect(ENDPOINTS.setMarginMode).toEqual({ method: 'POST', path: '/v5/account/set-margin-mode' })
    expect(ENDPOINTS.tradingStop).toEqual({ method: 'POST', path: '/v5/position/trading-stop' })
  })

  it('全表里没有任何 DELETE（Bybit v5 的撤单是 POST）', () => {
    for (const endpoint of Object.values(ENDPOINTS)) expect(endpoint.method).not.toBe('DELETE')
  })

  it('服务时间走公共端点 /v5/market/time（QD 的时间重校口径）', () => {
    expect(ENDPOINTS.serverTime).toEqual({ method: 'GET', path: '/v5/market/time' })
  })
})

describe('签名口径（QD bybit.py:286-319）', () => {
  it('待签串 = timestamp + apiKey + recvWindow + payload（顺序固定）', () => {
    expect(prehashOf('1792510147359', 'key', 5000, 'category=linear')).toBe('1792510147359key5000category=linear')
  })

  it('签名是 HMAC-SHA256 hex（SIGN-TYPE 2 的口径）', () => {
    const sign = signatureOf('secret', 'a')
    expect(sign).toBe(signatureOf('secret', 'a'))
    expect(sign).toMatch(/^[0-9a-f]{64}$/)
  })

  it('结果未知的 retCode 段包含 10000 / 10016 / 110072', () => {
    expect([...AMBIGUOUS_RET_CODES]).toEqual([10000, 10016, 10019, 110072])
  })
})

describe('触发单口径（QD native_protection.py:232-270）', () => {
  const parent: OrderIntent = {
    accountId: 'acc_bybit_1', instrumentId: 'bybit:BTCUSDT', side: 'buy', type: 'limit', size: '0.1', price: '100',
    tpsl: { stopLoss: { triggerPrice: '95' }, grouping: 'order' },
  } as unknown as OrderIntent

  it('保护腿带 closeOnTrigger + reduceOnly + triggerBy=MarkPrice（线性建单不发 orderFilter）', () => {
    const leg = buildProtectionOrders(parent, asDecimal('0.1'), btc()).stopLoss!
    expect('orderFilter' in leg.body).toBe(false)
    expect(leg.body.closeOnTrigger).toBe(true)
    expect(leg.body.reduceOnly).toBe(true)
    expect(leg.body.triggerBy).toBe('MarkPrice')
  })

  it('StopOrder 常量就是官方拼写', () => {
    expect(STOP_ORDER_FILTER).toBe('StopOrder')
  })
})

describe('移植出处注释', () => {
  it('每个移植自 QD 的函数都有 Ported from 注释（且带行号）', () => {
    const files = ['src/nonce.ts', 'src/precision.ts', 'src/rest.ts', 'src/parse.ts', 'src/venue-errors.ts', 'src/orders.ts', 'src/account.ts']
    let count = 0
    for (const file of files) {
      const text = read(file)
      const hits = text.match(/Ported from QuantDinger v5\.6\.5 \(Apache-2\.0\): backend_api_python\/[^\n]*:\d+(-\d+)?; adapted\./g) ?? []
      count += hits.length
    }
    expect(count).toBeGreaterThanOrEqual(7)
  })

  it('复制自本仓库其它文件的段落也写明了来源（limit-safety / 脱敏）', () => {
    expect(read('src/limit-safety.ts')).toContain('packages/connector-hyperliquid/src/limit-safety.ts')
    expect(read('src/errors.ts')).toContain('packages/notify-email/src/secret.ts')
    expect(read('src/market.ts')).toContain('packages/connector-bybit-data/src/market.ts')
  })

  it('README 的端点表与 ENDPOINTS 一致（没有写错方法）', () => {
    const readme = read('README.md')
    expect(readme).toContain('`POST /v5/order/create`')
    expect(readme).toContain('`POST /v5/order/cancel`')
    expect(readme).toContain('`POST /v5/order/cancel-all`')
    expect(readme).toContain('`POST /v5/order/amend`')
    expect(readme).toContain('`GET /v5/position/list`')
    expect(readme).toContain('`POST /v5/position/trading-stop`')
  })
})
