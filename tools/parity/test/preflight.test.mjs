// SPDX-License-Identifier: CPAL-1.0
// 能力预检：对真仓库断言「停机」结论与证据行；对合成夹具仓库断言「可跑」。
// 合成仓库只造 preflight 需要的那几个文件，不复制真仓库代码。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { probeRepo } from '../lib/preflight.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')

function writeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'parity-preflight-'))
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
  return root
}

test('真仓库：判 stop，且证据行指到 CLI 的 PaperVenue 构造处与 venue-paper 的库级回放', () => {
  const p = probeRepo(REPO)
  assert.equal(p.verdict, 'stop')
  const clock = p.checks.find((c) => c.id === 'paper-clock-injection')
  assert.equal(clock.ok, false)
  assert.match(clock.evidence, /packages\/cli\/src\/connectors\.ts:\d+/)
  const lib = p.checks.find((c) => c.id === 'venue-paper-replay-capability')
  assert.equal(lib.ok, true)
  assert.match(lib.evidence, /packages\/venue-paper\/src\/replay\.ts:\d+,\d+/)
  assert.equal(p.checks.find((c) => c.id === 'engine-replay-independence').ok, false)
})

test('真仓库：缺项清单四条，每条带「建议位置」，不写代码只写位置', () => {
  const p = probeRepo(REPO)
  assert.equal(p.missing.length, 4)
  for (const m of p.missing) {
    assert.ok(m.what.length > 5)
    assert.match(m.where, /packages\//)
    assert.ok(m.why.length > 5)
  }
  assert.ok(p.missing.some((m) => m.where.includes('packages/cli/src/connectors.ts')))
  assert.ok(p.missing.some((m) => m.where.includes('packages/protocol/src/gep/methods.ts')))
})

test('真仓库：能力矩阵如实写「库级有、内核没有」', () => {
  const p = probeRepo(REPO)
  assert.equal(p.capabilityMatrix['kernel paper + historical replay'], false)
  assert.equal(p.capabilityMatrix['venue-paper ReplayMarket (library)'], true)
  assert.equal(p.capabilityMatrix['backtest via GEP backtest.run (files source)'], true)
})

test('合成仓库：CLI 用回放行情源 + 配置有回放键 + 协议有 paper.replay 方法 → 判 ok，缺项为空', () => {
  const root = writeRepo({
    'packages/cli/src/connectors.ts': [
      'const paper = new PaperVenue({ market: replayMarket, clock: () => replay.now() })',
      'const replayMarket = new ReplayMarket(instruments, frames, caps)',
    ].join('\n'),
    'packages/kernel/src/config.ts': 'export interface ConfigAccount { replay?: { fixture: string; clock: "simulated" } }',
    'packages/protocol/src/gep/methods.ts': "'paper.replay.start': MethodSpec<{ fixture: string }, { replayId: string }>",
    'packages/venue-paper/src/replay.ts': 'export class ReplayMarket {}\nexport async function runReplay() {}',
    'packages/engine-core/src/runtime/replay.ts': 'const sim = new Simulator()',
  })
  const p = probeRepo(root)
  assert.equal(p.verdict, 'ok')
  assert.equal(p.missing.length, 1) // 只剩「引擎回放复用同一 Simulator」这一条独立性缺失
  assert.equal(p.missing[0].where.includes('engine-core'), true)
})

test('合成仓库：CLI 里压根没有 PaperVenue → 判 stop 且证据写「未找到」', () => {
  const root = writeRepo({ 'packages/cli/src/connectors.ts': 'export const nothing = 1\n' })
  const p = probeRepo(root)
  assert.equal(p.verdict, 'stop')
  assert.match(p.checks.find((c) => c.id === 'paper-clock-injection').evidence, /未找到/)
  // 夹具里没有任何引擎文件，所以「引擎回放独立性」那条查不出问题，缺项是 3 条而不是 4 条
  assert.equal(p.missing.length, 3)
  assert.ok(p.missing.some((m) => m.where.includes('packages/cli/src/connectors.ts')))
})
