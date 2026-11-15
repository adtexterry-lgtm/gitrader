// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdSkill } from '../src/skills'
import type { Args, CliIo } from '../src/index'

let project: string
let out: string[]
let err: string[]

const io = (): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: {},
  interactive: false,
  readSecret: async () => { throw new Error('unexpected secret prompt') },
})
const args = (): Args => ({ cmd: ['skill', 'install', 'claude-code'], flags: {} })

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'gitrader-skill-'))
  out = []
  err = []
})
afterEach(() => { rmSync(project, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader skill install', () => {
  it('installs claude-code skill into project .claude/skills', async () => {
    const code = await cmdSkill(project, args(), io(), { cwd: () => project })
    expect(code).toBe(0)
    const target = join(project, '.claude', 'skills', 'gitrader-onboarding', 'SKILL.md')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8').length).toBeGreaterThan(0)
    expect(out.join('')).toContain(target)
  })

  it('missing source gives chinese error', async () => {
    const code = await cmdSkill(project, args(), io(), { cwd: () => project, source: () => undefined })
    expect(code).toBe(1)
    expect(err.join('')).toContain('这个安装包里没带上手技能')
  })
})
