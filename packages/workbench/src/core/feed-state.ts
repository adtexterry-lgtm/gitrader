// SPDX-License-Identifier: CPAL-1.0
/** UI-only market freshness projection. Connector/account wire shapes remain owned by the kernel. */
export type FeedState = 'live' | 'stale' | 'down'

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const asRows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(rec).filter((x): x is Record<string, unknown> => !!x) : []
const time = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

/** Empty/unreadable connector state fails closed. A timestamp is required before data can be called live. */
export function deriveFeedState(statusValue: unknown, snapshotsValue?: unknown, now = Date.now()): FeedState {
  const status = rec(statusValue)
  const connectors = asRows(status?.connectors)
  if (!status || !connectors.length) return 'down'

  const connections = asRows(status.connections)
  const stateByVenue = new Map(connections.map((item) => [String(item.venue ?? ''), String(item.state ?? '')]))
  let stale = false
  for (const connector of connectors) {
    const detail = rec(connector.status)
    const id = String(connector.id ?? connector.venue ?? '')
    const state = String(detail?.wsState ?? detail?.connection ?? stateByVenue.get(id) ?? '')
    if (state === 'disconnected' || state === 'closed' || state === 'down') return 'down'
    if (state !== 'connected') { stale = true; continue }
    if (detail?.stale === true) stale = true
    const last = time(detail?.lastMessageTs)
    if (last === null || now - last > 5000) stale = true
  }

  for (const snapshot of asRows(snapshotsValue)) {
    if (snapshot.stale === true) stale = true
    const positions = asRows(snapshot.positions)
    for (const position of positions) {
      const markTs = time(position.markTs)
      if (markTs !== null && now - markTs > 5000) stale = true
    }
  }
  return stale ? 'stale' : 'live'
}
