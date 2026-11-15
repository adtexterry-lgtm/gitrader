// SPDX-License-Identifier: CPAL-1.0
// 旅程脚本自身的纯函数：定点定价、脱敏、Problem 归并、回执表、场所参数表的安全性质、CLI 用法错误。
import assert from 'node:assert/strict'
import test from 'node:test'
import { compareDecimal, decimalsOf, isNonZero, multiplyDecimal, shiftBps, snapDown, snapUp } from '../lib/decimal-text.mjs'
import { EXIT, createRedactor, describeProblem, formatTable, triggerPlan } from '../lib/journey.mjs'
import { VENUES } from '../lib/venues.mjs'
import { assertTestnetBaseUrl } from '../lib/cli.mjs'
import { main as binanceMain } from '../journey-binance.mjs'

test('定点运算：向下 / 向上贴步长、基点偏移、乘法、比较都不走浮点', () => {
  assert.equal(snapDown('95.37', '0.1'), '95.3')
  assert.equal(snapDown('95.3', '0.1'), '95.3')
  assert.equal(snapUp('0.0021', '0.001'), '0.003')
  assert.equal(snapUp('0.003', '0.001'), '0.003')
  assert.equal(shiftBps('100', -1500), '85')
  assert.equal(shiftBps('100', 1000), '110')
  assert.equal(multiplyDecimal('0.064', '85'), '5.44')
  assert.equal(compareDecimal('0.1', '0.10'), 0)
  assert.equal(compareDecimal('0.099', '0.1'), -1)
  assert.equal(decimalsOf('0.001'), 3)
  assert.equal(isNonZero('0.000'), false)
  assert.equal(isNonZero('0.001'), true)
})

test('触发单形状：sell 在参考价下方 40% 向下贴 tick（缺省口径不变），buy 在上方 40% 向上贴 tick', () => {
  const sell = triggerPlan('sell', '100.03', '0.1')
  assert.deepEqual([sell.side, sell.triggerPrice], ['sell', '60'])
  assert.match(sell.reason, /^testnet journey: .*far below the book, must stay untriggered$/)

  const buy = triggerPlan('buy', '100.03', '0.1')
  assert.deepEqual([buy.side, buy.triggerPrice], ['buy', '140.1'])
  assert.match(buy.reason, /^testnet journey: .*far above the book, must stay untriggered$/)

  assert.throws(() => triggerPlan('long', '100', '0.1'), /unknown trigger shape/)
})

test('脱敏：密钥原文与 base64 形态都被替换，短串不参与', () => {
  const redact = createRedactor(['secret-value-1234', 'ab'])
  const text = 'key=secret-value-1234 b64=c2VjcmV0LXZhbHVlLTEyMzQ= short=ab'
  const out = redact(text)
  assert.ok(!out.includes('secret-value-1234'))
  assert.ok(!out.includes('c2VjcmV0LXZhbHVlLTEyMzQ='))
  assert.match(out, /<redacted>/)
  assert.match(out, /short=ab/, '两字符的串不当作密钥处理（避免把普通文本打碎）')
})

test('Problem 归并：上游 Problem 保留码与名字，普通异常也脱敏成一行', () => {
  const redact = createRedactor(['top-secret-key'])
  const withProblem = new Error('boom')
  withProblem.problem = { code: 3006, name: 'VENUE_OUTCOME_UNKNOWN', message: 'sent with top-secret-key', retryable: false, venue: { id: 'bybit', code: 10016, message: 'timeout top-secret-key' } }
  const described = describeProblem(withProblem, redact)
  assert.equal(described.code, 3006)
  assert.equal(described.name, 'VENUE_OUTCOME_UNKNOWN')
  assert.ok(!described.message.includes('top-secret-key'))
  assert.equal(described.venue.code, 10016)

  const plain = describeProblem(new TypeError('bad input'), redact)
  assert.equal(plain.code, null)
  assert.equal(plain.name, 'TypeError')
  assert.equal(plain.retryable, false)
})

