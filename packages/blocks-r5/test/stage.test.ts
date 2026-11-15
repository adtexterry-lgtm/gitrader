// SPDX-License-Identifier: CPAL-1.0
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { KernelClient } from '@gitrader/blocks-sdk'
import { r5Fixtures } from '../fixtures'
import { parseScenario, startStage } from '../verify/stage-entry'
import { launchCdp, listProfileProcs, removeProfileDir, retryBusy } from './helpers/cdp'

const ownsHome = !process.env.GITRADER_HOME
const taskHome = process.env.GITRADER_HOME || mkdtempSync(join(tmpdir(), 'gitrader-r5-stage-'))
const ownedTemp = () => {
  const root = mkdtempSync(join(taskHome, 'stage-d1-'))
  const resolvedHome = resolve(taskHome)
  const resolvedRoot = resolve(root)
  if (!resolvedRoot.startsWith(resolvedHome + sep)) throw new Error('temporary directory escaped GITRADER_HOME')
  return root
}

afterAll(() => {
  if (!ownsHome) return
  const resolvedTaskHome = resolve(taskHome)
  const resolvedTempRoot = resolve(tmpdir())
  if (!resolvedTaskHome.startsWith(resolvedTempRoot + sep) || !basename(resolvedTaskHome).startsWith('gitrader-r5-stage-')) {
    throw new Error('owned temporary directory escaped the expected temp root')
  }
  rmSync(resolvedTaskHome, { recursive: true, force: true })
})

 describe('stage entry scenarios', () => {
  it('parses the longest page name before the state suffix', () => {
    expect(parseScenario('lab-detail-empty')).toMatchObject({ page: 'lab-detail', state: 'empty', view: 'detail' })
  })

  it('rejects unknown pages and states before creating service resources', async () => {
    expect(() => parseScenario('unknown-normal')).toThrow()
    expect(() => parseScenario('overview-unknown')).toThrow()
    const root = ownedTemp()
    const workspacesDir = join(root, 'workspaces')
    try {
      await expect(startStage({ staticDir: root, workspacesDir, scenario: 'unknown-normal' })).rejects.toThrow()
      expect(existsSync(workspacesDir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('starts a real fixture kernel for lab-detail-empty and serves empty view data', async () => {
    const root = ownedTemp()
    const staticDir = join(root, 'static')
    const workspacesDir = join(root, 'workspaces')
    mkdirSync(staticDir)
    let result: Awaited<ReturnType<typeof startStage>> | undefined
    let client: KernelClient | undefined
    try {
      result = await startStage({ staticDir, workspacesDir, scenario: 'lab-detail-empty' })
      expect(result.r5).toEqual({ page: 'lab-detail', state: 'empty', view: 'detail' })
      const boot = await fetch(`${result.kernel.url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap: result.kernel.bootstrapToken }),
      })
      expect(boot.ok).toBe(true)
      const session = await boot.json() as { sessionToken: string }
      client = new KernelClient({
        url: result.kernel.wsUrl,
        getToken: () => session.sessionToken,
        WebSocketCtor: globalThis.WebSocket as never,
        reconnect: false,
      })
      await client.connect()
      const list = await client.query<{ items: unknown[] }>('lab.list')
      const assets = await client.query<{ balances: unknown[] }>('account.assets')
      expect(list.items).toEqual([])
      expect(assets.balances).toEqual([])
    } finally {
      client?.close()
      await result?.kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads state-specific fixture views and query overrides into a real kernel', async () => {
    type PageFixture = { view?: string; queries?: Record<string, unknown>; commands?: Record<string, unknown> }
    const chart = r5Fixtures.chart as Record<string, PageFixture>
    const priorFixture = chart.unwired
    chart.unwired = { view: 'fixture-unwired', queries: { 'r5.fixture.state': { marker: 'state-specific' } } }
    const root = ownedTemp()
    const staticDir = join(root, 'static')
    const workspacesDir = join(root, 'workspaces')
    mkdirSync(staticDir)
    let result: Awaited<ReturnType<typeof startStage>> | undefined
    let client: KernelClient | undefined
    try {
      result = await startStage({ staticDir, workspacesDir, scenario: 'chart-unwired' })
      expect(result.r5).toEqual({ page: 'chart', state: 'unwired', view: 'fixture-unwired' })
      const boot = await fetch(`${result.kernel.url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap: result.kernel.bootstrapToken }),
      })
      const session = await boot.json() as { sessionToken: string }
      client = new KernelClient({
        url: result.kernel.wsUrl,
        getToken: () => session.sessionToken,
        WebSocketCtor: globalThis.WebSocket as never,
        reconnect: false,
      })
      await client.connect()
      await expect(client.query('r5.fixture.state')).resolves.toEqual({ marker: 'state-specific' })
    } finally {
      client?.close()
      await result?.kernel.close()
      if (priorFixture === undefined) delete chart.unwired
      else chart.unwired = priorFixture
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('calls function-valued query fixtures with the request params so each account gets its own answer', async () => {
    type PageFixture = { view?: string; queries?: Record<string, unknown>; commands?: Record<string, unknown> }
    const funds = r5Fixtures.funds as Record<string, PageFixture>
    const priorFixture = funds.unwired
    const seen: unknown[] = []
    funds.unwired = { queries: { 'r5.fixture.byAccount': (params: unknown) => { seen.push(params); return { equity: (params as { account?: string })?.account === 'hl-main' ? '10480.20' : '2000.00' } } } }
    const root = ownedTemp()
    const staticDir = join(root, 'static')
    const workspacesDir = join(root, 'workspaces')
    mkdirSync(staticDir)
    let result: Awaited<ReturnType<typeof startStage>> | undefined
    let client: KernelClient | undefined
    try {
      result = await startStage({ staticDir, workspacesDir, scenario: 'funds-unwired' })
      const boot = await fetch(`${result.kernel.url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap: result.kernel.bootstrapToken }),
      })
      const session = await boot.json() as { sessionToken: string }
      client = new KernelClient({
        url: result.kernel.wsUrl,
        getToken: () => session.sessionToken,
        WebSocketCtor: globalThis.WebSocket as never,
        reconnect: false,
      })
      await client.connect()
      await expect(client.query('r5.fixture.byAccount', { account: 'hl-main' })).resolves.toEqual({ equity: '10480.20' })
      await expect(client.query('r5.fixture.byAccount', { account: 'paper-1' })).resolves.toEqual({ equity: '2000.00' })
      expect(seen).toEqual([{ account: 'hl-main' }, { account: 'paper-1' }])
    } finally {
      client?.close()
      await result?.kernel.close()
      if (priorFixture === undefined) delete funds.unwired
      else funds.unwired = priorFixture
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('cdp helper EBUSY retry', () => {
  const busy = () => Object.assign(new Error('resource busy'), { code: 'EBUSY' })
  it('retries EBUSY at most 3 times, passes other errors through at once', async () => {
    let calls = 0
    await expect(retryBusy(() => { if (++calls < 3) throw busy(); return 'ok' }, 1)).resolves.toBe('ok')
    expect(calls).toBe(3)
    calls = 0
    await expect(retryBusy(() => { calls++; throw busy() }, 1)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(4)
    calls = 0
    await expect(retryBusy(() => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }, 1)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(calls).toBe(1)
  })
})

describe('cdp helper close', () => {
  it('does not throw when the profile directory stays busy; it records a note instead', async () => {
    const notes: string[] = []
    let calls = 0
    await expect(removeProfileDir('profile-x', notes, () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }, 1)).resolves.toBeUndefined()
    expect(calls).toBe(4)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('EBUSY')
  })

  it('leaves no browser process tree and no profile directory after close', async () => {
    const prior = process.env.GITRADER_HOME
    process.env.GITRADER_HOME = taskHome
    const cdp = await launchCdp()
    const { pid, profileDir } = cdp
    try {
      await cdp.navigate('about:blank')
      expect(listProfileProcs(profileDir).length).toBeGreaterThan(0)
    } finally {
      await cdp.close()
      if (prior === undefined) delete process.env.GITRADER_HOME
      else process.env.GITRADER_HOME = prior
    }
    expect(listProfileProcs(profileDir)).toEqual([])
    expect(existsSync(profileDir)).toBe(false)
    expect(cdp.cleanupNotes).toEqual([])
    expect(pid).toBeGreaterThan(0)
  })
})
