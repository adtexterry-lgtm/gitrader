// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import { deriveFeedState } from '../../workbench/src/core/feed-state'

describe('D1 freshness projection', () => {
  const status = (wsState = 'connected', ts = 10000) => ({ connectors: [{ id: 'venue_fixture', status: { wsState, lastMessageTs: ts } }], connections: [{ venue: 'venue_fixture', state: 'connected' }] })
  it('does not confuse a kernel connector boot with a live market socket', () => {
    expect(deriveFeedState(status('disconnected'), [], 10000)).toBe('down')
    expect(deriveFeedState({ connectors: [] }, [], 10000)).toBe('down')
  })
  it('ages real marks and stale snapshots, then recovers on fresh evidence', () => {
    expect(deriveFeedState(status(), [{ stale: true }], 10000)).toBe('stale')
    expect(deriveFeedState(status(), [{ positions: [{ markTs: 4000 }] }], 10000)).toBe('stale')
    expect(deriveFeedState(status(), [{ positions: [{ markTs: 10000 }] }], 10000)).toBe('live')
    expect(deriveFeedState(status(), [], 16000)).toBe('stale')
  })
})
