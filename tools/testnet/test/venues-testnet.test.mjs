// SPDX-License-Identifier: CPAL-1.0
// 测试网主机登记表（tools/testnet/venues-testnet.json）与「只许连登记表主机」的校验。
// 三个必测点：①表外主机被拒；②HTX 查表返回「无测试网」；③登记表每条都有 officialUrl 且格式合法。
// 另加两条守卫：缺省基址必须仍在表内（防基址常量漂移）；实盘主机永远不许出现在表里。
// 全部离线：不联网、不读真实密钥环境变量（密钥用假值，只为越过「缺密钥」那一步）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { VENUES } from '../lib/venues.mjs'
import { assertTestnetBaseUrl } from '../lib/cli.mjs'
import {
  KINDS, NO_TESTNET, REGISTRY_ERROR, RegistryError, assertRegisteredHost, entriesFor, hostsFor,
  hasTestnet, loadRegistry, lookupHost, registryEntries, validateRegistry,
} from '../lib/venues-testnet.mjs'
import { main as binanceMain } from '../journey-binance.mjs'
import { LIVE as HTX_LIVE, TESTNET as HTX_TESTNET, main as htxMain, venue as htxVenue } from '../journey-htx.mjs'
import { TESTNET as DYDX_TESTNET } from '../journey-dydx.mjs'
import { EXIT } from '../lib/journey.mjs'

const REGISTRY = loadRegistry()

/** 跑一遍 htx / binance 的 CLI，收退出码 + 输出 + 请求次数。 */
async function runMain(main, argv, env) {
  let calls = 0
  const lines = []
  const deps = {
    env,
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl: async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    },
  }
  const code = await main(argv, deps)
  return { code, text: lines.join('\n'), calls }
}

test('③ 登记表结构：每条都有 officialUrl 且格式合法、verifiedAt 一致、venue+host 不重复', () => {
  const result = validateRegistry(REGISTRY)
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  assert.ok(result.checked.entries >= 9, `条目数 ${result.checked.entries} 少于覆盖场所数`)

  const entries = registryEntries(REGISTRY)
  for (const entry of entries) {
    assert.equal(typeof entry.officialUrl, 'string', `${entry.venue} 缺 officialUrl`)
    const url = new URL(entry.officialUrl)
    assert.equal(url.protocol, 'https:', `${entry.venue} 的 officialUrl 不是 https`)
    assert.ok(url.hostname.includes('.'), `${entry.venue} 的 officialUrl 没有主机名`)
    assert.equal(entry.verifiedAt, '2026-10-22', `${entry.venue} 的 verifiedAt 不是查证日`)
    assert.ok(KINDS.includes(entry.kind), `${entry.venue} 的 kind 非法：${entry.kind}`)
    assert.equal(typeof entry.officialMention, 'boolean', `${entry.venue} 缺 officialMention`)
  }

  // 覆盖：五个 crypto 交易场所 + 两个美股 + dYdX + HTX（无测试网）
  for (const venue of ['binance', 'okx', 'bybit', 'bitget', 'gateio', 'alpaca', 'ibkr', 'dydx', 'htx']) {
    assert.ok(entriesFor(venue, REGISTRY).length > 0, `登记表缺场所 ${venue}`)
  }
})

test('① 表外主机被拒：登记表外的主机一律 RegistryError(NOT_REGISTERED)', () => {
  for (const host of ['fapi.binance.com', 'api.binance.com', 'demo-api.binance.com', 'api.hbdm.com']) {
    assert.throws(
      () => assertRegisteredHost('binance', host, REGISTRY),
      (error) => error instanceof RegistryError && error.code === REGISTRY_ERROR.NOT_REGISTERED,
      `${host} 不该通过 binance 的表内校验`,
    )
  }
  // 表外主机在 CLI 层即退出 2（读密钥、建连接器之前），且一个请求都不发
  assert.throws(() => assertTestnetBaseUrl('https://fapi.binance.com', VENUES.binance), /不连实盘/)
  assert.throws(() => assertTestnetBaseUrl('https://demo-fapi.binance.com.evil.test', VENUES.binance), /不连实盘/)
  // 本机回环仍然放行（离线假服务器），但本机回环不是登记表里的场所主机
  assert.equal(lookupHost('binance', '127.0.0.1', REGISTRY), null)
  assert.doesNotThrow(() => assertTestnetBaseUrl('http://127.0.0.1:18080', VENUES.binance))
})

test('① 表外主机在 CLI 层：binance 带 --base-url 指向实盘 → 退出 2、零请求、不回显密钥', async () => {
  const { code, text, calls } = await runMain(binanceMain, ['--base-url', 'https://fapi.binance.com'], {
    BINANCE_TESTNET_API_KEY: 'k-test-0001',
    BINANCE_TESTNET_API_SECRET: 's-test-0001',
  })
  assert.equal(code, EXIT.USAGE, text)
  assert.equal(calls, 0, '护栏在读密钥前就该停，一个请求都不该发')
  assert.match(text, /登记表|不在允许范围内/)
  assert.ok(!text.includes('k-test-0001') && !text.includes('s-test-0001'), '输出里不得出现密钥')
})

