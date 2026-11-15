// SPDX-License-Identifier: CPAL-1.0
// HTX 旅程的离线验收：真连接器（esbuild 临时 ESM）+ connector-htx-trade 的假服务器（进程内 fetch，不开端口，不联网）。
//
// 假服务器按 HTX 官方签名规则**独立复算** HMAC-SHA256（四行待签串 METHOD\nhost\npath\ndata），
// 所以 baseUrl 必须用夹具里那个固定主机名（htx.example.test）——HTX 的签名含 host。
// 该主机属于 RFC 2606 保留名，公网永远解析不到，护栏专门为离线测试放行这一类名字（见 journey-htx.mjs 头注）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadBundle } from '../lib/load-connector.mjs'
import { EXIT } from '../lib/journey.mjs'
import { parseJsonOutput } from './support/harness.mjs'
import { HTX_STEPS, assertTestnetTarget, main as htxMain } from '../journey-htx.mjs'

const FAKE_PATH = 'packages/connector-htx-trade/test/helpers/fake-htx.ts'
const ORDER_WRITES = ['/v5/trade/order', '/v5/trade/cancel_order', '/v5/trade/cancel_all_orders']
const CLOSE_ALL = ['/v5/trade/position', '/v5/trade/position_all']

/** 起一个假 HTX + 跑一遍旅程。 */
async function runJourney(options = {}) {
  const { fake: mod } = await loadBundle({ fake: FAKE_PATH })
  const server = new mod.FakeHtx()
  server.accountMode = 'oneway'
  options.prepare?.(server, mod)
  const journey = await import('../journey-htx.mjs')
  const argv = options.argv ?? ['--json', '--base-url', mod.BASE_URL]
  let calls = 0
  const fetchImpl = options.fetchWrap
    ? options.fetchWrap(server.fetch, () => { calls += 1 }, mod)
    : async (input, init) => {
      calls += 1
      return server.fetch(input, init)
    }
  const lines = []
  const code = await journey.main(argv, {
    env: options.env ?? { HTX_TESTNET_API_KEY: mod.API_KEY, HTX_TESTNET_API_SECRET: mod.API_SECRET },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl,
  })
  return { code, lines, text: lines.join('\n'), steps: parseJsonOutput(lines), server, mod, calls: () => calls }
}

// HTX 的 v5 用同一个路径既查单（GET /v5/trade/order）又建单（POST），所以断言必须连方法一起看。
const writes = (server) => server.seen.filter((request) => request.method === 'POST' && ORDER_WRITES.includes(request.path))

test('htx：假服务器上跑完整旅程，13 步全过，签名由假服务器独立复算通过', async () => {
  const { code, text, steps, server, mod } = await runJourney()
  assert.equal(code, EXIT.OK, text)
  assert.equal(steps.ok, true, text)
  assert.deepEqual(steps.steps.map((step) => step.name), HTX_STEPS)
  assert.deepEqual(steps.steps.filter((step) => !step.ok).map((step) => `${step.name}:${step.receipt}`), [])

  // HTX 没有改单端点：这一步只回执不发请求。
  const amend = steps.steps.find((step) => step.name === 'amend')
  assert.match(amend.receipt, /^skipped: venue declares amend=none/)
  // 能力位：stop_market = none，所以旅程用第二张限价单代替触发单。
  assert.match(steps.steps[0].receipt, /stop_market=none/)

  // 端点：下两张限价单、撤两张；触发单端点一次都不碰。
  assert.equal(writes(server).filter((request) => request.path === '/v5/trade/order').length, 2, '两张限价单')
  assert.equal(writes(server).filter((request) => request.path === '/v5/trade/cancel_order').length, 2, '两张单都要撤')
  assert.equal(server.signatureFailures, 0, '假服务器独立复算签名必须全对')
  assert.equal(server.paramFailures, 0, '不该有缺参请求')

  // 最高级别：任何路径都不许调市价平仓 / 全平端点。
  assert.equal(server.closeAllCalls, 0, '不得调用市价平仓')
  assert.deepEqual(server.seen.filter((request) => CLOSE_ALL.includes(request.path)).map((request) => request.path), [])

  // 请求只打测试网基址 / 本项目夹具主机（fetch 被注入，物理上不出网）。
  assert.ok(!text.includes(mod.API_KEY) && !text.includes(mod.API_SECRET), '输出里不得出现密钥原文')
})

test('htx：没有密钥时退出 3，不发任何请求，也不回显值', async () => {
  const { fake: mod } = await loadBundle({ fake: FAKE_PATH })
  const { code, text, server, calls } = await runJourney({ argv: ['--base-url', mod.BASE_URL], env: {} })
  assert.equal(code, EXIT.NO_CREDENTIALS, text)
  assert.equal(calls(), 0, '缺密钥时不应该发任何请求')
  assert.equal(server.seen.length, 0)
  assert.match(text, /缺少密钥环境变量/)
  assert.match(text, /HTX_TESTNET_API_KEY/)
  assert.match(text, /HTX_TESTNET_API_SECRET/)
  assert.match(text, /本脚本不发任何请求/)
})

test('htx：不带任何参数时缺省主机无官方出处，退出 2、零请求、不回显密钥', async () => {
  let calls = 0
  const lines = []
  const code = await htxMain([], {
    env: { HTX_TESTNET_API_KEY: 'k-test-0001', HTX_TESTNET_API_SECRET: 's-test-0001' },
    stdout: (line) => lines.push(line),
    stderr: (line) => lines.push(line),
    fetchImpl: async () => {
      calls += 1
      return new Response('{}')
    },
  })
  const text = lines.join('\n')
  assert.equal(code, EXIT.USAGE, text)
  assert.equal(calls, 0, '缺省主机没过护栏，一个请求都不该发')
  assert.match(text, /没有经官方核实/)
  assert.ok(!text.includes('k-test-0001') && !text.includes('s-test-0001'), '输出里不得出现密钥原文')
})

