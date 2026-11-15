// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KernelClient, LinkHub, createHostBridge } from '../src'
import { startFakeKernel, type FakeKernel } from '../src/testing/fake-kernel'
import { good } from './helpers'

const actions = ['config.venues.set', 'config.notify.set', 'engine.bind', 'lab.stage', 'paper.reset'] as const
let kernel: FakeKernel
let client: KernelClient

beforeEach(async () => {
  kernel = await startFakeKernel()
  const response = await fetch(`${kernel.url}/api/session`, { method: 'POST', body: JSON.stringify({ bootstrap: kernel.bootstrapToken }) })
  const token = ((await response.json()) as { sessionToken: string }).sessionToken
  client = new KernelClient({ url: kernel.wsUrl, getToken: () => token, reconnect: false })
  await client.connect()
})

afterEach(async () => {
  client.close()
  await kernel.close()
})

const bridge = (action: string, isolation: 'inline' | 'iframe', trusted: boolean) => createHostBridge({
  manifest: good({ actions: [action], isolation }),
  instanceId: 'bi_sdk_first_party',
  kernel: client,
  hub: new LinkHub(),
  trusted,
  isUserActive: () => true,
})

describe('first-party write actions', () => {
  it.each(actions)('%s is denied to an untrusted inline block', async (action) => {
    await expect(bridge(action, 'inline', false).command(action, {})).rejects.toMatchObject({ code: 'FIRST_PARTY_ONLY' })
    expect(kernel.commands).toHaveLength(0)
  })

  it.each(actions)('%s is denied to a trusted iframe block', async (action) => {
    await expect(bridge(action, 'iframe', true).command(action, {})).rejects.toMatchObject({ code: 'FIRST_PARTY_ONLY' })
    expect(kernel.commands).toHaveLength(0)
  })

  it.each(actions)('%s reaches the kernel from trusted inline with user activation', async (action) => {
    kernel.onCommand(action, () => ({ ok: true }))
    await expect(bridge(action, 'inline', true).command(action, {})).resolves.toEqual({ ok: true })
    expect(kernel.commands.map((command) => command.action)).toEqual([action])
  })
})
