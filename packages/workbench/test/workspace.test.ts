// SPDX-License-Identifier: CPAL-1.0
import { describe, expect, it } from 'vitest'
import type { Workspace } from '@gitrader/blocks-sdk'
import { PRESETS, presetWorkspace, fixedWorkspace, BLOCK, FIXED_AREAS, FIXED_CARDS, FIXED_TITLES } from '../src/core/presets'
import {
  addBlock, applyPreset, arrangeItems, moveTile, pinnedIntact, removeInstance, resizeTile, setActive, setPinned, stackInto, tilesOf, unstack, validateWorkspace, GRID_ROWS,
} from '../src/core/workspace'
import { sizeOf } from './helpers'

const trade = (): Workspace => presetWorkspace('trade')
const user = { actor: 'user' as const, sizeOf }
const agent = { actor: 'agent' as const, sizeOf }
const item = (ws: Workspace, id: string) => ws.items.find((i) => i.instanceId === id)!

describe('预设', () => {
  it.each(PRESETS.map((p) => p.id))('%s 预设通过校验，且带齐三个钉住块', (id) => {
    const ws = presetWorkspace(id)
    expect(validateWorkspace(ws, sizeOf)).toEqual([])
    const pinned = ws.items.filter((i) => i.pinned).map((i) => i.block).sort()
    expect(pinned).toEqual([BLOCK.agent, BLOCK.risk].sort())
    expect(ws.statusBar.pinned).toBe(true)
    expect(pinned.every((b) => !ws.items.find((i) => i.block === b)!.stack)).toBe(true)
  })

  it('交易预设 = 契约示例：八块（含审计与资金曲线标签页），同屏约四块', () => {
    const ws = trade()
    expect(ws.items).toHaveLength(9)
    const tiles = tilesOf(ws)
    expect(tiles.length).toBe(5) // chart + bottom stack + agent + risk + right stack
    expect(tiles.find((t) => t.key === 'bottom')?.items).toHaveLength(4)
    expect(tiles.find((t) => t.key === 'bottom')?.activeId).toBe('bi_positions_1')
  })

  it('套用预设保留联动通道的值', () => {
    const ws = { ...trade(), channels: { A: { symbol: 'hyperliquid:ETH' }, B: { symbol: 'hyperliquid:SOL' } } }
    const next = applyPreset(ws, presetWorkspace('minimal'))
    expect(next.channels.A?.symbol).toBe('hyperliquid:ETH')
    expect(next.channels.B?.symbol).toBe('hyperliquid:SOL')
    expect(next.items).toHaveLength(4)
  })
})

describe('最小检阅版固定布局', () => {
  it('r4：五个条目（持仓 / Agent×3 活动·待批·钥匙 / 风险）+ 状态条，通过校验，Agent×3 与风险钉住', () => {
    const ws = fixedWorkspace()
    expect(validateWorkspace(ws, sizeOf)).toEqual([])
    expect(ws.items.map((i) => i.block)).toEqual([BLOCK.positions, BLOCK.agent, BLOCK.agent, BLOCK.agent, BLOCK.risk])
    expect(ws.items.filter((i) => i.block === BLOCK.agent).map((i) => (i.config as { view?: string } | undefined)?.view).sort()).toEqual(['feed', 'keys', 'pending'])
    expect(ws.items.filter((i) => i.pinned).map((i) => i.block)).toEqual([BLOCK.agent, BLOCK.agent, BLOCK.agent, BLOCK.risk])
    expect(item(ws, 'bi_positions_1').pinned).toBeFalsy()
    expect(ws.statusBar.pinned).toBe(true)
  })

  it('FIXED_AREAS / FIXED_CARDS / FIXED_TITLES 覆盖五个实例、区名唯一', () => {
    const ws = fixedWorkspace()
    const ids = ws.items.map((i) => i.instanceId)
    expect(Object.keys(FIXED_AREAS).sort()).toEqual([...ids].sort())
    const areas = ids.map((id) => FIXED_AREAS[id]!)
    expect(new Set(areas).size).toBe(5)
    for (const a of areas) {
      expect(FIXED_CARDS[a]).toBeTruthy()
      expect(FIXED_TITLES[a]).toBeTruthy()
    }
    expect(new Set(areas.map((a) => FIXED_CARDS[a])).size).toBe(5)
  })

  it('bi_agent_1 仍是待批实例（测试锚点不变）', () => {
    const a = item(fixedWorkspace(), 'bi_agent_1')
    expect(a.block).toBe(BLOCK.agent)
    expect((a.config as { view?: string } | undefined)?.view).toBe('pending')
    expect(FIXED_AREAS.bi_agent_1).toBe('pend')
  })
})