test('htx：读持仓失败只报错停——退出 1，零下单、零平仓（G16 最高级别）', async () => {
  const { code, text, steps, server } = await runJourney({
    argv: ['--json', '--base-url', 'http://htx.example.test'],
    prepare: (fake) => {
      // 官方 v5 错误形状：code/message；读持仓端点失败。
      fake.positionsFailure = { code: 6001, message: 'system busy, please try again later' }
    },
  })
  assert.equal(code, EXIT.FAILED, text)
  assert.equal(steps.failedStep, 'account')
  assert.equal(server.closeAllCalls, 0, '读持仓失败绝不能触发市价平仓（批 8 的那条阻断）')
  assert.equal(writes(server).length, 0, '读失败时不该有任何下单 / 撤单')
  assert.equal(server.seen.filter((request) => request.path === '/v5/trade/position/opens').length, 1, '读一次就停，不重试')
  assert.equal(server.signatureFailures, 0)
  assert.ok(!text.includes('htx-test-secret'), '输出里不得出现密钥原文')
})

test('htx：护栏——实盘主机一律拒，回环 / RFC 2606 保留名放行；缺省主机无官方出处也拒', () => {
  assert.doesNotThrow(() => assertTestnetTarget({ environment: 'testnet', baseUrl: 'http://127.0.0.1:18080' }))
  assert.doesNotThrow(() => assertTestnetTarget({ environment: 'testnet', baseUrl: 'http://localhost:18080' }))
  assert.doesNotThrow(() => assertTestnetTarget({ environment: 'testnet', baseUrl: 'http://htx.example.test' }))

  const rejected = [
    [{ environment: 'testnet', baseUrl: 'https://api.hbdm.vip' }, /未经官方核实|没有经官方核实/],
    [{ environment: 'testnet', baseUrl: 'https://api.hbdm.vn' }, /实盘主机/],
    [{ environment: 'testnet', baseUrl: 'https://api.btcgateway.pro' }, /实盘主机/],
    [{ environment: 'testnet', baseUrl: 'https://x.hbdm.vn.evil.test' }, /实盘主机/],
    [{ environment: 'mainnet', baseUrl: 'https://api.hbdm.com' }, /environment=mainnet|实盘主机/],
    [{ environment: 'testnet', baseUrl: 'https://api.hbdm.com' }, /实盘主机/],
    [{ environment: 'testnet', baseUrl: 'https://api.htx.com/v5' }, /实盘主机/],
    [{ environment: 'testnet', baseUrl: 'https://api.hbdm.com.evil.test' }, /实盘主机/],
    [{ environment: 'testnet', baseUrl: 'https://api.hbdm.vip.evil.example.com' }, /不是测试网主机/],
    [{ environment: 'testnet', baseUrl: 'https://example.com' }, /不是测试网主机/],
    [{ environment: 'testnet', baseUrl: 'not a url' }, /无法解析/],
    [{ environment: 'testnet', baseUrl: '' }, /无法解析/],
  ]
  for (const [target, pattern] of rejected) {
    assert.throws(() => assertTestnetTarget(target), pattern, JSON.stringify(target))
  }
})

test('htx：--base-url 指向实盘主机即退出 2，读密钥之前就停，零请求', async () => {
  let calls = 0
  const lines = []
  for (const live of ['https://api.hbdm.com', 'https://api.hbdm.com/', 'https://api.htx.com']) {
    calls = 0
    const code = await htxMain(['--base-url', live], {
      env: { HTX_TESTNET_API_KEY: 'k-test-0001', HTX_TESTNET_API_SECRET: 's-test-0001' },
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
      fetchImpl: async () => {
        calls += 1
        return new Response('{}')
      },
    })
    assert.equal(code, EXIT.USAGE, live)
    assert.equal(calls, 0, '阻断发生在建连接器之前')
  }
  assert.match(lines.join(' | '), /实盘主机/)
  assert.ok(!lines.join(' ').includes('s-test-0001'))
})

test('htx：下单被场所拒绝退出 1，脱敏 Problem，后续步骤全 skipped、不撤单', async () => {
  const { code, text, steps, server } = await runJourney({
    argv: ['--json', '--base-url', 'http://htx.example.test'],
    fetchWrap: (inner, count, mod) => async (input, init) => {
      const method = String(init?.method ?? 'GET').toUpperCase()
      const path = new URL(String(input)).pathname
      if (method === 'POST' && path === '/v5/trade/order') {
        count()
        return new Response(JSON.stringify({ code: 1001, message: 'order rejected by venue', data: null, ts: mod.NOW }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      count()
      return inner(input, init)
    },
  })
  assert.equal(code, EXIT.FAILED, text)
  assert.equal(steps.failedStep, 'place-limit')
  const place = steps.steps.find((step) => step.name === 'place-limit')
  assert.equal(place.ok, false)
  assert.ok(steps.steps.slice(steps.steps.indexOf(place) + 1).every((step) => step.skipped))
  assert.equal(server.seen.filter((request) => request.path === '/v5/trade/cancel_order').length, 0, '没下成的单不该去撤')
  assert.equal(server.closeAllCalls, 0)
  assert.ok(!text.includes('htx-test-secret'), '输出里不得出现密钥原文')
})
