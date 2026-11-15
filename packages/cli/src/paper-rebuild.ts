// SPDX-License-Identifier: CPAL-1.0
// fix-r2 S1（ADR-16）：`gitrader paper rebuild-from-ledger [--yes]`——纸面状态文件被删 / 截断 / 改过时，按账本重建（账本是真源）。
// 只在服务停着时运行；原文件改名留底（不删）；记账用纸面场所同一套算法（PaperVenue.rebuildFromLedgerFacts）。
import { PaperVenue } from '@gitrader/venue-paper'
import type { PaperMarket, PaperRebuildFacts as VenueFacts } from '@gitrader/venue-paper'
import { rebuildPaperStateFromLedger } from '@gitrader/kernel'
import type { PaperRebuildFacts } from '@gitrader/kernel'
import { liveService, openKernel } from './index'
import type { Args, CliIo } from './index'

const CONFIRM_PHRASE = '我确认重建'
type LineReader = CliIo & { readLine?: (prompt: string) => Promise<string> }

/** 离线记账用的行情桩：重建只需要账户、成交与挂单，不需要行情（标的精度缺省 8 位，成交数量本来就在刻度上）。 */
const OFFLINE_MARKET = { venue: 'kernel-sim-rebuild', environment: 'mainnet', getInstrument: () => undefined } as unknown as PaperMarket

export function paperStateFromFacts(facts: PaperRebuildFacts, now: number): string {
  const venue = new PaperVenue({ market: OFFLINE_MARKET, clock: () => now, onWarn: () => {} })
  return venue.rebuildFromLedgerFacts(facts as unknown as VenueFacts)
}

export async function cmdPaperRebuild(home: string, a: Args, io: CliIo): Promise<number> {
  if (await liveService(home)) throw new Error('先停掉 gitrader serve 再重建纸面状态（stop the running service first）')
  if (a.flags.yes !== true) {
    if (!io.interactive) { io.err('非交互运行请加 --yes：会把现在的 paper-state.json 改名留底，再按账本重建\n'); return 2 }
    io.out('按账本重建纸面状态：现在的 paper-state.json 会改名为 paper-state.json.corrupt-<时间> 留底（不删），新文件里的现金、持仓、挂单全部按账本推算。\n')
    const readLine = (io as LineReader).readLine
    const prompt = `输入「${CONFIRM_PHRASE}」继续：`
    const answer = readLine ? await readLine(prompt) : await io.readSecret(prompt)
    if (answer.trim() !== CONFIRM_PHRASE) { io.out('已取消\n'); return 1 }
  }
  const k = await openKernel(home, io)
  try {
    const r = rebuildPaperStateFromLedger(k, (facts) => paperStateFromFacts(facts, k.clock.now()))
    for (const x of r.expectations) {
      const pos = Object.entries(x.netSize).map(([id, size]) => `${id} ${size}`).join('，') || '无持仓'
      io.out(`已按账本重建 ${x.accountId}：现金 ${x.cash}（已实现 ${x.realized}，手续费 ${x.fees}，资金费 ${x.funding}），${pos}\n`)
    }
    if (r.backup) io.out(`原文件已留底：${r.backup}\n`)
    io.out('下一步：gitrader serve 重启；纸面账户若仍显示「已停止」，在工作台「风险」里输 PIN 恢复交易。\n')
    return 0
  } finally { await k.stop() }
}
