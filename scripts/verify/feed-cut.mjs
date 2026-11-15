// SPDX-License-Identifier: CPAL-1.0
// Local fixture feed only. Interactive: cut / restore / status / quit; --check runs one finite cycle.
import { createInterface } from 'node:readline'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { startStage } from './stage-lib.mjs'

const excluded = new Set([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831])
async function freePort() {
  for (;;) {
    const server = createServer()
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, 'localhost', ok) })
    const { port } = server.address()
    await new Promise((ok) => server.close(ok))
    if (!excluded.has(port) && !(port >= 47900 && port <= 49999)) return port
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'gitrader-feed-cut-'))
let stage
let input
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  input?.close()
  if (stage) await stage.stop() // Only the child owned by this script.
  if (resolve(tmp).startsWith(resolve(tmpdir()) + sep)) rmSync(tmp, { recursive: true, force: true })
}
try {
  stage = await startStage({ tmp, home: process.env.GITRADER_HOME || join(tmp, 'home'), port: await freePort(), env: { GITRADER_STAGE_NO_ENGINE: '1' } })
  await stage.run(`
    const quote = hl.quote.bind(hl), mark = hl.mark.bind(hl), status = hl.status.bind(hl);
    ctx.feedCut = false;
    hl.quote = (...args) => ctx.feedCut ? undefined : quote(...args);
    hl.mark = (...args) => ctx.feedCut ? undefined : mark(...args);
    hl.status = () => ctx.feedCut ? { ...status(), wsState: 'disconnected', stale: true, source: 'none' } : status();
    return true;
  `)
  const change = async (cut) => {
    await stage.run(`ctx.feedCut = ${cut}; ctx.paused = ${cut}; return true`)
    console.log(cut ? '行情已切断，内核继续运行' : '行情已恢复，等待新报价')
  }
  const inspect = () => stage.run(`return { cut: ctx.feedCut, state: hl.status().wsState, hasQuote: !!hl.quote('hyperliquid:BTC') }`)
  if (process.argv.includes('--check')) {
    await new Promise((ok) => setTimeout(ok, 1500))
    const before = await inspect()
    await change(true)
    const cut = await inspect()
    await change(false)
    await new Promise((ok) => setTimeout(ok, 1500))
    const after = await inspect()
    if (!before.hasQuote || cut.hasQuote || cut.state !== 'disconnected' || !after.hasQuote) throw new Error('feed cycle failed')
    console.log('PASS：真实隔离内核中的行情切断与恢复；未包含浏览器验收')
  } else {
    console.log('隔离内核已启动。输入 cut / restore / status / quit。需要界面时，启动前把 GITRADER_HOME 指向专用测试目录，再在同一环境运行 gitrader open。')
    process.once('SIGINT', () => { void stop().finally(() => process.exit(0)) })
    process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)) })
    input = createInterface({ input: process.stdin, output: process.stdout })
    for await (const line of input) {
      const command = line.trim()
      if (command === 'quit') break
      if (command === 'cut') await change(true)
      else if (command === 'restore') await change(false)
      else if (command === 'status') console.log(JSON.stringify(await inspect()))
      else console.log('可用命令：cut / restore / status / quit')
    }
  }
} catch {
  console.error('FAIL：隔离行情验收未完成；检查依赖、沙箱子进程权限及本地测试配置')
  process.exitCode = 1
} finally {
  await stop()
}
