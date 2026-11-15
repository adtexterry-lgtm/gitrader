// SPDX-License-Identifier: CPAL-1.0
// 旅程 14 补充（H）：接一个"已经在跑的远程引擎"——engine-core 以 --ws 模式独立运行（模拟用户自己的服务器上的引擎），
// gitrader.json 只写 {url, auth:{method:'token', tokenRef:'env:…'}}，令牌从 serve 的环境变量取。本机 loopback ws（远程必须 wss，本脚本不联网）。
//   node scripts/verify/remote-engine.mjs   → reports/H-logs/remote-engine.json
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { root, startStage, bundleHost, checker } from './stage-lib.mjs'
const { results, check } = checker()
const tmp = mkdtempSync(join(tmpdir(), 'gitrader-hremote-'))
const TOKEN = 'remote-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
const strategies = join(tmp, 'remote-strategies'); mkdirSync(strategies, { recursive: true })
copyFileSync(join(root, 'packages', 'engine-core', 'test', 'fixtures', 'strategies', 'ema-cross.ts'), join(strategies, 'ema-cross.ts'))
const eng = spawn(process.execPath, [join(root, 'packages', 'engine-core', 'dist', 'engine-core.mjs'), '--ws', '0', '--strategies', strategies], { env: { ...process.env, GITRADER_GEP_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let S
try {
  const listening = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('engine did not start')), 15000); createInterface({ input: eng.stdout }).on('line', (l) => { try { const j = JSON.parse(l); if (j.listening) { clearTimeout(t); res(j) } } catch { /* */ } }) })
  check('远程引擎（engine-core --ws）独立启动，只听 127.0.0.1', /^ws:\/\/127\.0\.0\.1:\d+\/gep$/.test(listening.listening), listening.listening)
  S = await startStage({ tmp: join(tmp, 'stage'), hostFile: await bundleHost(tmp), env: { GITRADER_STAGE_NO_ENGINE: '1' } })
  await S.stop()
  const cfgPath = join(S.home, 'gitrader.json'); const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfg.engines.push({ id: 'remote-eng', enabled: true, launch: { url: listening.listening, auth: { method: 'token', tokenRef: 'env:MY_ENGINE_TOKEN' } } })
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  check('配置文件里没有令牌明文（只有句柄）', !readFileSync(cfgPath, 'utf8').includes(TOKEN))
  S = await startStage({ tmp: S.tmp, home: S.home, hostFile: join(tmp, 'stage-host.mjs'), env: { GITRADER_STAGE_NO_ENGINE: '1', MY_ENGINE_TOKEN: TOKEN } })
  await S.run(`k.engines.start('remote-eng'); return true`)
  let st = null
  for (let i = 0; i < 60 && !(st && st.state === 'ready'); i++) { await new Promise((r) => setTimeout(r, 250)); st = await S.run(`return k.gep.status().find((g) => g.engineId === 'remote-eng') ?? k.engines.status().find((e) => e.id === 'remote-eng')`) }
  check('内核按句柄取令牌连上远程引擎并完成 GEP 握手', st?.state === 'ready', JSON.stringify(st))
  const list = await S.run(`return await k.gep.callEngine('remote-eng', 'strategy.list', {})`).catch((e) => String(e))
  check('远程引擎上的策略可见（strategy.list）', JSON.stringify(list).includes('ema'), JSON.stringify(list).slice(0, 200))
  check('serve 的 stderr 不含远程令牌', !S.stderr.includes(TOKEN))
} catch (e) {
  check('远程引擎旅程异常', false, String(e?.stack ?? e).slice(0, 500))
} finally {
  try { await S?.stop() } catch { /* */ }
  if (eng.exitCode === null) eng.kill()
  rmSync(tmp, { recursive: true, force: true })
}
writeFileSync(join(root, 'reports', 'H-logs', 'remote-engine.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
process.exit(results.some((r) => !r.ok) ? 1 : 0)
