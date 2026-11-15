// SPDX-License-Identifier: CPAL-1.0
// `gitrader skill install <宿主>`：把随包的上手技能装到宿主会读的位置。
// 源优先用打包后的 dist/skills/gitrader-onboarding/SKILL.md；源码运行时向上找到仓库根的 integrations/claude-code/SKILL.md。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Args, CliIo } from './index'

const SKILL_HOSTS = ['claude-code', 'codex', 'hermes', 'unigit'] as const
const SKILL_DIR = 'gitrader-onboarding'
const SKILL_FILE = 'SKILL.md'

export interface SkillDeps {
  source(): string | undefined
  cwd(): string
  home(): string
  exists(path: string): boolean
  mkdir(path: string): void
  copy(source: string, target: string): void
}

/** 打包后与 CLI 同目录；开发态从 import.meta.url 逐级向上找仓库根。 */
function findSource(): string | undefined {
  const packaged = fileURLToPath(new URL('./skills/gitrader-onboarding/SKILL.md', import.meta.url))
  if (existsSync(packaged)) return packaged
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'integrations', 'claude-code', SKILL_FILE)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const defaultDeps = (): SkillDeps => ({
  source: () => findSource(),
  cwd: () => process.cwd(),
  home: () => homedir(),
  exists: (path) => existsSync(path),
  mkdir: (path) => { mkdirSync(path, { recursive: true }) },
  copy: (source, target) => { copyFileSync(source, target) },
})

export async function cmdSkill(_home: string, a: Args, io: CliIo, overrides: Partial<SkillDeps> = {}): Promise<number> {
  const d: SkillDeps = { ...defaultDeps(), ...overrides }
  const sub = a.cmd[1]
  const host = a.cmd[2]
  if (sub !== 'install' || !host || !(SKILL_HOSTS as readonly string[]).includes(host)) {
    io.err(`usage: gitrader skill install <${SKILL_HOSTS.join('|')}> [--global]\n`)
    return 2
  }

  const source = d.source()
  if (!source) {
    io.err('这个安装包里没带上手技能；请更新 Gitrader\n')
    return 1
  }

  const global = a.flags.global !== undefined
  const base = host === 'claude-code' && global
    ? d.home()
    : d.cwd()
  // R3-17：Codex 只读用户级技能目录（$CODEX_HOME/skills，没设就 ~/.codex/skills），所以不管带不带 --global 都装到那里，不再往当前目录写 .gitrader/
  const codexHome = io.env.CODEX_HOME?.trim() || join(d.home(), '.codex')
  const target = host === 'claude-code'
    ? join(base, '.claude', 'skills', SKILL_DIR, SKILL_FILE)
    : host === 'codex'
      ? join(codexHome, 'skills', SKILL_DIR, SKILL_FILE)
      : join(base, '.gitrader', 'skills', SKILL_DIR, SKILL_FILE)

  d.mkdir(dirname(target))
  if (d.exists(target)) d.copy(target, `${target}.bak`)
  d.copy(source, target)
  io.out(`已写入：${target}\n`)
  if (host === 'codex') io.out('Codex 启动时会读这个目录下的技能；重新开一个 codex 会话就能用。\n')
  else if (host !== 'claude-code') io.out(`请把这份文件加到 ${host} 的技能 / 说明里（${host} 读哪个目录以它自己的文档为准）\n`)
  return 0
}
