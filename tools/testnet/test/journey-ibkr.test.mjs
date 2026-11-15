// SPDX-License-Identifier: CPAL-1.0
// ibkr 旅程的离线验收：真连接器 + 本包的假 TWS（**真 socket、真帧格式**，只监听 127.0.0.1 的随机端口）。
// 不联网（回环 socket 不是网外流量）、不读密钥、不写仓库内文件；每个用例结束都关掉假 TWS，不留后台进程。
// 三例与其它场所同口径（完整旅程 / 缺配置退出 3 且零连接 / 下单被拒退出 1 不回显账户号），
// 外加一例：实盘端口 7496 配模拟盘 → 构造期拒绝、零连接（美股八条 7）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadBundle } from '../lib/load-connector.mjs'
import { STEP_NAMES, parseJsonOutput } from './support/harness.mjs'

const FAKE_PATH = 'packages/connector-ibkr-trade/test/helpers/fake-tws.ts'
/** 2026-10-21 14:30Z = 纽约 10:30（常规时段内）；合约日历来自 contractDetails（04:00-20:00 可交易）。 */
const NOW = Date.UTC(2026, 9, 21, 14, 30, 0)
const ACCOUNT = 'DU1234567'

/** 起一个假 TWS（真 socket）+ 跑一遍旅程；env 缺省给「模拟端口 + 账户号」。 */
async function runJourney(options = {}) {
  const { fake: mod } = await loadBundle({ fake: FAKE_PATH })
  const tws = await mod.FakeTws.start({
    // 合约目录：旅程只用 AAPL；拿出来的是 STK / SMART / USD 的合约详情。
    catalogue: { AAPL: {} },
    quote: { bid: 100, ask: 100.02, last: 100.01 },
    ...(options.tws ?? {}),
  })
  const journey = await import('../journey-ibkr.mjs')
  const lines = []
  const env = options.env ?? { IBKR_PAPER_PORT: String(tws.port), IBKR_ACCOUNT: ACCOUNT }
  try {
    const code = await journey.main(options.argv ?? ['--json'], {
      env,
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
      clock: () => NOW,
    })
    return { code, lines, text: lines.join('\n'), steps: parseJsonOutput(lines), tws, mod }
  } finally {
    await tws.stop()
  }
}

test('ibkr：假 TWS 上跑完整旅程，13 步全过并打到对的请求', async () => {
  const { code, text, steps, tws } = await runJourney()
  assert.equal(code, 0, text)
  assert.equal(steps.ok, true)
  assert.deepEqual(steps.steps.map((step) => step.name), STEP_NAMES)
  assert.deepEqual(steps.steps.filter((step) => !step.ok).map((step) => `${step.name}:${step.receipt}`), [])
  // 连接：自动化 clientId 7；start() 会拉合约详情（旅程第 4 步要用）。
  assert.deepEqual(tws.startApiClientIds, [7])
  assert.match(steps.steps[0].receipt, /env=testnet amend=none/)

  // 改单：IB 没有原生改单（amend=none），引擎把这一步记为「跑过但场所声明不改」——receipt 以 skipped: 开头，
  // 不假装改过，也没有发出任何改单请求（IBKR 侧的 amend 一律 1004）。
  const amend = steps.steps.find((step) => step.name === 'amend')
  assert.equal(amend.ok, true)
  assert.match(amend.receipt, /^skipped: venue declares amend=none/)

  // 两张单（限价 + 触发）都发到了场所，也都撤掉了；没有用全撤（reqGlobalCancel 会连带撤手动单）。
  const orders = tws.ordersReceived()
  assert.ok(orders.length >= 2, `应发出至少两张单（实际 ${String(orders.length)}）`)
  assert.ok(tws.cancelled.length >= 2, '两张单都应逐张撤掉')
  assert.equal(tws.globalCancelCount, 0, '旅程不用全撤')

  // 触发单：买入止损（buy + stop_market），触发价在盘口上方 40%（参考价 100 → 140）。
  // IB 没有原生 reduce-only，平仓账户上卖触发单 = 开空会被拒，所以旅程不发卖单，也没有任何 reduce-only 补丁。
  const trigger = orders.find((order) => order.orderType.startsWith('STP'))
  assert.ok(trigger !== undefined, '应有一张止损类触发单')
  assert.equal(trigger.action, 'BUY')
  assert.notEqual(trigger.openClose, 'C')
  assert.equal(Number(trigger.totalQuantity), 1)
  assert.ok(Number(trigger.auxPrice) > 100, `触发价应在盘口上方（实际 ${String(trigger.auxPrice)}）`)
  assert.ok(orders.every((order) => order.action === 'BUY'), '旅程不应发出任何卖单')

  // 账户号（IBKR_ACCOUNT）不进任何输出行。
  assert.ok(!text.includes(ACCOUNT), '输出里不得出现券商账户号')
})

test('ibkr：没有连接配置时退出 3，不建立任何连接', async () => {
  const { code, text, tws } = await runJourney({ argv: [], env: {} })
  assert.equal(code, 3, text)
  assert.equal(tws.connections, 0, '缺配置时不应该建立任何 socket 连接')
  assert.match(text, /缺少密钥环境变量/)
  assert.match(text, /IBKR_PAPER_PORT/)
  assert.match(text, /IBKR_ACCOUNT/)
  assert.match(text, /本脚本不发任何请求/)
})

test('ibkr：下单被场所拒绝时退出 1，打印脱敏 Problem，后续步骤标 skipped', async () => {
  const { code, text, steps } = await runJourney({ tws: { orderBehaviour: 'reject' } })
  assert.equal(code, 1, text)
  assert.equal(steps.failedStep, 'place-limit')
  const place = steps.steps.find((step) => step.name === 'place-limit')
  assert.equal(place.ok, false)
  assert.equal(typeof place.problem.name, 'string')
  assert.ok(steps.steps.slice(steps.steps.indexOf(place) + 1).every((step) => step.skipped))
  assert.ok(!text.includes(ACCOUNT), '输出里不得出现券商账户号')

  // 人读模式（不带 --json）要把脱敏 Problem 打在 stderr 上。
  const readable = await runJourney({ argv: [], tws: { orderBehaviour: 'reject' } })
  assert.equal(readable.code, 1)
  assert.match(readable.text, /Problem: /)
  assert.match(readable.text, /失败于「place-limit」/)
  assert.ok(!readable.text.includes(ACCOUNT))
})

test('ibkr：实盘端口 7496 配模拟盘 → 构造期拒绝，退出 1 且零连接', async () => {
  const { code, text, tws } = await runJourney({ env: { IBKR_PAPER_PORT: '7496', IBKR_ACCOUNT: ACCOUNT } })
  assert.equal(code, 1, text)
  assert.match(text, /连接器构造失败/)
  assert.equal(tws.connections, 0, '端口与模式不符时不该建立任何连接')
  assert.ok(!text.includes(ACCOUNT), '拒绝信息里不得回显账户号')
})

test('ibkr：实盘账户号（U 开头）即使配自定义端口也构造期拒绝，退出 1 且零连接', async () => {
  const live = 'U7654321'
  const { code, text, tws } = await runJourney({ env: { IBKR_PAPER_PORT: '18999', IBKR_ACCOUNT: live } })
  assert.equal(code, 1, text)
  assert.match(text, /paper-trading account/)
  assert.equal(tws.connections, 0, '实盘账户号不该建立任何连接')
  assert.ok(!text.includes(live), '拒绝信息里不得回显账户号')
})
