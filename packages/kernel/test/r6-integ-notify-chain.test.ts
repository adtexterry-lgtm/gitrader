// SPDX-License-Identifier: CPAL-1.0
// R2-REL-03（集成项）：全链路「一条通知在一个通道上最多 3 次 HTTP 尝试」。
// 真 NotifyOutlet + 四个通道插件（Slack / Telegram / Discord / 企业微信）的真 notify_send 工具（经 gsp.mjs 的 notifySendTool），
// 上游一律失败，数总共发出多少次 HTTP 请求。对照组：不经 exhausted 标记（直接 handleNotifySend）时，Slack 会叠成 6 次。
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus } from '../src/events'
import { NotifyOutlet } from '../src/notify/outlet'
import type { PluginHost } from '../src/plugins'
import type { NotifyConfig } from '../src/config'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { notifySendTool as slackTool } from '../../plugin-notify-slack/gsp.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { handleNotifySend as slackRaw } from '../../plugin-notify-slack/index.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { notifySendTool as telegramTool } from '../../plugin-notify-telegram/gsp.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { notifySendTool as discordTool } from '../../plugin-notify-discord/gsp.mjs'
// @ts-expect-error 纯 JS 插件，没有类型声明
import { notifySendTool as wecomTool } from '../../plugin-notify-wecom/gsp.mjs'

const SLACK = 'https://hooks.slack.com/services/T00000000/B00000000/fixtureSecretSegment'
const DISCORD = 'https://discord.com/api/webhooks/123456789012345678/fixture-token-value'
const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture-webhook-key-0001'
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after': '0' } })

type Tool = (args: unknown, deps: Record<string, unknown>) => Promise<unknown>
interface Case { name: string; tool: Tool; params: Record<string, unknown>; deps: (fetchImpl: unknown) => Record<string, unknown>; reply: () => Response; max: number }
const cases: Case[] = [
  { name: 'Slack（插件 3 次）', tool: slackTool, params: {}, deps: (fetchImpl) => ({ webhookUrl: SLACK, fetchImpl, sleepImpl: async () => {} }), reply: () => new Response('boom', { status: 503 }), max: 3 },
  { name: 'Telegram（429，插件 3 次）', tool: telegramTool, params: { chatId: '123' }, deps: (fetchImpl) => ({ token: '123456:fixture-token-value', fetchImpl }), reply: () => json(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 0 } }), max: 3 },
  { name: 'Discord（插件 2 次）', tool: discordTool, params: {}, deps: (fetchImpl) => ({ webhookUrl: DISCORD, fetchImpl }), reply: () => json(500, { message: 'Internal Server Error', code: 0 }), max: 3 },
  { name: '企业微信（插件 2 次）', tool: wecomTool, params: {}, deps: (fetchImpl) => ({ webhookUrl: WECOM, fetchImpl, retryDelayMs: 10 }), reply: () => json(200, { errcode: 45009, errmsg: 'api freq out of limit' }), max: 3 },
]

const outlets: NotifyOutlet[] = []
afterEach(() => { for (const o of outlets.splice(0)) o.stop() })

/** 把一条 critical 通知交给真出口，等它彻底跑完（没有新的 HTTP 请求 900 ms），返回总请求数。 */
async function httpAttempts(tool: Tool, params: Record<string, unknown>, deps: (fetchImpl: unknown) => Record<string, unknown>, reply: () => Response): Promise<number> {
  let requests = 0
  let last = Date.now()
  const fetchImpl = async (): Promise<Response> => { requests += 1; last = Date.now(); return reply() }
  const host = { get: () => ({}), callTool: async (_plugin: string, _tool: string, args: unknown) => { const r = await tool(args, deps(fetchImpl)); last = Date.now(); return r } } as unknown as PluginHost
  const events = new EventBus(Date.now, () => {})
  const config: NotifyConfig = { channels: [{ id: 'C', plugin: 'p', minLevel: 'info', params }], rateLimit: { perChannelPerMinute: 100, dedupeWindowSec: 300 } }
  const outlet = new NotifyOutlet({ events, plugins: host, config: () => config, now: Date.now, log: () => {} })
  outlets.push(outlet)
  events.publish('takeover.alert', { takeoverId: 'tk_chain', phase: 'failed', accountId: 'acct_fixture' })
  const start = Date.now()
  while ((requests === 0 || Date.now() - last < 900) && Date.now() - start < 15_000) await new Promise((r) => setTimeout(r, 25))
  return requests
}

describe('R2-REL-03 全链路 HTTP 尝试次数 ≤ 3', () => {
  for (const c of cases) {
    it(`${c.name}：上游一直失败，内核 + 插件合计 ≤ ${c.max} 次 HTTP 请求`, async () => {
      const n = await httpAttempts(c.tool, c.params, c.deps, c.reply)
      expect(n).toBeGreaterThanOrEqual(2)
      expect(n).toBeLessThanOrEqual(c.max)
    }, 30_000)
  }

  it('对照：Slack 不经 exhausted 标记时，内核会在插件 3 次之上再叠一轮（6 次）——这正是被修掉的叠加', async () => {
    const n = await httpAttempts(slackRaw, {}, cases[0]!.deps, cases[0]!.reply)
    expect(n).toBe(6)
  }, 30_000)
})
