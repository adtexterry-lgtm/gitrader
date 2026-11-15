// SPDX-License-Identifier: CPAL-1.0
// 能力预检：内核纸面模式今天能不能用「历史数据 + 模拟时钟」回放？
// 做法：只读仓库源码，按「必须存在的接线」逐条查，给出 file:line 证据。
// 结论只有两种：ok（能跑一致性比对）/ stop（停机，只交差异表格式与回测一侧产出）。
//
// 停机判定标准（本测试台的判据，写进 FORMAT.md）：
//   要有至少一条**公开接口**能把「历史行情 + 模拟时钟」喂进内核纸面模式：
//   CLI 参数 / gitrader.json 配置键 / GEP 方法 / 构造注入，四者之一即可。
//   只有包内测试夹具能用、CLI 与配置都开不出这条路 → 判 stop（用户拿不到，等于没有）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const read = (root, rel) => {
  try { return readFileSync(join(root, rel), 'utf8') } catch { return null }
}

/** 找到 pattern 在文本里的行号（1 起）；没有返回 0。 */
function lineOf(text, pattern) {
  if (!text) return 0
  const lines = text.split(/\r?\n/)
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern)
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1
  return 0
}

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs')) out.push(p)
  }
  return out
}

/** 在若干目录里查一个标记，返回命中处 [{file, line}]。 */
function scan(root, dirs, marker) {
  const hits = []
  const re = marker instanceof RegExp ? marker : new RegExp(marker)
  for (const dir of dirs) {
    const abs = join(root, dir)
    let st
    try { st = statSync(abs) } catch { continue }
    const files = st.isDirectory() ? walk(abs) : [abs]
    for (const f of files) {
      let text = ''
      try { text = readFileSync(f, 'utf8') } catch { continue }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) hits.push({ file: relative(root, f).replace(/\\/g, '/'), line: i + 1 })
      }
    }
  }
  return hits
}

/**
 * 探查一个仓库根目录。纯函数（只读文件），测试可对临时夹具仓库跑。
 * @returns {{ verdict:'ok'|'stop', checks: object[], missing: object[], capabilityMatrix: object }}
 */
