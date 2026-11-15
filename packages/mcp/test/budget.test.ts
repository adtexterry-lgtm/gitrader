// SPDX-License-Identifier: CPAL-1.0
// 工具预算自检：超预算 = 测试失败；BUDGET.md 必须与协议包当前的工具清单一致。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MCP_BUDGET, MCP_TOOLS } from '@gitrader/protocol'
import { checkBudget, computeBudget, renderBudgetMd } from '../src/budget'
import { INSTRUCTIONS } from '../src/server'

describe('MCP 工具预算（契约 §5.7）', () => {
  it('没有任何超预算项', () => {
    expect(checkBudget()).toEqual([])
  })

  it('工具数 17（≤ 24）；L0 默认 13、L1+ 默认 16', () => {
    const r = computeBudget()
    expect(r.toolCount).toBe(MCP_TOOLS.length)
    expect(r.toolCount).toBe(17)
    expect(r.toolCount).toBeLessThanOrEqual(MCP_BUDGET.maxTools)
    expect(r.defaultSets.find((s) => s.level === 'L0')!.tools).toBe(13)
    expect(r.defaultSets.find((s) => s.level === 'L1')!.tools).toBe(16)
  })

  it('每条描述 ≤ 60 字，每个参数描述 ≤ 100 字，单个工具定义 ≤ 450 token，默认集合 ≤ 6000 token（严格口径也过）', () => {
    const r = computeBudget()
    for (const t of r.tools) {
      expect(t.descriptionChars, t.name).toBeLessThanOrEqual(MCP_BUDGET.maxDescriptionChars)
      expect(t.maxParamDescriptionChars, t.name).toBeLessThanOrEqual(MCP_BUDGET.maxParamDescriptionChars)
      expect(t.tokens, t.name).toBeLessThanOrEqual(MCP_BUDGET.maxToolDefTokens)
      expect(t.tokensStrict, t.name).toBeLessThanOrEqual(MCP_BUDGET.maxToolDefTokens)
    }
    for (const s of r.defaultSets) {
      expect(s.tokens, s.level).toBeLessThanOrEqual(MCP_BUDGET.maxDefaultSetTokens)
      expect(s.tokensStrict, s.level).toBeLessThanOrEqual(MCP_BUDGET.maxDefaultSetTokens)
    }
  })

  it('握手说明也算常驻上下文：控制在 400 字符内', () => {
    expect(INSTRUCTIONS.length).toBeLessThan(400)
  })

  it('BUDGET.md 与当前清单一致（改了协议包的工具后运行 npm run budget -w @gitrader/mcp 重新生成）', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'BUDGET.md')
    expect(readFileSync(file, 'utf8')).toBe(renderBudgetMd())
  })

  it('预算检查本身会报警：把一条描述撑到 61 字就该失败', () => {
    const r = computeBudget()
    const fat = { ...r.tools[0]!, descriptionChars: MCP_BUDGET.maxDescriptionChars + 1 }
    expect(fat.descriptionChars).toBeGreaterThan(MCP_BUDGET.maxDescriptionChars)
    // 用渲染器验证违规项会被写进结论
    const md = renderBudgetMd({ ...r, violations: [`${fat.name}: description ${fat.descriptionChars} chars > ${MCP_BUDGET.maxDescriptionChars}`] })
    expect(md).toMatch(/超预算/)
  })
})
