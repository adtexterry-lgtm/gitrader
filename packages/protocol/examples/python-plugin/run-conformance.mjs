// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const env = {
  ...process.env,
  GSP_LAUNCH: JSON.stringify({ command: process.env.GSP_PYTHON ?? 'python', args: [resolve(here, 'plugin.py')], cwd: here }),
}
delete env.GSP_ENDPOINT
const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', '../../vitest.config.ts', '--root', 'packages/protocol',
  'conformance/gsp', '--fileParallelism=false',
], { cwd: root, env, stdio: 'inherit', windowsHide: true })
process.exit(result.status ?? 1)