describe('校验', () => {
  it('抓出：stack 无 active / 多 active、钉住块进 stack、重叠、越界、小于最小尺寸', () => {
    const ws = trade()
    const bad = (mut: (w: Workspace) => void) => { const c = structuredClone(ws); mut(c); return validateWorkspace(c, sizeOf).map((i) => i.code) }
    expect(bad((w) => { item(w, 'bi_positions_1').active = false })).toContain('STACK_ACTIVE')
    expect(bad((w) => { item(w, 'bi_audit_1').active = true })).toContain('STACK_ACTIVE')
    expect(bad((w) => { item(w, 'bi_agent_1').stack = 's' })).toContain('PINNED_STACKED')
    expect(bad((w) => { item(w, 'bi_agent_1').x = 10 })).toContain('OVERLAP')
    expect(bad((w) => { item(w, 'bi_agent_1').x = 20 })).toContain('OUT_OF_BOUNDS')
    expect(bad((w) => { item(w, 'bi_chart_1').w = 4 })).toContain('TOO_SMALL')
  })
})

describe('拖动与缩放', () => {
  it('空位直接移动', () => {
    const ws = presetWorkspace('minimal')
    const r = moveTile(ws, 'bi_positions_1', 0, 18, user)
    expect(r.ok).toBe(true)
  })

  it('撞上别的块：人可以把它向下推；推不下去则失败', () => {
    const ws = trade()
    // chart 往下拖到 y=9：压住底部标签组 → 标签组被推到 y=26，超出 26 行 → 失败
    const r = moveTile(ws, 'bi_chart_1', 0, 9, user)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('NO_SPACE')
    // minimal 里 positions 在下方留有 0 空间；把 chart 缩小后再放下可推动
    const small = resizeTile(presetWorkspace('minimal'), 'bi_chart_1', 17, 10, user)
    expect(small.ok).toBe(true)
  })

  it('Agent 不能推动或遮挡钉住块；人可以', () => {
    const ws = trade()
    const a = moveTile(ws, 'bi_chart_1', 8, 0, agent) // chart 右移，盖住 agent（x15..）
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.code).toBe('PINNED_OBSTRUCTED')
  })

  it('缩放：不能小于最小尺寸，不能超出网格，钉住块也一样', () => {
    const ws = trade()
    expect(resizeTile(ws, 'bi_agent_1', 5, 10, user)).toMatchObject({ ok: false, code: 'TOO_SMALL' })
    expect(resizeTile(ws, 'bi_agent_1', 9, 6, user)).toMatchObject({ ok: true })
    // 超宽被夹到 24 列，要把右边的钉住块推下去，下面没有空间 → 拒绝
    expect(resizeTile(ws, 'bi_chart_1', 30, 17, user)).toMatchObject({ ok: false, code: 'NO_SPACE' })
  })

  it('stack 成员一起改位置尺寸', () => {
    const r = moveTile(presetWorkspace('review'), 'top', 10, 0, user)
    expect(r.ok).toBe(true)
    const g = resizeTile(presetWorkspace('review'), 'top', 14, 12, user)
    expect(g.ok).toBe(true)
    if (g.ok) expect(['bi_positions_1', 'bi_audit_1', 'bi_equity_1'].map((i) => item(g.ws, i).h)).toEqual([12, 12, 12])
  })
})