export function probeRepo(root) {
  const checks = []
  const add = (id, ok, evidence, detail) => checks.push({ id, ok, evidence, detail })

  // 1. CLI 构造纸面场所时用的时钟（锚到 `new PaperVenue(` 那一处，别被前置连接器的同名写法骗到）
  const cliConnectors = read(root, 'packages/cli/src/connectors.ts')
  const paperCtorLine = lineOf(cliConnectors, /new PaperVenue\(/)
  const paperCtor = paperCtorLine > 0 ? cliConnectors.split(/\r?\n/).slice(paperCtorLine - 1, paperCtorLine + 2).join('\n') : ''
  const paperClockSystem = /clock:\s*\(\)\s*=>\s*k\.clock\.now\(\)/.test(paperCtor)
  add('paper-clock-injection', paperCtorLine > 0 && !paperClockSystem,
    paperCtorLine > 0 ? `packages/cli/src/connectors.ts:${paperCtorLine}` : 'packages/cli/src/connectors.ts (未找到 new PaperVenue)',
    paperCtorLine > 0 && paperClockSystem
      ? '纸面场所的时钟硬接内核系统时钟（k.clock.now()）：CLI 没有任何入口把它换成模拟时钟'
      : paperCtorLine > 0
        ? '纸面场所的构造处没有可识别的系统时钟注入（需人工重读 cli/src/connectors.ts）'
        : '未找到纸面场所的构造点（内核结构可能已变，需重读 cli/src）')

  // 2. 内核 / CLI 是否构造回放行情源
  const replayInKernel = scan(root, ['packages/kernel/src', 'packages/cli/src'], /\bReplayMarket\b|runReplay\s*\(/)
  add('kernel-replay-market-wiring', replayInKernel.length > 0,
    replayInKernel.length > 0 ? `${replayInKernel[0].file}:${replayInKernel[0].line}` : 'packages/kernel/src, packages/cli/src (0 处)',
    '内核与 CLI 都不构造 ReplayMarket / 不调用 runReplay：回放能力只活在 venue-paper 自己的测试里')

  // 3. 配置是否有回放 / 历史数据源键
  const configText = read(root, 'packages/kernel/src/config.ts')
  const configReplay = lineOf(configText, /\breplay\b|\bdataSource\b|\bmarketData\b/i)
  add('config-replay-knob', configReplay > 0, configReplay > 0 ? `packages/kernel/src/config.ts:${configReplay}` : 'packages/kernel/src/config.ts (无 replay / dataSource / marketData 键)',
    'gitrader.json 里没有回放或历史数据源配置键：用户无法通过配置开纸面回放')

  // 4. GEP 方法表是否有纸面回放方法
  const methodsText = read(root, 'packages/protocol/src/gep/methods.ts')
  const gepPaperReplay = lineOf(methodsText, /'paper\.(replay|startReplay)/)
  add('gep-paper-replay-method', gepPaperReplay > 0, gepPaperReplay > 0 ? `packages/protocol/src/gep/methods.ts:${gepPaperReplay}` : 'packages/protocol/src/gep/methods.ts (无 paper.* 方法)',
    '协议方法表里没有让宿主驱动纸面回放的方法（replay.start 是引擎侧历史回放，见下一条）')

  // 5. venue-paper 自身有没有回放能力（库级）
  const replayText = read(root, 'packages/venue-paper/src/replay.ts')
  const runReplayLine = lineOf(replayText, /export async function runReplay/)
  const replayMarketLine = lineOf(replayText, /export class ReplayMarket/)
  add('venue-paper-replay-capability', runReplayLine > 0 && replayMarketLine > 0,
    runReplayLine > 0 ? `packages/venue-paper/src/replay.ts:${replayMarketLine},${runReplayLine}` : 'packages/venue-paper/src/replay.ts (未找到)',
    '库级能力存在：ReplayMarket + runReplay 能按帧推进盘口并驱动 PaperVenue；缺的只是把它接到 CLI / 配置的入口')

  // 6. 引擎侧 replay.start 是否独立于回测
  const engineReplay = read(root, 'packages/engine-core/src/runtime/replay.ts')
  const simLine = lineOf(engineReplay, /new Simulator\(/)
  const sameSimulator = simLine > 0
  add('engine-replay-independence', !sameSimulator,
    sameSimulator ? `packages/engine-core/src/runtime/replay.ts:${simLine}` : 'packages/engine-core/src/runtime/replay.ts (未找到 Simulator)',
    sameSimulator
      ? 'GEP replay.start 复用回测同一个 Simulator（成交模型 next-bar-open）：它是「防前视偏差」的自我复核，与回测同源，量不出纸面偏差'
      : '未找到 Simulator 复用；需重读引擎回放实现')

  const okIds = ['paper-clock-injection', 'kernel-replay-market-wiring', 'config-replay-knob', 'gep-paper-replay-method']
  const verdict = okIds.every((id) => checks.find((c) => c.id === id)?.ok) ? 'ok' : 'stop'

  const missing = []
  if (!checks.find((c) => c.id === 'config-replay-knob')?.ok) {
    missing.push({
      what: 'gitrader.json 增加 accounts[].mode=paper 的回放数据源（回放夹具路径 + 模拟时钟开关）',
      where: 'packages/kernel/src/config.ts（ConfigAccount / ConfigVenue 旁）',
      why: '让用户用配置文件就能开纸面回放，不用改代码；配置校验同时拦住「paper + 回放 + 实盘连接器」这种混搭',
    })
  }
  if (!checks.find((c) => c.id === 'kernel-replay-market-wiring')?.ok) {
    missing.push({
      what: '纸面场所改用 ReplayMarket 并把 clock 接到回放时间（CLI 分支）',
      where: 'packages/cli/src/connectors.ts（PaperVenue 构造处，见第 1 条证据行）',
      why: '这是「历史数据 + 模拟时钟」进内核的唯一入口；回放模式下还应关掉 paper.start(1000) 的实时 tick，改由回放循环 tick',
    })
  }
  if (!checks.find((c) => c.id === 'gep-paper-replay-method')?.ok) {
    missing.push({
      what: 'GEP 增一个宿主驱动纸面回放的方法（建议 paper.replay.start / status / stop，返回进度与当前回放时刻）',
      where: 'packages/protocol/src/gep/methods.ts + packages/kernel/src/gep-host.ts CALLABLE 白名单',
      why: '让 Agent 与测试台能经公开接口启动 / 观测 / 停止回放，而不是靠内部构造',
    })
  }
  if (!checks.find((c) => c.id === 'engine-replay-independence')?.ok) {
    missing.push({
      what: '独立的纸面成交模型（或明确接受「纸面=回测」的自证）',
      where: 'packages/engine-core/src/runtime/replay.ts（现复用 Simulator）',
      why: '同一份成交模型跑两遍得到「一致」是自证；一致性测试台要量的是两套模型之间的偏差',
    })
  }

  return {
    verdict,
    checks,
    missing,
    capabilityMatrix: {
      'kernel paper mode': true,
      'kernel paper + historical replay': false,
      'kernel paper + simulated clock': false,
      'venue-paper ReplayMarket (library)': true,
      'engine GEP replay.start (self-check, same simulator)': true,
      'backtest via GEP backtest.run (files source)': true,
    },
  }
}
