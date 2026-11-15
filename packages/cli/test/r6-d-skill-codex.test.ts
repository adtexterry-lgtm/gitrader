// SPDX-License-Identifier: CPAL-1.0
// R3-17：codex 版 skill 装到用户级 $CODEX_HOME/skills（没设就 ~/.codex/skills），不管带不带 --global；当前目录不写任何东西；输出不指向不随包的文件。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdSkill } from '../src/skills'
import type { Args, CliIo } from '../src/index'

let root: string
let cwd: string
let userHome: string
let source: string
let out: string[]
const io = (env: Record<string, string | undefined> = {}): CliIo => ({ out: (s) => { out.push(s) }, err: () => undefined, env, interactive: false, readSecret: async () => { throw new Error('unexpected secret prompt') } })
const args = (host: string, flags: Args['flags'] = {}): Args => ({ cmd: ['skill', 'install', host], flags })
const deps = () => ({ cwd: () => cwd, home: () => userHome, source: () => source })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gitrader-skill-codex-'))
  cwd = join(root, 'project'); userHome = join(root, 'user'); source = join(root, 'SKILL.md')
  mkdirSync(cwd); mkdirSync(userHome)
  writeFileSync(source, '# gitrader onboarding\n')
  out = []
})
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) })

describe('gitrader skill install codex', () => {
  it('没设 CODEX_HOME：装到 ~/.codex/skills，当前目录什么都不写', async () => {
    expect(await cmdSkill('', args('codex'), io(), deps())).toBe(0)
    const target = join(userHome, '.codex', 'skills', 'gitrader-onboarding', 'SKILL.md')
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(source, 'utf8'))
    expect(readdirSync(cwd)).toEqual([])
    expect(out.join('')).toContain(target)
  })

  it('设了 CODEX_HOME：装到 $CODEX_HOME/skills；带 --global 结果一样', async () => {
    const codexHome = join(root, 'custom-codex')
    for (const flags of [{}, { global: true }] as Array<Args['flags']>) {
      expect(await cmdSkill('', args('codex', flags), io({ CODEX_HOME: codexHome }), deps())).toBe(0)
      expect(existsSync(join(codexHome, 'skills', 'gitrader-onboarding', 'SKILL.md'))).toBe(true)
    }
    expect(existsSync(join(userHome, '.codex'))).toBe(false)
    expect(readdirSync(cwd)).toEqual([])
  })

  it('输出不指向 integrations/ 下不随包发布的文件', async () => {
    for (const host of ['codex', 'hermes', 'unigit']) {
      out = []
      expect(await cmdSkill('', args(host), io(), deps())).toBe(0)
      expect(out.join('')).not.toMatch(/integrations\//)
    }
  })

  it('claude-code 的目标位置不变（项目级 .claude/skills；--global 在用户目录）', async () => {
    expect(await cmdSkill('', args('claude-code'), io(), deps())).toBe(0)
    expect(existsSync(join(cwd, '.claude', 'skills', 'gitrader-onboarding', 'SKILL.md'))).toBe(true)
    expect(await cmdSkill('', args('claude-code', { global: true }), io(), deps())).toBe(0)
    expect(existsSync(join(userHome, '.claude', 'skills', 'gitrader-onboarding', 'SKILL.md'))).toBe(true)
  })
})
