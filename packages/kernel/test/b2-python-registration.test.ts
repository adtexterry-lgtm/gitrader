// SPDX-License-Identifier: CPAL-1.0
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { initHome, saveConfig } from '../src/config'
import { builtinEngineLaunch } from '../src/engines'
import { Kernel } from '../src/kernel'
import { fileProvider } from '../src/device-key'
import type { EngineLaunch } from '../src/proto'

const fsMockState = vi.hoisted(() => ({ hidePythonEntry: false, exposePackagedPythonEntry: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: fs.PathLike) => {
      const value = String(path).replaceAll('\\', '/').toLowerCase()
      if (fsMockState.hidePythonEntry && (value.endsWith('python-engine/engine/main.py') || value.endsWith('engine-python/engine/main.py'))) return false
      if (fsMockState.exposePackagedPythonEntry && value.endsWith('/src/python-engine/engine/main.py')) return true
      return actual.existsSync(path)
    },
  }
})

let home: string | undefined
let kernel: Kernel | undefined

afterEach(async () => {
  await kernel?.stop()
  kernel = undefined
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
  home = undefined
})

describe('B2-09 Python engine registration', () => {
  const availableLaunch = builtinEngineLaunch('python-engine')
  const pythonHandshakeAvailable = !!availableLaunch && 'command' in availableLaunch && spawnSync(availableLaunch.command, ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0

  function localLaunch(launch: EngineLaunch | undefined): Extract<EngineLaunch, { command: string }> {
    if (!launch || !('command' in launch)) throw new Error('expected local Python launch')
    return launch
  }

  it('fresh init registers a disabled Python builtin beside the existing core engine', () => {
    home = mkdtempSync(join(tmpdir(), 'gitrader-b2-09-'))
    const { config } = initHome(home)
    expect(config.engines).toEqual([
      { id: 'gitrader-core', enabled: true, builtin: true },
      { id: 'python-engine', enabled: false, builtin: true },
    ])
  })

  it('re-init does not duplicate the builtin or overwrite the user enabled setting', () => {
    home = mkdtempSync(join(tmpdir(), 'gitrader-b2-09-'))
    const first = initHome(home).config
    first.engines.find((e) => e.id === 'python-engine')!.enabled = true
    saveConfig(home, first)
    const second = initHome(home).config
    expect(second.engines.filter((e) => e.id === 'python-engine')).toHaveLength(1)
    expect(second.engines.find((e) => e.id === 'python-engine')?.enabled).toBe(true)
  })

  it('resolves the workspace Python entry and honors the configured interpreter command', () => {
    const launch = builtinEngineLaunch('python-engine', { GEP_PYTHON: 'python-test-command' })
    const local = localLaunch(launch)
    expect(local).toMatchObject({ command: 'python-test-command' })
    const args = local.args ?? []
    expect(args).toHaveLength(1)
    expect(basename(args[0]!)).toBe('main.py')
    expect(fs.existsSync(args[0]!)).toBe(true)
    expect(builtinEngineLaunch('python-engine', { PATH: 'unused' })).toMatchObject({ command: 'python', env: { PYTHONDONTWRITEBYTECODE: '1' } })
  })

  it('prefers an entry beside the kernel module when both runtime layouts are present', () => {
    fsMockState.exposePackagedPythonEntry = true
    try {
      const launch = builtinEngineLaunch('python-engine', { GEP_PYTHON: 'python-test-command' })
      expect(localLaunch(launch).args?.[0]?.replaceAll('\\', '/')).toMatch(/\/src\/python-engine\/engine\/main\.py$/)
    } finally {
      fsMockState.exposePackagedPythonEntry = false
    }
  })

  it('preserves an explicit Python launch configured by the user', async () => {
    home = mkdtempSync(join(tmpdir(), 'gitrader-b2-09-'))
    const config = initHome(home).config
    const python = config.engines.find((e) => e.id === 'python-engine')!
    python.enabled = true
    python.launch = { command: 'custom-python-command', args: ['-u', 'custom-entry.py'], env: {} }
    saveConfig(home, config)
    kernel = await Kernel.create({ home, deviceKeyProvider: fileProvider, timers: false })
    expect(kernel.engines.status().find((e) => e.id === 'python-engine')).toMatchObject({ enabled: true, state: 'stopped', transport: 'stdio' })
  })

  it('keeps the default Python builtin stopped in a created Kernel', async () => {
    home = mkdtempSync(join(tmpdir(), 'gitrader-b2-09-'))
    kernel = await Kernel.create({ home, deviceKeyProvider: fileProvider, timers: false })
    expect(kernel.engines.status().find((e) => e.id === 'python-engine')).toMatchObject({ enabled: false, state: 'stopped' })
  })

  it('does not report an enabled builtin ready when its entry is unavailable', async () => {
    home = mkdtempSync(join(tmpdir(), 'gitrader-b2-09-'))
    const config = initHome(home).config
    config.engines.find((e) => e.id === 'python-engine')!.enabled = true
    saveConfig(home, config)
    fsMockState.hidePythonEntry = true
    try {
      kernel = await Kernel.create({ home, deviceKeyProvider: fileProvider, timers: false })
      expect(kernel.engines.status().find((e) => e.id === 'python-engine')).toMatchObject({
        enabled: true, state: 'failed', detail: 'bundled Python entry is unavailable', pid: null,
      })
    } finally {
      fsMockState.hidePythonEntry = false
    }
  })

  it.skipIf(!pythonHandshakeAvailable)('explicitly enabled builtin completes a real stdio GEP handshake', async () => {
    home = mkdtempSync(join(tmpdir(), 'gitrader-b2-09-'))
    const config = initHome(home).config
    config.engines.find((e) => e.id === 'python-engine')!.enabled = true
    saveConfig(home, config)
    kernel = await Kernel.create({ home, deviceKeyProvider: fileProvider, timers: false })
    await kernel.start({ port: 0, builtinEngine: true })
    const deadline = Date.now() + 4000
    while (!kernel.gep.isReady('python-engine') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(kernel.gep.isReady('python-engine')).toBe(true)
  })
})