test('② HTX 查表返回无测试网：无可用主机、任何主机都按 NO_TESTNET 拒', () => {
  assert.equal(hasTestnet(htxVenue, REGISTRY), false, 'HTX 不该有可用测试网主机')
  assert.deepEqual(hostsFor(htxVenue, REGISTRY), [])
  const rows = entriesFor(htxVenue, REGISTRY)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, NO_TESTNET)
  assert.equal(rows[0].host, null)
  assert.ok(rows[0].officialUrl.includes('htx.com'), 'HTX 那一行的出处必须是 HTX 官方文档页')

  for (const host of ['api.hbdm.vip', 'api.hbdm.com', 'api.hbdm.vip.evil.example.com']) {
    assert.throws(
      () => assertRegisteredHost(htxVenue, host, REGISTRY),
      (error) => error.code === REGISTRY_ERROR.NO_TESTNET,
      `${host} 应报 NO_TESTNET`,
    )
  }
})

test('② HTX 在 CLI 层：缺省主机与 api.hbdm.vip 都退出 2，零请求（不给用的场所不给跑）', async () => {
  for (const argv of [[], ['--base-url', 'https://api.hbdm.vip']]) {
    const { code, text, calls } = await runMain(htxMain, argv, {
      HTX_TESTNET_API_KEY: 'k-test-0001',
      HTX_TESTNET_API_SECRET: 's-test-0001',
    })
    assert.equal(code, EXIT.USAGE, `${JSON.stringify(argv)} → ${text}`)
    assert.equal(calls, 0, '零请求')
    assert.match(text, /无测试网/, JSON.stringify(argv))
    assert.ok(!text.includes('k-test-0001'), '输出里不得出现密钥')
  }
})

test('守卫：每个旅程脚本的缺省基址主机都仍在登记表内（基址常量漂移即红）', () => {
  for (const spec of Object.values(VENUES)) {
    const host = new URL(spec.baseUrl).hostname.toLowerCase()
    assert.ok(hasTestnet(spec.venue, REGISTRY), `${spec.venue} 在登记表里没有可用主机`)
    assert.ok(
      lookupHost(spec.venue, host, REGISTRY) !== null,
      `${spec.venue} 的缺省基址 ${host} 不在登记表里（基址漂移或登记表过期）`,
    )
    assert.doesNotThrow(() => assertTestnetBaseUrl(spec.baseUrl, spec), `${spec.venue} 的缺省基址被自己的白名单拒了`)
  }
  // 自实现护栏的两个场所（dYdX / HTX）也照同一张表
  for (const host of DYDX_TESTNET.hosts) {
    assert.ok(lookupHost('dydx', host, REGISTRY) !== null, `dYdX 测试网主机 ${host} 未登记`)
  }
  for (const host of HTX_TESTNET.hosts) {
    assert.fail(`HTX 登记为无测试网，TESTNET.hosts 不该再列出 ${host}`)
  }
})

test('守卫（反证）：实盘主机永远不会出现在登记表里', () => {
  const liveHosts = [
    ...HTX_LIVE.hosts,
    'fapi.binance.com', 'api.alpaca.markets', 'indexer.dydx.trade', 'dydx-rest.publicnode.com',
    'api.gateio.ws', 'api.bybit.com', 'api.okx.com',
  ]
  const registered = registryEntries(REGISTRY)
    .filter((entry) => typeof entry.host === 'string')
    .map((entry) => entry.host.toLowerCase())
  for (const live of liveHosts) {
    assert.ok(!registered.includes(live.toLowerCase()), `实盘主机 ${live} 被登记进了测试网表`)
  }
})

test('反证：登记表被篡改时校验函数必须报红（缺 officialUrl / http 链接 / 同主机冒充出处 / 重复行）', () => {
  const clone = () => JSON.parse(JSON.stringify(REGISTRY))

  const missingUrl = clone()
  delete missingUrl.entries[0].officialUrl
  assert.ok(validateRegistry(missingUrl).errors.some((line) => /officialUrl 缺失/.test(line)))

  const httpUrl = clone()
  httpUrl.entries[0].officialUrl = 'http://developers.binance.com/en/docs'
  assert.ok(validateRegistry(httpUrl).errors.some((line) => /必须是 https/.test(line)))

  const sameHost = clone()
  sameHost.entries[0].officialUrl = `https://${sameHost.entries[0].host}/fapi/v1/ping`
  assert.ok(validateRegistry(sameHost).errors.some((line) => /出处必须是文档页/.test(line)))

  const duplicated = clone()
  duplicated.entries.push({ ...duplicated.entries[0] })
  assert.ok(validateRegistry(duplicated).errors.some((line) => /重复/.test(line)))

  const contradictory = clone()
  contradictory.entries.push({ ...contradictory.entries[0], host: 'demo-fapi-2.binance.com', kind: '测试网' })
  contradictory.entries[0].kind = NO_TESTNET
  contradictory.entries[0].host = null
  assert.ok(validateRegistry(contradictory).errors.some((line) => /自相矛盾/.test(line)))

  const staleDate = clone()
  staleDate.entries[0].verifiedAt = '2026-01-01'
  assert.ok(validateRegistry(staleDate).errors.some((line) => /不一致/.test(line)))
})
