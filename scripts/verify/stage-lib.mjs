// SPDX-License-Identifier: CPAL-1.0
// 集成验收公共件（H）：把 stage-host.ts 打成临时 ESM、在隔离 GITRADER_HOME 里起"真内核 + 夹具行情"，并提供无头浏览器。
// 端口：默认从 47900 起由内核自己探测（避开 8765/8188/9872/9222/8080/5198/4184/14609/47831）。只结束自己 spawn 的进程（按句柄）。
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const RESERVED = [8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831]
const REQUIRE_BANNER = "import { createRequire as __gtCreateRequire } from 'node:module'; const require = __gtCreateRequire(import.meta.url);"

/** 开发机上的 playwright-core（只在验收脚本里用，不进产品包）。GITRADER_PLAYWRIGHT / GITRADER_EDGE 覆盖。 */
export function chromium() {
  const pw = process.env.GITRADER_PLAYWRIGHT
  if (!pw) throw new Error('set GITRADER_PLAYWRIGHT to a playwright-core directory')
  return createRequire(import.meta.url)(pw).chromium
}
export const EDGE = process.env.GITRADER_EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

export async function bundleHost(outDir) {
  const out = join(outDir, 'stage-host.mjs')
  await build({ absWorkingDir: root, entryPoints: [join(root, 'scripts', 'verify', 'stage-host.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: out, banner: { js: REQUIRE_BANNER }, external: ['node:*'], logLevel: 'error' })
  return out
}

/** 起一个舞台。opts.home 给定则复用（关掉再开的旅程用）。 */
export async function startStage(opts = {}) {
  const tmp = opts.tmp ?? mkdtempSync(join(tmpdir(), 'gitrader-h-'))
  const home = opts.home ?? join(tmp, 'home')
  mkdirSync(home, { recursive: true })
  const hostFile = opts.hostFile ?? await bundleHost(tmp)
  const staticDir = opts.staticDir ?? join(root, 'packages', 'workbench', 'dist')
  const args = [hostFile, home, join(root, 'fixtures', 'hl'), staticDir, opts.port ? String(opts.port) : '', String(opts.tickMs ?? 250)]
  const t0 = performance.now()
  const proc = spawn(process.execPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GITRADER_HOME: home, ...(opts.env ?? {}) } })
  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d.toString() })
  const lines = []
  const waiters = []
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let o; try { o = JSON.parse(line) } catch { return }
    lines.push(o)
    for (const w of waiters.splice(0)) { if (w.pred(o)) w.res(o); else waiters.push(w) }
  })
  const next = (pred, ms = 20000) => new Promise((res, rej) => {
    const f = lines.find(pred); if (f) return res(f)
    const t = setTimeout(() => rej(new Error(`timeout waiting for stage host\n${stderr.slice(-1500)}`)), ms)
    waiters.push({ pred, res: (v) => { clearTimeout(t); res(v) } })
  })
  const ready = await next((o) => o.ready)
  const readyMs = performance.now() - t0
  let id = 0
  const call = async (cmd, code, ms) => { const my = ++id; proc.stdin.write(JSON.stringify({ id: my, cmd, code }) + '\n'); const r = await next((o) => o.id === my, ms); if (r.error) throw new Error(r.error); return r }
  return {
    tmp, home, port: ready.port, pid: ready.pid, url: ready.url, readyMs, proc,
    get stderr() { return stderr },
    boot: async () => (await call('boot')).url,
    run: async (code, ms) => (await call('run', code, ms)).result,
    stop: async () => {
      if (proc.exitCode !== null) return
      try { await call('stop', undefined, 8000) } catch { /* 兜底 */ }
      await new Promise((r) => setTimeout(r, 200))
      if (proc.exitCode === null) proc.kill()
    },
    cleanup: () => { if (!opts.keep) rmSync(tmp, { recursive: true, force: true }) },
  }
}

export function checker() {
  const results = []
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 600) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + String(detail).slice(0, 400) : detail ? '  · ' + String(detail).slice(0, 200) : ''}`) }
  return { results, check }
}

export const BANNED = /Comfy|WalletConnect|保守|激进|标准档|有限开源|FSL|\bPro\b|稳赚|跑赢/
