// SPDX-License-Identifier: CPAL-1.0
// 网格模板（QD 对齐：app/services/grid/levels.py 的等差 / 等比线生成、config.py 的 boundaryAction 三档、
// engine.py::handle_boundary 的「越界先撤开仓单、hold 只记日志」语义；Apache-2.0，设计参照不抄码）。
// 语义：gridCount 指「格数」（cells），边界线 = 格数 + 1，与 QD GridBotConfig.grid_count_unit='cells' 一致。
// 每格：开仓线成交后挂平仓线；同一格不在同一根 K 线内完成来回（避免用「低点买、高点卖」的乐观假设）。
import { BotParamError, BotStateError } from './errors'
import { PaperLedger } from './ledger'
import { intOf, numOf, requireParams, strOf } from './params'
import { assertIntent, closeAllIntent, stopLossHit } from './risk'
import { assertSafetyDeclared, capsOf, checkExposure, requireSafetyProvided } from './safety'
import type { BoundaryAction, BotCaps, BotContext, BotFill, BotHalt, BotParamDef, BotRuntime, BotSnapshot, GridDirection, OrderIntent } from './types'

export const GRID_PARAMS: readonly BotParamDef[] = [
  { key: 'lowerPrice', label: '下限价', type: 'number', default: 90_000, min: 1e-6, max: 1e9, step: 1, help: '网格下边界；价格跌破它按 boundaryAction 处理' },
  { key: 'upperPrice', label: '上限价', type: 'number', default: 110_000, min: 1e-6, max: 1e9, step: 1, help: '网格上边界' },
  { key: 'gridCount', label: '格数', type: 'integer', default: 10, min: 2, max: 200, step: 1, help: '格数（边界线 = 格数 + 1）' },
  { key: 'gridMode', label: '格距模式', type: 'select', default: 'arithmetic', options: ['arithmetic', 'geometric'], help: '等差 / 等比' },
  { key: 'gridDirection', label: '方向', type: 'select', default: 'long', options: ['long', 'short', 'neutral'], help: 'long 只做多格、short 只做空格、neutral 中线以下做多格以上做空格' },
  { key: 'qtyPerGrid', label: '每格数量', type: 'number', default: 0.001, min: 1e-8, max: 1e6, step: 1e-8, help: '每格成交的基础资产数量' },
  { key: 'boundaryAction', label: '越界处理', type: 'select', default: 'pause', options: ['pause', 'stop_loss', 'hold'], help: 'pause 停止新开格、stop_loss 按当根收盘全部平仓后停机（与 QD 一致）、hold 只记录继续跑现有格' },
  { key: 'stopLossPct', label: '持仓止损(%)', type: 'number', default: 10, min: 0, max: 90, step: 0.5, help: '按持仓收益率止损；0 关闭' },
  { key: 'maxExposureNotional', label: '最大敞口(计价币)', type: 'number', default: 10_000, min: 0.01, max: 1e12, step: 1, help: '安全上限：开仓后名义额超过它即拒单并停机；必填' },
]

interface GridCell {
  index: number
  side: 'long' | 'short'
  entry: number
  exit: number
  filled: boolean
  entryBar: number
}

export function buildGridLevels(lower: number, upper: number, cells: number, mode: string): number[] {
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower <= 0 || upper <= lower) {
    throw new BotParamError([`lowerPrice/upperPrice: need finite 0 < lowerPrice < upperPrice, got ${String(lower)} / ${String(upper)}`])
  }
  if (!Number.isInteger(cells) || cells < 1) throw new BotParamError([`gridCount: must be an integer >= 1, got ${String(cells)}`])
  const clean = (x: number): number => Number(x.toPrecision(12))
  const levels: number[] = new Array(cells + 1)
  if (mode === 'geometric') {
    const ratio = Math.pow(upper / lower, 1 / cells)
    if (!Number.isFinite(ratio) || ratio <= 1) throw new BotParamError(['gridMode: geometric grid needs upperPrice > lowerPrice > 0'])
    for (let i = 0; i <= cells; i++) levels[i] = clean(lower * Math.pow(ratio, i))
  } else if (mode === 'arithmetic') {
    const step = (upper - lower) / cells
    for (let i = 0; i <= cells; i++) levels[i] = clean(lower + step * i)
  } else {
    throw new BotParamError([`gridMode: must be arithmetic or geometric, got "${mode}"`])
  }
  levels[0] = lower
  levels[cells] = upper
  return levels
}

export class GridBot implements BotRuntime {
  readonly template = 'grid' as const
  readonly caps: BotCaps
  readonly levels: readonly number[]
  private readonly cells: GridCell[]
  private readonly ledger: PaperLedger
  private readonly qtyPerGrid: number
  private readonly direction: GridDirection
  private readonly boundary: BoundaryAction
  private readonly stopLossPct: number
  private halt: BotHalt | null = null
  private paused = false

