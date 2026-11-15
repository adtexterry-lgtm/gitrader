// SPDX-License-Identifier: CPAL-1.0
// 金标对比脚本（T7 验收第三条）：
//   cd packages/engine-core && node test/fill-modes/check-golden.mjs          在 packages/engine-core 目录下运行，退出码 0 = 缺省 bar 模式逐字节一致
// 做的事：用共享 vitest 配置跑 test/fill-modes/golden.test.ts（10 个教学示例策略 × 全量回测输出，逐字节比对
// test/fixtures/fill-mode-golden.bar.json）。比对逻辑只有一处，避免脚本与测试两套口径。
// 参数原样透传给 vitest（例如 --reporter=verbose）。
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..', '..')
const repoRoot = resolve(pkgRoot, '..', '..')
const vitest = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')
const config = join(repoRoot, 'vitest.config.ts')

const run = spawnSync(
  process.execPath,
  [vitest, 'run', '--config', config, '--root', pkgRoot, 'test/fill-modes/golden.test.ts', ...process.argv.slice(2)],
  { cwd: pkgRoot, stdio: 'inherit' },
)

if (run.error !== undefined) {
  console.error(`金标比对没能跑起来：${run.error.message}`)
  process.exit(2)
}
if (run.status === 0) console.log('GOLDEN OK：缺省 fillMode=bar 的输出与金标夹具逐字节一致')
process.exit(run.status ?? 1)
