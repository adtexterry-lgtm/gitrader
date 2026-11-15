// SPDX-License-Identifier: CPAL-1.0
// fix-r4 W 包：真壳 + 夹具内核的浏览器旅程——首次无 PIN 提示（出现 / 跳转 / 消失）、弱 PIN 二次确认（C5）、Agent 钥匙表撤销走 PIN（C6）。
// 夹具内核没有这些处理器：本用例自己在 applyPage 之后注册（不改 verify/ 里的夹具）。
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { problem } from '../verify/fixture-kernel'
import { buildShell, openShell, PIN, type Shell } from '../../blocks-r5/test/helpers/t2-shell'

const home = process.env.GITRADER_HOME
const edge = process.env.GITRADER_EDGE
const browserAvailable = process.env.GITRADER_SKIP_BROWSER !== '1' && !!home && !!edge && existsSync(edge)
let root = ''
let sh: Shell | undefined

type Rec = Record<string, unknown>
const now = Date.now()
let keys: Rec[] = []
const pinCalls: Rec[] = []

function installKernel(s: Shell) {
  keys = [
    { keyId: 'ak_live', name: 'Claude Code · 研究机', host: 'claude-code', status: 'active', createdAt: now - 86_400_000, expiresAt: now + 30 * 86_400_000, mandateId: 'mdt_live' },
    { keyId: 'ak_gone', name: 'Codex · 旧机器', host: 'codex', status: 'revoked', createdAt: now - 9 * 86_400_000, expiresAt: now + 10 * 86_400_000, revokedAt: now - 3_600_000, mandateId: 'mdt_gone' },
  ]
  s.kernel.onQuery('agentkey.list', () => structuredClone(keys))
  // 内核 presence 'pin'：没有在场证明 → ATTESTATION_REQUIRED（壳的 PIN 层接住并带证明重发）
  s.kernel.onCommand('agentkey.revoke', (p, ctx) => {
    const att = ctx.attestation as { method?: string; pin?: string } | undefined
    if (!att) throw problem('ATTESTATION_REQUIRED', 2010, 'This action requires a presence proof')
    if (att.method !== 'pin' || att.pin !== PIN) throw problem('AUTH_FAILED', 5003, 'invalid PIN')
    const key = keys.find((k) => k.keyId === (p as { keyId: string }).keyId)!
    key.status = 'revoked'
    key.revokedAt = Date.now()
    return { ...key, withdrawn: 1, openPositions: 2, openOrders: 0 }
  })
  s.kernel.onCommand('pin.set', (p) => {
    const { pin, confirmWeak } = p as { pin: string; confirmWeak?: boolean }
    pinCalls.push({ pin, confirmWeak })
    if (pin === '123456' && confirmWeak !== true) throw problem('INVALID_PARAMS', -32602, 'WEAK_PIN: 这个 PIN 容易被猜到（如连号、全相同数字），仍要使用请再确认一次')
    s.kernel.settings.pinSet = true
    return { ok: true, changed: false }
  })
}