  constructor(input: Record<string, unknown> | undefined) {
    assertSafetyDeclared('grid', GRID_PARAMS)
    requireSafetyProvided('grid', input)
    const p = requireParams(GRID_PARAMS, input)
    this.caps = capsOf('grid', p)
    const lower = numOf(p, 'lowerPrice')
    const upper = numOf(p, 'upperPrice')
    const cells = intOf(p, 'gridCount')
    const mode = strOf(p, 'gridMode')
    this.direction = strOf(p, 'gridDirection') as GridDirection
    this.boundary = strOf(p, 'boundaryAction') as BoundaryAction
    this.qtyPerGrid = numOf(p, 'qtyPerGrid')
    this.stopLossPct = numOf(p, 'stopLossPct')
    if (upper <= lower) throw new BotParamError(['upperPrice: must be greater than lowerPrice'])
    if (mode === 'geometric' && lower <= 0) throw new BotParamError(['lowerPrice: geometric grid needs a positive lower bound'])
    if (this.qtyPerGrid * upper > this.caps.maxExposureNotional + 1e-9) {
      throw new BotParamError([
        `qtyPerGrid: one grid cell (${this.qtyPerGrid} @ ${upper}) would already exceed maxExposureNotional ${this.caps.maxExposureNotional}`,
        'qtyPerGrid: lower qtyPerGrid or raise maxExposureNotional',
      ])
    }
    this.levels = buildGridLevels(lower, upper, cells, mode)
    this.cells = buildCells(this.levels, this.direction)
    this.ledger = new PaperLedger({ allowShort: this.direction !== 'long' })
  }

  onBar(ctx: BotContext): OrderIntent[] {
    this.assertState()
    if (this.halt) return []
    const bar = ctx.bar
    const price = bar.c
    const out = lowHighVerdict(price, this.levels[0] as number, this.levels[this.levels.length - 1] as number)
    if (!out.out) this.paused = false

    const triggered = this.direction === 'long' ? out.below : this.direction === 'short' ? out.above : out.out
    let blockOpens = false
    if (triggered) {
      if (this.boundary === 'stop_loss') {
        this.halt = { code: 'grid-boundary', detail: `close ${price} outside [${out.lower}, ${out.upper}]` }
        if (this.ledger.position !== 0) return [closeAllIntent(this.ledger, price, 'grid-boundary-stop')]
        return []
      }
      blockOpens = true
      if (this.boundary === 'pause') this.paused = true
    }

    if (this.halt === null && stopLossHit(this.ledger, price, this.stopLossPct)) {
      this.halt = { code: 'stop-loss', detail: `position return ${this.ledger.returnPct(price).toFixed(4)}% hit stopLossPct ${this.stopLossPct}` }
      return [closeAllIntent(this.ledger, price, 'grid-stop-loss')]
    }

    const intents: OrderIntent[] = []
    // 先平格：已成交的格到达平仓线就平（同一根 K 线内不来回）
    for (const cell of this.cells) {
      if (!cell.filled || ctx.i <= cell.entryBar) continue
      if (cell.side === 'long' && bar.h >= cell.exit) {
        intents.push({ side: 'sell', price: cell.exit, qty: this.qtyPerGrid, reason: `grid-close:${cell.index}` })
      } else if (cell.side === 'short' && bar.l <= cell.exit) {
        intents.push({ side: 'buy', price: cell.exit, qty: this.qtyPerGrid, reason: `grid-close:${cell.index}` })
      }
    }
    if (blockOpens || this.paused) return intents

    // 再开格：必须「本根 K 线穿越开仓线」——参考价（上一根收盘，首根用开盘）在线的另一侧。
    // 否则价格在区间中部会一次把下方所有格都当成已穿越（QD 的下单在引擎里同样按跨越判定）。
    const ref = ctx.prev ? ctx.prev.c : bar.o
    let pending = this.ledger.position
    for (const cell of this.cells) {
      if (cell.filled) continue
      const longTouch = cell.side === 'long' && ref > cell.entry && bar.l <= cell.entry
      const shortTouch = cell.side === 'short' && ref < cell.entry && bar.h >= cell.entry
      if (!longTouch && !shortTouch) continue
      const signed = cell.side === 'long' ? this.qtyPerGrid : -this.qtyPerGrid
      const verdict = checkExposure(this.caps, pending, cell.entry, signed)
      if (!verdict.ok) {
        this.halt = { code: verdict.code, detail: verdict.detail }
        break
      }
      pending += signed
      const intent: OrderIntent = {
        side: cell.side === 'long' ? 'buy' : 'sell',
        price: cell.entry,
        qty: this.qtyPerGrid,
        reason: `grid-open:${cell.index}`,
      }
      assertIntent(intent)
      intents.push(intent)
    }
    return intents
  }

