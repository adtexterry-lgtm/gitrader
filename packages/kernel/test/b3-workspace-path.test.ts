// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { makeAgent, makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
beforeEach(async () => { h = await makeHarness() })
afterEach(async () => { await h.cleanup() })

const workspace = {
  schema: 'gitrader-workspace/1', id: 'ws_path_test', name: 'Path test',
  grid: { cols: 12, rowHeight: 80 }, channels: {}, items: [],
  statusBar: { block: 'block.example.status@0.1.0', pinned: true, takeover: [] }, popouts: [],
  savedBy: { actor: 'user:test', at: 1 },
}
let requestNo = 0
const agentCall = (agent: Awaited<ReturnType<typeof makeAgent>>, action: string, name?: string) =>
  h.k.ops.call(h.k, 'agent.workspace', { principal: agent.principal, params: { action, ...(name === undefined ? {} : { name }), requestId: `11111111-1111-4111-8111-${String(++requestNo).padStart(12, '0')}` }, transport: 'http' })

describe('workspace path validation', () => {
  it('accepts ordinary relative paths and only allows the whole empty input when requested', async () => {
    const { assertSafeRelativePath } = await import('../src/util/confined-path')
    expect(assertSafeRelativePath('nested/file.json')).toBe(join('nested', 'file.json'))
    expect(assertSafeRelativePath('', { allowEmpty: true })).toBe('')
    expect(() => assertSafeRelativePath('nested//file.json')).toThrow()
    expect(() => assertSafeRelativePath('nested/./file.json')).toThrow()
    expect(() => assertSafeRelativePath('', { allowEmpty: false })).toThrow()
  })

  it('rejects traversal, absolute roots, device names, ADS, controls, and trailing dots or spaces', async () => {
    const { assertSafeRelativePath } = await import('../src/util/confined-path')
    const drive = `${String.fromCharCode(67)}:${String.fromCharCode(92)}outside`
    const unc = `${String.fromCharCode(92, 92)}server${String.fromCharCode(92)}share`
    const cases = [
      '../outside', 'nested/../outside', resolve(tmpdir(), 'outside'), drive, unc,
      'CON', 'CoN.txt', 'com1.log', 'Lpt³.data', 'nested/file:stream',
      'trailing.', 'trailing ', 'bad\u0000name', 'bad\u001fname',
    ]
    for (const input of cases) expect(() => assertSafeRelativePath(input)).toThrow()
  })

  it('rejects existing directory junctions and a workspace root that escapes its anchor', async () => {
    const { resolveConfinedPath } = await import('../src/util/confined-path')
    const base = mkdtempSync(join(tmpdir(), 'gitrader-path-'))
    const anchorOutside = mkdtempSync(join(tmpdir(), 'gitrader-path-anchor-'))
    try {
      const root = join(base, 'root')
      const outside = join(base, 'outside')
      mkdirSync(root)
      mkdirSync(outside)
      writeFileSync(join(root, 'marker.json'), '{}')
      writeFileSync(join(outside, 'marker.json'), '{}')
      symlinkSync(outside, join(root, 'junction'), 'junction')
      expect(() => resolveConfinedPath(root, 'junction/marker.json')).toThrow()

      const rootLink = join(base, 'root-link')
      symlinkSync(anchorOutside, rootLink, 'junction')
      expect(() => resolveConfinedPath(rootLink, 'marker.json', { anchorRoot: base })).toThrow()
      expect(resolveConfinedPath(root, 'marker.json', { anchorRoot: base, mustExist: true })).toBe(join(root, 'marker.json'))
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(anchorOutside, { recursive: true, force: true })
    }
  })

})

describe('WorkspaceService and Agent workspace operations', () => {
  it('saves and loads a valid workspace through the Agent HTTP OpRegistry path when enabled', async () => {
    const agent = await makeAgent(h, 'paper')
    h.k.settings.setAgentLayout(true)
    h.k.workspaces.update(workspace, 'user:test')

    const saved = await agentCall(agent, 'save', 'layout-one')
    expect((saved as any).data.meta.name).toBe('layout-one') // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await agentCall(agent, 'load', 'layout-one') as any).data.workspace).toMatchObject({ id: workspace.id }) // eslint-disable-line @typescript-eslint/no-explicit-any
  })

  it('keeps the layout switch as a server-side gate', async () => {
    const agent = await makeAgent(h, 'paper')
    await expect(agentCall(agent, 'list')).rejects.toMatchObject({ problem: { code: 2003 } })
  })

  it('rejects traversal before writing and leaves a sibling sentinel unchanged', async () => {
    const agent = await makeAgent(h, 'paper')
    h.k.settings.setAgentLayout(true)
    h.k.workspaces.update(workspace, 'user:test')
    const outside = join(dirname(dirname(join(h.home, 'workspaces'))), `gitrader-path-sentinel-${basename(h.home)}.json`)
    const before = existsSync(outside) ? readFileSync(outside, 'utf8') : null

    await expect(agentCall(agent, 'save', '../../' + basename(outside).slice(0, -5))).rejects.toMatchObject({ problem: { code: -32602 } })
    expect(existsSync(outside)).toBe(before !== null)
    if (before !== null) expect(readFileSync(outside, 'utf8')).toBe(before)
  })

  it('blocks save and load when the workspace root is a junction outside its home anchor', () => {
    const root = h.k.paths.workspaces
    const external = join(dirname(h.home), `gitrader-path-root-${basename(h.home)}`)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(external, { recursive: true })
    writeFileSync(join(external, 'existing.json'), JSON.stringify(workspace))
    symlinkSync(external, root, 'junction')
    try {
      expect(() => h.k.workspaces.load('existing')).toThrow()
      expect(() => h.k.workspaces.save('new-layout', workspace, 'user:test', false)).toThrow()
      expect(existsSync(join(external, 'new-layout.json'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })

  it('filters unsafe reserved names from list results', () => {
    const root = h.k.paths.workspaces
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'good.json'), '{}')
    writeFileSync(join(root, 'CON.json'), '{}')

    const names = h.k.workspaces.list().map((item) => item.name)
    expect(names).not.toContain('CON')
  })
})