describe.skipIf(!browserAvailable)('fix-r4 W 工作台壳 · 浏览器旅程', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(home!, 'fix-r4-shell-'))
    if (!resolve(root).startsWith(resolve(home!) + sep)) throw new Error('temporary directory escaped GITRADER_HOME')
    sh = await openShell({ staticDir: buildShell(join(root, 'static')), workDir: root })
    sh.applyPage('overview')
    installKernel(sh)
  }, 120_000)

  afterAll(async () => {
    await sh?.close()
    if (root && resolve(root).startsWith(resolve(home!) + sep)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('没设 PIN：总览顶部出提示，点「去设置」跳到设置 → 钥匙，设置页内不再显示', async () => {
    await sh!.open('#/overview')
    await sh!.waitFor(`!!document.querySelector('[data-act=pin-hint]')`)
    expect(await sh!.ev<string>(`document.querySelector('[data-act=pin-hint]').textContent`)).toContain('先设置 PIN')
    expect(await sh!.ev<number>(`document.querySelector('[data-act=pin-hint]').getBoundingClientRect().height`)).toBeLessThanOrEqual(32)
    await sh!.click('[data-act="pin-hint"]')
    await sh!.waitFor(`location.hash === '#/settings/keys'`)
    await sh!.waitFor(`!!document.querySelector('[data-act=pin-open]')`)
    expect(await sh!.ev<number>(`document.querySelectorAll('[data-act=pin-hint]').length`)).toBe(0)
  })

  it('弱 PIN：先挡住，原样保留输入，点「仍然使用」才带 confirmWeak 重发；设完后提示消失', async () => {
    await sh!.click('[data-act="pin-open"]')
    await sh!.type('input[aria-label="新 PIN"]', '123456')
    await sh!.type('input[aria-label="再输一次 PIN"]', '123456')
    await sh!.waitFor(`document.querySelector('[data-act=pin-save]') && !document.querySelector('[data-act=pin-save]').disabled`)
    await sh!.click('[data-act="pin-save"]')
    await sh!.waitFor(`!!document.querySelector('[data-act=pin-weak-confirm]')`)
    expect(await sh!.ev<string>(`document.querySelector('[data-ask=weak-pin]').textContent`)).toContain('这个 PIN 容易被猜到（连号或全相同），仍要使用吗？')
    expect(await sh!.ev<string>(`document.querySelector('input[aria-label="新 PIN"]').value`)).toBe('123456')
    expect(pinCalls).toEqual([{ pin: '123456', confirmWeak: undefined }])
    await sh!.click('[data-act="pin-weak-confirm"]')
    await sh!.waitFor(`!document.querySelector('[data-form=pin]')`)
    expect(pinCalls).toHaveLength(2)
    expect(pinCalls[1]).toEqual({ pin: '123456', confirmWeak: true })
    await sh!.goTo('#/overview')
    await sh!.waitFor(`!document.querySelector('[data-act=pin-hint]')`)
  })

  it('Agent 钥匙表：有效行有撤销，已吊销行灰显无按钮；撤销先确认、再走 PIN，只在 PIN 通过后生效一次', async () => {
    await sh!.goTo('#/settings/keys')
    await sh!.waitFor(`!!document.querySelector('[data-act=revoke-agent-key]')`)
    expect(await sh!.ev<string>('document.body.innerText')).toContain('API 钱包')
    expect(await sh!.ev<number>(`document.querySelectorAll('[data-act=revoke-agent-key]').length`)).toBe(1)
    expect(await sh!.ev<number>(`document.querySelectorAll('tr.is-revoked').length`)).toBe(1)
    expect(await sh!.ev<number>(`document.querySelectorAll('tr.is-revoked [data-act=revoke-agent-key]').length`)).toBe(0)

    await sh!.click('[data-act="revoke-agent-key"]')
    await sh!.waitFor(`!!document.querySelector('[data-ask=revoke-agent-key]')`)
    expect(await sh!.ev<string>(`document.querySelector('[data-ask=revoke-agent-key]').textContent`)).toContain('已有持仓和挂单不会自动处理')
    expect(sh!.commands('agentkey.revoke')).toHaveLength(0) // 确认前不发命令

    await sh!.click('[data-act="revoke-agent-key-confirm"]')
    await sh!.waitFor(`!!document.querySelector('.gr-pin input')`)
    expect(await sh!.ev<string>(`document.querySelector('.gr-dialog__t').textContent`)).toBe('撤销 Agent 钥匙')
    await sh!.type('.gr-pin input', PIN)
    await sh!.waitFor(`document.querySelector('[data-act=pin-confirm]') && !document.querySelector('[data-act=pin-confirm]').disabled`)
    await sh!.click('[data-act="pin-confirm"]')
    await sh!.waitFor(`!document.querySelector('.gr-pin') && document.querySelectorAll('[data-act=revoke-agent-key]').length === 0`)

    const calls = sh!.commands('agentkey.revoke')
    expect(calls.every((c) => JSON.stringify(c.params) === JSON.stringify({ keyId: 'ak_live' }))).toBe(true)
    expect(calls.filter((c) => c.attestation)).toHaveLength(1)
    expect(await sh!.ev<number>(`document.querySelectorAll('tr.is-revoked').length`)).toBe(2)
    const toasts = await sh!.ev<string>(`document.querySelector('.gr-toasts').textContent`)
    expect(toasts).toContain('已撤销 Agent 钥匙「Claude Code · 研究机」')
    expect(toasts).toContain('2 笔持仓')
    expect(await sh!.ev<number>(`document.querySelectorAll('[data-ask=revoke-agent-key]').length`)).toBe(0)
  })
})
