// SPDX-License-Identifier: Apache-2.0
// Run the GEP conformance suite against the Python reference engine in this folder.
// Usage (from the repository root): node packages/protocol/examples/python-engine/run-conformance.mjs
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const enginePath = join(here, 'engine.py')

// The suite spawns the engine itself and injects the token via GITRADER_GEP_TOKEN.
process.env.GEP_LAUNCH = JSON.stringify({ command: 'python', args: [enginePath], cwd: here })

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', '../../vitest.config.ts', '--root', 'packages/protocol', 'conformance', '--fileParallelism=false'],
  { stdio: 'inherit', cwd: process.cwd() },
)

process.exit(result.status ?? 1)
