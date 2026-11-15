// SPDX-License-Identifier: Apache-2.0
// Build the Go reference engine and run the GEP conformance suite against it.
// Usage (from the repository root): node packages/protocol/examples/go-engine/run-conformance.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// `go` is the only prerequisite. Without it there is nothing to measure.
const probe = spawnSync('go', ['version'], { encoding: 'utf8' })
if (probe.error || probe.status !== 0) {
  console.error('go-engine: `go` was not found on PATH, so the reference engine cannot be built (install Go >= 1.22)')
  process.exit(3)
}

// Build into a temporary directory: no binary is ever written inside the repository.
const outDir = mkdtempSync(join(tmpdir(), 'gitrader-go-engine-'))
const binary = join(outDir, process.platform === 'win32' ? 'go-engine.exe' : 'go-engine')
const build = spawnSync('go', ['build', '-o', binary, '.'], { cwd: here, stdio: 'inherit' })
if (build.error || build.status !== 0) {
  console.error('go-engine: `go build` failed; the conformance suite was not run')
  rmSync(outDir, { recursive: true, force: true })
  process.exit(build.status ?? 1)
}

// The suite spawns the binary itself and injects the token via GITRADER_GEP_TOKEN.
process.env.GEP_LAUNCH = JSON.stringify({ command: binary, args: [], cwd: here })

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', '../../vitest.config.ts', '--root', 'packages/protocol', 'conformance', '--fileParallelism=false'],
  { stdio: 'inherit', cwd: process.cwd() },
)

rmSync(outDir, { recursive: true, force: true })
process.exit(result.status ?? 1)
