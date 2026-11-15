// SPDX-License-Identifier: CPAL-1.0
// 上手技能包的自检：七步齐全、不索要 PIN / 令牌、命令都在白名单、没有收益承诺词。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const skill = readFileSync(join(repo, 'integrations/claude-code/SKILL.md'), 'utf8')
const mainSkill = readFileSync(join(repo, 'integrations/SKILL.md'), 'utf8')

describe('gitrader-onboarding skill', () => {
  it('skill lists seven steps', () => {
    const steps = [...skill.matchAll(/^###\s*第\s*([1-7])\s*步/gm)].map((m) => Number(m[1]))
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('never instructs asking for PIN or token', () => {
    expect(skill).not.toMatch(/(告诉|发给|提供|输入给)我.{0,6}(PIN|令牌)/)
    expect(skill).toMatch(/我不会问|不会问|不索要/)
  })

  it('every command in the skill exists in gitrader help', () => {
    // fix-r4: 新增 stop（技能里写明"关服务才用 gitrader stop"）
    const allowed = new Set(['doctor', 'init', 'serve', 'open', 'keys', 'mcp', 'agent', 'pin', 'skill', 'status', 'stop'])
    const found = [...skill.matchAll(/\bgitrader\s+([a-z][a-z-]*)/g)].map((m) => m[1])
    expect(found.length).toBeGreaterThan(0)
    expect([...new Set(found.filter((cmd) => !allowed.has(cmd)))]).toEqual([])
  })

  it('hard rules: 撤权只走界面/CLI、停服务、转述以返回字段为准、先问金额（两份主技能都要有）', () => {
    for (const s of [skill, mainSkill]) {
      for (const needle of ['keys revoke agent', 'gitrader stop', 'keptProtective', '金额']) expect(s, needle).toContain(needle)
    }
  })

  it('no promise words', () => {
    for (const word of ['保守', '激进', '稳赚', '跑赢', '稳定盈利']) expect(skill).not.toContain(word)
  })
})
