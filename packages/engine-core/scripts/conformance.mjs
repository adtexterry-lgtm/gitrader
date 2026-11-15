// SPDX-License-Identifier: CPAL-1.0
// 对打包后的 engine-core 跑 GEP 一致性套件（packages/protocol/conformance）。
//   node scripts/conformance.mjs [stdio|ws|all]    默认 all
// stdio：套件每个用例起一个新进程（完整隔离；T10/T11 续传在 stdio 上无法做，显示为跳过）。
// ws：引擎要事先起好；套件的 T25 会让引擎按契约退出，同一个文件里后面的用例还要连，
//     所以由这里的小监督器在同一个端口上把它重新拉起来。
// 引擎不带策略，所以先建一个临时策略文件夹，放进测试夹具里的最小均线策略（仅用于一致性测试）。
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEngine } from '../build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = join(here, '..')
const root = join(pkg, '..', '..')
const protocol = join(root, 'packages', 'protocol')
const out = join(pkg, 'test-out')
mkdirSync(out, { recursive: true })
const mode = process.argv[2] ?? 'all'
const TOKEN = 'conformance-token'
const bundle = await buildEngine()
const strategies = mkdtempSync(join(tmpdir(), 'gep-conformance-strategies-'))
copyFileSync(join(pkg, 'test', 'fixtures', 'strategies', 'ema-cross.ts'), join(strategies, 'ema-cross.ts'))

const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
function runVitest(files, env) {
  return new Promise((resolve) => {
    const args = [vitest, 'run', '--config', '../../vitest.config.ts', '--root', '.', '--fileParallelism=false', ...files]
    const c = spawn(process.execPath, args, { cwd: protocol, env: { ...process.env, ...env }, stdio: 'inherit' })
    c.on('exit', (code) => resolve(code ?? 1))
  })
}

let failed = 0
if (mode === 'stdio' || mode === 'all') {
  const launch = { command: process.execPath, args: [bundle, '--stdio'], env: { GITRADER_STRATEGIES_DIR: strategies } }
  failed += await runVitest(
    ['conformance/required.test.ts', 'conformance/mode-a.test.ts', 'conformance/mode-b.test.ts', 'conformance/optional.test.ts'],
    { GEP_LAUNCH: JSON.stringify(launch), GEP_TOKEN: TOKEN, GEP_REPORT_PATH: join(out, 'conformance-stdio.json') },
  )
}
if (mode === 'ws' || mode === 'all') {
  const free = () => new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
  const port = await free() // 套件连这个端口（小代理）
  const inner = await free() // 引擎真正监听的端口
  let stopping = false
  let current = null
  const launch = () => {
    current = spawn(process.execPath, [bundle, '--ws', String(inner), '--strategies', strategies], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITRADER_GEP_TOKEN: TOKEN }, stdio: ['ignore', 'ignore', 'inherit'],
    })
    current.on('exit', () => { if (!stopping) setTimeout(launch, 50) })
  }
  launch()
  // 小代理：引擎重启的那几百毫秒里，新连接先挂着，等引擎回来再接上（否则 T25 之后的第一个用例会撞上 ECONNREFUSED）
  const proxy = createServer((client) => {
    const deadline = Date.now() + 8000
    const attach = () => {
      const up = connect(inner, '127.0.0.1')
      let up_ok = false
      up.once('connect', () => { up_ok = true; client.pipe(up); up.pipe(client) })
      up.on('error', () => { if (!up_ok) { if (Date.now() < deadline && !client.destroyed) setTimeout(attach, 40); else client.destroy() } })
      up.on('close', () => { if (up_ok) client.destroy() })
      client.on('close', () => up.destroy())
      client.on('error', () => up.destroy())
    }
    attach()
  })
  await new Promise((r) => proxy.listen(port, '127.0.0.1', r))
  await new Promise((r) => setTimeout(r, 800))
  failed += await runVitest(
    ['conformance/required.test.ts', 'conformance/mode-a.test.ts', 'conformance/optional.test.ts'],
    { GEP_ENDPOINT: `ws://127.0.0.1:${port}/gep`, GEP_TOKEN: TOKEN, GEP_REPORT_PATH: join(out, 'conformance-ws.json') },
  )
  stopping = true
  current?.kill()
  proxy.close()
}
process.exit(failed === 0 ? 0 : 1)
