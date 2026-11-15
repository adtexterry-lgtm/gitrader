// SPDX-License-Identifier: CPAL-1.0
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'
import { fakeNotifyManifest } from './fixtures/plugin-notify-fake/manifest'
import { pinPluginDir } from '../src/plugins'

let h: Harness | undefined
afterEach(async () => {
  if (!h) return
  await h.k.notify.stop()
  await h.k.plugins.stop(fakeNotifyManifest.id).catch(() => undefined)
  await h.cleanup()
  h = undefined
})

it('closes notifications before plugin shutdown can trigger a real process restart', async () => {
  h = await makeHarness({ configure: (config) => { config.plugins.developerMode = true } })
  const pluginId = fakeNotifyManifest.id
  const dir = join(h.home, 'plugins', 'notify-fixture')
  mkdirSync(dir, { recursive: true })
  const fixture = resolve(__dirname, 'fixtures/plugin-notify-fake/gsp.mjs')
  const lifecycle = join(h.home, 'notify-lifecycle.jsonl')
  const output = join(h.home, 'notify-output.jsonl')
  const wrapper = `// SPDX-License-Identifier: CPAL-1.0
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const file = process.env.B3_LIFECYCLE_FILE
appendFileSync(file, JSON.stringify({ event: 'start', pid: process.pid }) + '\\n')
process.on('exit', () => appendFileSync(file, JSON.stringify({ event: 'exit', pid: process.pid }) + '\\n'))
await import(pathToFileURL(process.env.B3_FIXTURE_SOURCE).href)
`
  writeFileSync(join(dir, 'wrapper.mjs'), wrapper)
  const manifest = {
    ...fakeNotifyManifest,
    secrets: [],
    runtime: { type: 'sidecar', native: false, diskMB: 1 },
    entry: { transport: 'stdio' },
    'x-launch': { command: process.execPath, args: ['wrapper.mjs'], env: { B3_FIXTURE_SOURCE: fixture, B3_LIFECYCLE_FILE: lifecycle } },
  }
  writeFileSync(join(dir, 'gitrader-plugin.json'), JSON.stringify(manifest))
  pinPluginDir(dir)
  expect((await h.k.plugins.reload()).rejected).toEqual([])
  h.k.plugins.grant(pluginId, [], h.sessionProof())
  h.k.config.notify = { channels: [{ id: 'main', plugin: pluginId, minLevel: 'info', params: { output } }], rateLimit: { perChannelPerMinute: 20, dedupeWindowSec: 300 } }
  await h.k.plugins.start(pluginId)
  h.k.events.publish('risk.denials', { accountId: h.paper.accountId, precheckId: 'shutdown-check', ruleHits: [] })
  await vi.waitFor(() => expect(existsSync(output) && readFileSync(output, 'utf8').trim().length > 0).toBe(true))

  let shutdownStarted = false
  const allStarts: Promise<void>[] = []
  const lateStarts: Promise<void>[] = []
  const start = h.k.plugins.start.bind(h.k.plugins)
  vi.spyOn(h.k.plugins, 'start').mockImplementation((id) => {
    const promise = start(id)
    allStarts.push(promise)
    if (shutdownStarted) lateStarts.push(promise)
    return promise
  })
  shutdownStarted = true
  try {
    await h.k.stop()
    await new Promise<void>((resolveNext) => setImmediate(resolveNext))
    await Promise.allSettled(allStarts)
    const events = readFileSync(lifecycle, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; pid: number })
    const starts = events.filter((event) => event.event === 'start')
    const exits = events.filter((event) => event.event === 'exit')
    expect(lateStarts).toHaveLength(0)
    expect(starts).toHaveLength(1)
    expect(exits).toEqual([{ event: 'exit', pid: starts[0]?.pid }])
    expect(new Set(starts.map((event) => event.pid)).size).toBe(1)
    expect(h.k.plugins.get(pluginId)?.state).toBe('stopped')
  } finally {
    await h.k.notify.stop()
    await Promise.allSettled(allStarts)
    await h.k.plugins.stop(pluginId)
    await h.cleanup()
    h = undefined
  }
})