describe('加块 / 移除', () => {
  it('只能放已安装的块', () => {
    expect(addBlock(trade(), 'block.acme.nope@1.0.0', {}, user)).toMatchObject({ ok: false, code: 'NOT_INSTALLED' })
  })

  it('auto：有空位放默认尺寸；没有空位叠进最大的非钉住瓦片当标签', () => {
    const freed = removeInstance(presetWorkspace('minimal'), 'bi_positions_1', user)
    expect(freed.ok).toBe(true)
    const roomy = addBlock((freed as { ws: Workspace }).ws, BLOCK.orderbook, {}, user) // 17×8 的空位放不下默认 8×12，退到最小 5×5
    expect(roomy.ok).toBe(true)
    if (roomy.ok) {
      const added = roomy.ws.items.at(-1)!
      expect(added.stack).toBeUndefined()
      expect([added.w, added.h]).toEqual([5, 5])
      expect(validateWorkspace(roomy.ws, sizeOf)).toEqual([])
    }
    const full = addBlock(trade(), BLOCK.orderbook, { instanceId: 'bi_orderbook_2' }, user)
    expect(full.ok).toBe(true)
    if (full.ok) {
      const added = item(full.ws, 'bi_orderbook_2')
      expect(added.stack).toBeTruthy()
      expect(added.active).toBe(true)
      expect(validateWorkspace(full.ws, sizeOf)).toEqual([])
      expect(tilesOf(full.ws).find((t) => t.key === added.stack)?.activeId).toBe('bi_orderbook_2')
    }
  })

  it('钉住块不可移除（Agent 与人都先要取消钉住）；stack 剩一个时自动解散', () => {
    const ws = trade()
    expect(removeInstance(ws, 'bi_risk_1', user)).toMatchObject({ ok: false, code: 'PINNED' })
    expect(removeInstance(ws, 'bi_risk_1', agent)).toMatchObject({ ok: false, code: 'PINNED' })
    let cur = ws
    for (const id of ['bi_authorizations_1']) { const r = removeInstance(cur, id, user); expect(r.ok).toBe(true); if (r.ok) cur = r.ws }
    expect(item(cur, 'bi_symbols_1').stack).toBeUndefined() // 右侧 stack 只剩一个 → 解散
    expect(validateWorkspace(cur, sizeOf)).toEqual([])
    // 移除 active 的标签 → 另一个成为 active
    const r2 = removeInstance(ws, 'bi_positions_1', user)
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.ws.items.filter((i) => i.stack === 'bottom' && i.active)).toHaveLength(1)
  })

  it('取消钉住只有人能做；钉住块不能叠进 stack', () => {
    const ws = trade()
    expect(setPinned(ws, 'bi_risk_1', false, agent)).toMatchObject({ ok: false })
    expect(stackInto(ws, 'bi_risk_1', 'bottom', user)).toMatchObject({ ok: false, code: 'PINNED' })
    expect(stackInto(ws, 'bi_chart_1', 'bi_risk_1', user)).toMatchObject({ ok: false, code: 'PINNED' })
    const un = setPinned(ws, 'bi_risk_1', false, user)
    expect(un.ok).toBe(true)
    if (un.ok) expect(removeInstance(un.ws, 'bi_risk_1', user).ok).toBe(true)
  })
})

describe('标签组', () => {
  it('切换 active；叠入 / 拆出保持校验通过', () => {
    const ws = trade()
    const a = setActive(ws, 'bi_audit_1')
    expect(a.ok).toBe(true)
    if (a.ok) {
      expect(item(a.ws, 'bi_audit_1').active).toBe(true)
      expect(item(a.ws, 'bi_positions_1').active).toBe(false)
      expect(validateWorkspace(a.ws, sizeOf)).toEqual([])
    }
    const s = stackInto(ws, 'bi_chart_1', 'bottom', user)
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(validateWorkspace(s.ws, sizeOf)).toEqual([])
      const back = unstack(s.ws, 'bi_chart_1', user) // 图表原来的位置空出来了，可以拆回去
      expect(back.ok).toBe(true)
      if (back.ok) expect(validateWorkspace(back.ws, sizeOf)).toEqual([])
    }
    // 满屏时拆不出来
    expect(unstack(trade(), 'bi_audit_1', user)).toMatchObject({ ok: false, code: 'NO_SPACE' })
    const minimal = presetWorkspace('minimal')
    const s2 = stackInto(minimal, 'bi_positions_1', 'bi_chart_1', user)
    expect(s2.ok).toBe(true)
    if (s2.ok) {
      const u = unstack(s2.ws, 'bi_positions_1', user)
      expect(u.ok).toBe(true)
      if (u.ok) expect(validateWorkspace(u.ws, sizeOf)).toEqual([])
    }
  })
})

describe('Agent 排布（workspace.arrange）', () => {
  it('必须保留钉住块；不合格的整体拒绝', () => {
    const ws = trade()
    const dropRisk = ws.items.filter((i) => i.instanceId !== 'bi_risk_1')
    expect(arrangeItems(ws, dropRisk, agent)).toMatchObject({ ok: false, code: 'PINNED' })
    const unpin = ws.items.map((i) => (i.instanceId === 'bi_risk_1' ? { ...i, pinned: false } : i))
    expect(arrangeItems(ws, unpin, agent)).toMatchObject({ ok: false, code: 'PINNED' })
    const shrunk = ws.items.map((i) => (i.instanceId === 'bi_risk_1' ? { ...i, w: 3 } : i))
    expect(arrangeItems(ws, shrunk, agent)).toMatchObject({ ok: false, code: 'INVALID' })
    expect(arrangeItems(ws, ws.items, agent).ok).toBe(true)
  })

  it('pinnedIntact', () => {
    const ws = trade()
    expect(pinnedIntact(ws, presetWorkspace('review'), sizeOf)).toBe(true)
    expect(pinnedIntact(ws, { ...ws, items: ws.items.filter((i) => i.instanceId !== 'bi_agent_1') }, sizeOf)).toBe(false)
  })

  it('网格行数固定为至少 26', () => {
    expect(GRID_ROWS).toBe(26)
  })
})