  onFill(fill: BotFill): void {
    this.assertState()
    if (!fill.reason.startsWith('grid-open:') && !fill.reason.startsWith('grid-close:')) {
      // 止损平仓单不带格号：只记账；仓位归零后所有格回到未成交（否则状态自检会发现「格已满而仓位为 0」）
      this.ledger.apply(fill.side, fill.price, fill.qty, fill.feeRate)
      this.ledger.assertConsistent()
      if (this.ledger.position === 0) {
        for (const cell of this.cells) {
          cell.filled = false
          cell.entryBar = -1
        }
      }
      return
    }
    const index = Number(fill.reason.split(':')[1])
    const cell = Number.isInteger(index) ? this.cells[index] : undefined
    if (!cell) throw new BotStateError('grid-cell-state-unreadable', `fill refers to unknown grid cell "${fill.reason}"`)
    this.ledger.apply(fill.side, fill.price, fill.qty, fill.feeRate)
    this.ledger.assertConsistent()
    if (fill.reason.startsWith('grid-open:')) {
      if (cell.filled) throw new BotStateError('grid-cell-state-unreadable', `grid cell ${index} was already filled`)
      if (Math.abs(fill.price - cell.entry) > 1e-9 * Math.max(1, cell.entry)) {
        throw new BotStateError('grid-cell-state-unreadable', `grid cell ${index} entry ${cell.entry} but fill at ${fill.price}`)
      }
      cell.filled = true
      cell.entryBar = fill.i
    } else {
      if (!cell.filled) throw new BotStateError('grid-cell-state-unreadable', `grid cell ${index} closed while idle`)
      cell.filled = false
      cell.entryBar = -1
    }
  }

  snapshot(price: number): BotSnapshot {
    this.assertState()
    const filled = this.cells.filter((c) => c.filled).length
    return {
      template: 'grid',
      position: this.ledger.position,
      avgEntry: this.ledger.avgEntry,
      realizedPnl: this.ledger.realizedPnl,
      fees: this.ledger.fees,
      exposure: this.ledger.exposure(price),
      halted: this.halt,
      detail: { cells: this.cells.length, filledCells: filled, direction: this.direction, boundaryAction: this.boundary, paused: this.paused, levels: this.levels.length },
    }
  }

  equity(price: number, initialCash: number): number {
    return this.ledger.equity(price, initialCash)
  }

  /** 状态自检：格状态与账本必须互相对得上；对不上就抛，不返回「看起来正常」的快照。 */
  private assertState(): void {
    if (this.levels.length !== this.cells.length + 1) {
      throw new BotStateError('grid-cell-state-unreadable', `levels ${this.levels.length} vs cells ${this.cells.length}`)
    }
    for (const cell of this.cells) {
      const expectedEntry = cell.side === 'long' ? this.levels[cell.index] : this.levels[cell.index + 1]
      const expectedExit = cell.side === 'long' ? this.levels[cell.index + 1] : this.levels[cell.index]
      if (!Number.isFinite(cell.entry) || !Number.isFinite(cell.exit) || expectedEntry === undefined || expectedExit === undefined) {
        throw new BotStateError('grid-cell-state-unreadable', `grid cell ${cell.index} has a non-finite level`)
      }
      if (Math.abs(cell.entry - expectedEntry) > 1e-9 * Math.max(1, expectedEntry) || Math.abs(cell.exit - expectedExit) > 1e-9 * Math.max(1, expectedExit)) {
        throw new BotStateError('grid-cell-state-unreadable', `grid cell ${cell.index} drifted from its level (entry ${cell.entry} exit ${cell.exit})`)
      }
    }
    this.ledger.assertConsistent()
    const filled = this.cells.filter((c) => c.filled).length
    if (this.direction !== 'neutral') {
      const held = filled * this.qtyPerGrid
      if (Math.abs(Math.abs(this.ledger.position) - held) > 1e-9 * Math.max(1, held)) {
        throw new BotStateError('ledger-inconsistent', `grid holds ${this.ledger.position} but ${filled} filled cells expect ${held}`)
      }
    }
  }
}

function buildCells(levels: readonly number[], direction: GridDirection): GridCell[] {
  const cells: GridCell[] = []
  const count = levels.length - 1
  const mid = Math.floor(count / 2)
  for (let i = 0; i < count; i++) {
    const lo = levels[i]
    const hi = levels[i + 1]
    if (lo === undefined || hi === undefined) throw new BotStateError('grid-cell-state-unreadable', `missing level for cell ${i}`)
    const side: 'long' | 'short' = direction === 'long' ? 'long' : direction === 'short' ? 'short' : i < mid ? 'long' : 'short'
    cells.push({ index: i, side, entry: side === 'long' ? lo : hi, exit: side === 'long' ? hi : lo, filled: false, entryBar: -1 })
  }
  return cells
}

function lowHighVerdict(price: number, lower: number, upper: number): { out: boolean; below: boolean; above: boolean; lower: number; upper: number } {
  if (!Number.isFinite(price) || price <= 0) {
    throw new BotStateError('candle-invalid', `bar close must be a finite positive number, got ${String(price)}`)
  }
  return { out: price < lower || price > upper, below: price < lower, above: price > upper, lower, upper }
}
