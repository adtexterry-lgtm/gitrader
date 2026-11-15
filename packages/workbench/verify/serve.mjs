// SPDX-License-Identifier: CPAL-1.0
// 起夹具内核 + 壳（随机端口，打印 URL 与 PID，Ctrl+C 或 GET /__quit 退出），给 design/run-audit.mjs 与手工看壳用。
//   node verify/serve.mjs [--attest-flatten]
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'gr-serve-'))
const dist = join(tmp, 'dist')
const b = spawnSync(process.execPath, [resolve(here, '../build.mjs')], { env: { ...process.env, GITRADER_UI_OUT: dist }, encoding: 'utf8' })
if (b.status !== 0) { console.error(b.stderr || b.stdout); process.exit(1) }
const tdir = join(here, '.tmp')
mkdirSync(tdir, { recursive: true })
const fk = join(tdir, 'fixture-kernel-serve.mjs')
await build({ entryPoints: [join(here, 'fixture-kernel.ts')], outfile: fk, bundle: true, platform: 'node', format: 'esm', external: ['ws'], logLevel: 'silent' })
const { startFixtureKernel } = await import(pathToFileURL(fk).href)
const k = await startFixtureKernel({ staticDir: dist, workspacesDir: join(tmp, 'workspaces'), pluginsDir: resolve(here, '../../plugin-template/example'), injectAlways: true })
k.flags.attestFlatten = process.argv.includes('--attest-flatten')
console.log(`URL=${k.url}/ PID=${process.pid}`)
const stop = async () => { await k.close(); rmSync(tmp, { recursive: true, force: true }); rmSync(tdir, { recursive: true, force: true }); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
