// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { BTC } from './helpers/fake-connector'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const callQuote = async (agent: Awaited<ReturnType<typeof makeAgent>>, instrumentId = BTC) =>
  h.k.ops.call(h.k, 'agent.market', {
    principal: agent.principal,
    params: { action: 'quote', instrumentId, requestId: 'd1000000-0000-4000-8000-000000000001' },
    transport: 'http',
  }) as Promise<{ data: unknown }>

describe('D1 Agent quote availability', () => {
  it('returns a no_feed explanation when no quote exists and preserves a valid quote response', async () => {
    const agent = await makeAgent(h, 'read_only')
    h.live.marks.delete(BTC)
    expect((await callQuote(agent)).data).toEqual({ quote: null, reason: 'no_feed', hint: '行情暂时没有数据，等几秒再试；持续没有就运行 gitrader doctor' })

    h.live.setMark(BTC, '80123')
    const quote = h.live.quote(BTC)
    expect((await callQuote(agent)).data).toEqual(quote)
  })

})
