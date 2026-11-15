// SPDX-License-Identifier: CPAL-1.0
// ADR-3：新建数据目录时「Agent 开仓必须带止损」默认开；已有配置不动。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initHomeWithDefaults } from '../src/new-home'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'gr-newhome-')); dirs.push(d); return d }

describe('P1-20 new home defaults', () => {
  it('new home default config turns it on', () => {
    const r = initHomeWithDefaults(join(tmp(), 'home'))
    const saved = JSON.parse(readFileSync(r.paths.config, 'utf8')) as { risk: { requireStopOnAgentOpen?: boolean } }
    expect(saved.risk.requireStopOnAgentOpen).toBe(true)
    expect(r.config.risk.requireStopOnAgentOpen).toBe(true)
  })

  it('existing config is left untouched', () => {
    const home = join(tmp(), 'home')
    const first = initHomeWithDefaults(home)
    const cfg = JSON.parse(readFileSync(first.paths.config, 'utf8')) as { risk: Record<string, unknown> }
    delete cfg.risk.requireStopOnAgentOpen
    writeFileSync(first.paths.config, JSON.stringify(cfg, null, 2) + '\n')
    initHomeWithDefaults(home)
    const again = JSON.parse(readFileSync(first.paths.config, 'utf8')) as { risk: Record<string, unknown> }
    expect(again.risk.requireStopOnAgentOpen).toBeUndefined()
  })
})