test('回执表：表头 + 每步一行，跳过的步骤标 skip', () => {
  const table = formatTable([
    { name: 'connect', ok: true, skipped: false, ms: 3, receipt: 'ok' },
    { name: 'account', ok: false, skipped: true, ms: 0, receipt: 'skipped: earlier step failed' },
  ])
  const lines = table.split('\n')
  assert.match(lines[0], /#\s+step\s+ms\s+result\s+receipt/)
  assert.match(table, /connect/)
  assert.match(table, /\b3\b\s+ok/)
  assert.match(table, /account.*skip/)
})

test('场所参数表：五所齐全，密钥变量名带 TESTNET/DEMO 前缀，基址都不是生产网', () => {
  const venues = Object.keys(VENUES).sort()
  assert.deepEqual(venues, ['binance', 'bitget', 'bybit', 'gateio', 'okx'])
  for (const [venue, spec] of Object.entries(VENUES)) {
    assert.equal(spec.venue, venue)
    assert.equal(spec.environment, 'testnet', `${venue} 只允许 testnet`)
    assert.ok(spec.credentials.length >= 2, `${venue} 至少两件凭据`)
    for (const credential of spec.credentials) {
      assert.match(credential.env, /TESTNET|DEMO/, `${venue} 的 ${credential.env} 必须带 TESTNET/DEMO 前缀`)
    }
    assert.match(spec.mode, /测试网|模拟盘/, `${venue} 必须声明只在测试网 / 模拟盘跑`)
    // OKX / Bitget 的模拟盘是同一主机 + 专用请求头，所以这两家允许与生产同主机，但 mode 必须是模拟盘。
    const host = new URL(spec.baseUrl).host
    const production = { binance: 'fapi.binance.com', bybit: 'api.bybit.com', gateio: 'api.gateio.ws' }
    if (production[venue] !== undefined) {
      assert.notEqual(host, production[venue], `${venue} 的缺省基址不能是生产网`)
    }
    assert.ok(spec.defaultInstrumentId.startsWith(`${venue}:`), `${venue} 的缺省标的必须带本场所前缀`)
  }
  assert.equal(VENUES.binance.baseUrl, 'https://demo-fapi.binance.com')
  assert.equal(VENUES.bybit.baseUrl, 'https://api-testnet.bybit.com')
  assert.equal(VENUES.gateio.baseUrl, 'https://api-testnet.gateapi.io')
})

test('CLI：未知参数退出 2，--help 退出 0 且列出环境变量名', async () => {
  const lines = []
  const deps = { env: {}, stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) }
  assert.equal(await binanceMain(['--nope'], deps), EXIT.USAGE)
  assert.match(lines.join('\n'), /未知参数/)

  const helpLines = []
  assert.equal(await binanceMain(['--help'], { env: {}, stdout: (line) => helpLines.push(line), stderr: () => {} }), EXIT.OK)
  const help = helpLines.join('\n')
  assert.match(help, /BINANCE_TESTNET_API_KEY/)
  assert.match(help, /demo-fapi\.binance\.com/)
})

test('CLI：--base-url 指向实盘主机即阻断，退出 2，不读密钥、不发请求', async () => {
  let calls = 0
  const lines = []
  const deps = {
    env: { BINANCE_TESTNET_API_KEY: 'k-test-0001', BINANCE_TESTNET_API_SECRET: 's-test-0001' },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl: async () => { calls += 1; return new Response('{}') },
  }
  for (const live of ['https://fapi.binance.com', 'https://api.binance.com/', 'http://demo-fapi.binance.com.evil.test']) {
    assert.equal(await binanceMain(['--base-url', live], deps), EXIT.USAGE, live)
  }
  assert.equal(calls, 0, '阻断发生在建连接器之前')
  const text = lines.join(' | ')
  assert.match(text, /不连实盘/)
  assert.ok(!text.includes('s-test-0001'))

  // 缺省基址与本机回环（假服务器 / 本地镜像）放行；IBKR 的裸 host:port 写法同样按主机判断。
  const binance = VENUES.binance
  assert.doesNotThrow(() => assertTestnetBaseUrl(binance.baseUrl, binance))
  assert.doesNotThrow(() => assertTestnetBaseUrl(`${binance.baseUrl}/`, binance))
  assert.doesNotThrow(() => assertTestnetBaseUrl('http://127.0.0.1:18080', binance))
  assert.doesNotThrow(() => assertTestnetBaseUrl('http://localhost:18080', binance))
  assert.doesNotThrow(() => assertTestnetBaseUrl('127.0.0.1:4002', { baseUrl: 'tcp://127.0.0.1' }))
  assert.throws(() => assertTestnetBaseUrl('https://api.alpaca.markets', { baseUrl: 'https://paper-api.alpaca.markets' }), /不连实盘/)
  assert.throws(() => assertTestnetBaseUrl('10.0.0.5:7497', { baseUrl: 'tcp://127.0.0.1' }), /不连实盘/)
})

test('CLI：登记主机也只接受 https、不许 URL 夹凭据', async () => {
  const binance = VENUES.binance
  // 夹凭据的 URL 用 URL 对象拼出来（字面量会被 check-public 当成邮箱）
  const withCreds = new URL(binance.baseUrl)
  withCreds.username = 'user'
  withCreds.password = 'pw'
  for (const bad of ['http://demo-fapi.binance.com', 'ws://demo-fapi.binance.com', withCreds.href]) {
    assert.throws(() => assertTestnetBaseUrl(bad, binance), /不连实盘/, bad)
  }
  assert.throws(() => assertTestnetBaseUrl(withCreds.href, binance), (error) => !String(error.message).includes(':pw'), '报错不回显 URL 里的凭据')
  assert.doesNotThrow(() => assertTestnetBaseUrl('https://demo-fapi.binance.com', binance))
  assert.doesNotThrow(() => assertTestnetBaseUrl('https://demo-fapi.binance.com/', binance))

  let calls = 0
  const lines = []
  const deps = {
    env: { BINANCE_TESTNET_API_KEY: 'k-test-0001', BINANCE_TESTNET_API_SECRET: 's-test-0001' },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl: async () => { calls += 1; return new Response('{}') },
  }
  assert.equal(await binanceMain(['--base-url', 'http://demo-fapi.binance.com'], deps), EXIT.USAGE)
  assert.equal(calls, 0, '阻断发生在建连接器之前')
  const text = lines.join(' | ')
  assert.match(text, /只接受 https/)
  assert.match(text, /不连实盘/)
  assert.ok(!text.includes('s-test-0001'))
})
