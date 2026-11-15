// SPDX-License-Identifier: CPAL-1.0
// Run the GEP conformance suite against this package's Python engine.
// Usage (from the repository root): node packages/engine-python/run-conformance.mjs
//
// The suite spawns the engine itself over stdio (NDJSON) and injects the one-time
// token via GITRADER_GEP_TOKEN. No network, no npm script, no build step.
//
// Exit codes: 0 all good, 1 the suite failed, 3 no usable Python interpreter,
// 4 the suite ran but the strategy.* / backtest.* optional cases (O1-O4) did not
// all pass — this package's acceptance requires those groups, not just T01-T26.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const engineMain = join(here, 'engine', 'main.py')
const python = process.env['GEP_PYTHON'] ?? 'python'
const casesThatMustPass = ['O1', 'O2', 'O3', 'O4']

if (!existsSync(engineMain)) {
  console.error(`run-conformance: ${engineMain} is missing`)
  process.exit(3)
}

const probe = spawnSync(python, ['--version'], { encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
  console.error(`run-conformance: cannot run "${python}" (set GEP_PYTHON to a Python 3.11+ interpreter)`)
  console.error(String(probe.error ?? probe.stderr ?? '').trim())
  process.exit(3)
}

const reportPath = join(tmpdir(), `gep-conformance-engine-python-${process.pid}.json`)
try { unlinkSync(reportPath) } catch { /* first run */ }

process.env['GEP_LAUNCH'] = JSON.stringify({ command: python, args: [engineMain], cwd: here })
process.env['GEP_REPORT_PATH'] = reportPath

console.log(`run-conformance: ${(probe.stdout ?? '').trim()} + ${engineMain}`)
const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', '../../vitest.config.ts', '--root', 'packages/protocol', 'conformance', '--fileParallelism=false'],
  { stdio: 'inherit', cwd: repoRoot },
)

let report
if (existsSync(reportPath)) {
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')) } catch { report = undefined }
}

if (report?.summary) {
  const { pass, skip, fail } = report.summary
  console.log(`\nrun-conformance: pass ${pass} / skip ${skip} / fail ${fail} (engine: ${report.target})`)
  const byId = new Map((report.results ?? []).map((r) => [r.id, r]))
  const required = casesThatMustPass.map((id) => byId.get(id) ?? { id, status: 'missing' })
  for (const r of required) console.log(`  ${r.id}: ${r.status}${r.note ? ` — ${r.note}` : ''}`)
  const bad = required.filter((r) => r.status !== 'pass')
  if (fail > 0 || bad.length > 0) {
    try { unlinkSync(reportPath) } catch { /* ignore */ }
    console.error(`run-conformance: the strategy.* / backtest.* optional groups must pass (missing: ${bad.map((r) => r.id).join(', ') || 'none'})`)
    process.exit(fail > 0 ? (result.status ?? 1) : 4)
  }
  try { unlinkSync(reportPath) } catch { /* ignore */ }
} else {
  console.error('run-conformance: no JSON report was written; the suite did not run to completion')
}

process.exit(result.status ?? 1)
