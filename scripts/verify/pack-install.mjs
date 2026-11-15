// SPDX-License-Identifier: CPAL-1.0
// 真 CLI 装包冒烟（本单只写不跑；跑起来要联网 + 真 npm 安装，约 2~3 分钟）：
//   node scripts/verify/pack-install.mjs
// 步骤：临时目录里 `npm pack -w packages/cli` → 空目录 `npm init -y` → `npm install <tgz>`
//   → `npx gitrader --version` → `GITRADER_HOME=<tmp>/home npx gitrader init --no-pin`
//   → `npx gitrader serve --offline --port <空闲端口>`，轮询根路径到 200 后收工。
// 目的：证明发布包不依赖未发布的 @gitrader/*（有运行时依赖时 `npm install` 会 E404）。
// 退出码：0 全过；1 任一步失败。只按自己 spawn 的 PID 收进程，不碰别人的。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
// Windows 上 npm / npx 是 .cmd，spawn 不会自动补扩展名
const NPM = process.env.GITRADER_NPM || (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const NPX = process.env.GITRADER_NPX || (process.platform === 'win32' ? 'npx.cmd' : 'npx')

const INSTALL_TIMEOUT_MS = 120_000
const INIT_TIMEOUT_MS = 120_000
const SERVE_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
// 本机 / CI 上常被别的服务占着的端口，命中就重新取（47900–49999 同理）
const RESERVED_PORTS = new Set([8765, 8188, 9872, 9222, 8080, 5198, 4184, 14609, 47831])
const RESERVED_RANGE = [47900, 49999]

const steps = []
let failed = false

function log(msg) {
  console.log(msg)
}

function tail(text, n = 1500) {
  const s = String(text ?? '').trim()
  return s.length > n ? `…${s.slice(-n)}` : s
}

/** 记录一步的耗时与结论；返回是否成功。 */
function record(name, ok, ms, detail = '') {
  steps.push({ name, ok, ms })
  log(`${ok ? '[ok]' : '[fail]'} ${name} ${ms}ms${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
  return ok
}

/** 同步跑一个命令（不联网的命令 / 带超时的安装）。 */
function runSync(name, command, args, { cwd = REPO, env = process.env, timeout = 0 } = {}) {
  const startedAt = Date.now()
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeout || undefined,
    // Windows 上 .cmd 需要 shell 才能启动
    shell: process.platform === 'win32',
  })
  const ms = Date.now() - startedAt
  const ok = r.status === 0 && !r.error
  const detail = ok ? '' : tail(`${r.error?.message ?? ''}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  record(name, ok, ms, detail)
  return { ok, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ms }
}

function isReservedPort(port) {
  if (RESERVED_PORTS.has(port)) return true
  return port >= RESERVED_RANGE[0] && port <= RESERVED_RANGE[1]
}

/** 让系统分配一个空闲端口，避开保留名单。 */
function pickPort() {
  return new Promise((resolvePort, rejectPort) => {
    const attempt = (left) => {
      const server = createServer()
      server.once('error', (err) => (left > 0 ? attempt(left - 1) : rejectPort(err)))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        server.close(() => {
          if (!port) return rejectPort(new Error('拿不到空闲端口'))
          if (isReservedPort(port)) {
            if (left <= 0) return rejectPort(new Error(`只拿到保留端口 ${port}`))
            return attempt(left - 1)
          }
          resolvePort(port)
        })
      })
    }
    attempt(20)
  })
}

/** 只结束自己 spawn 的子进程（Windows 走 taskkill /T 连子树）。 */
function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // 已经退出
    }
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status === 200) {
        await res.arrayBuffer().catch(() => {})
        return { ok: true, lastError: '' }
      }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return { ok: false, lastError }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'gitrader-pack-install-'))
  const home = join(tmp, 'home')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, GITRADER_HOME: home }
  let serveChild = null
  try {
    log(`临时目录：${tmp}`)

    // 1. 打 tarball
    const packDir = join(tmp, 'pack')
    mkdirSync(packDir, { recursive: true })
    const packed = runSync('npm pack -w packages/cli', NPM, ['pack', '-w', 'packages/cli', '--pack-destination', packDir])
    if (!packed.ok) return 1
    const tgzName = packed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.tgz'))
      .pop()
    const tgz = tgzName ? join(packDir, tgzName) : join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz')) ?? '')
    if (!tgzName) {
      record('找出 tarball', false, 0, `pack 输出里没有 .tgz：${tail(packed.stdout, 300)}`)
      return 1
    }
    record('找出 tarball', true, 0, tgzName)

    // 2. 干净消费目录
    const consumer = join(tmp, 'consumer')
    mkdirSync(consumer, { recursive: true })
    if (!runSync('npm init -y', NPM, ['init', '-y'], { cwd: consumer }).ok) return 1

    // 3. 装 tarball（E404 就是这里炸）
    if (!runSync(`npm install ${tgzName}`, NPM, ['install', tgz], { cwd: consumer, timeout: INSTALL_TIMEOUT_MS }).ok) return 1

    // 4. 版本号
    const version = runSync('npx gitrader --version', NPX, ['gitrader', '--version'], { cwd: consumer, env })
    if (!version.ok) return 1

    // 5. 初始化本地目录
    if (!runSync('npx gitrader init --no-pin', NPX, ['gitrader', 'init', '--no-pin'], { cwd: consumer, env, timeout: INIT_TIMEOUT_MS }).ok) return 1

    // 6. 起服务并等首页 200
    const port = await pickPort()
    log(`选中端口：${port}`)
    const startedAt = Date.now()
    serveChild = spawn(NPX, ['gitrader', 'serve', '--offline', '--port', String(port)], {
      cwd: consumer,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })
    let serveOutput = ''
    serveChild.stdout?.on('data', (chunk) => { serveOutput += String(chunk) })
    serveChild.stderr?.on('data', (chunk) => { serveOutput += String(chunk) })
    const url = `http://127.0.0.1:${port}/`
    const ready = await waitForHttp(url, SERVE_READY_TIMEOUT_MS)
    record(`GET ${url} 到 200`, ready.ok, Date.now() - startedAt, ready.ok ? '' : `${ready.lastError}\n${tail(serveOutput)}`)
    if (!ready.ok) return 1
    return 0
  } finally {
    stopChild(serveChild)
    rmSync(tmp, { recursive: true, force: true })
  }
}

const code = await main()
const total = steps.reduce((sum, s) => sum + s.ms, 0)
log(`共 ${steps.length} 步，失败 ${steps.filter((s) => !s.ok).length} 步，累计 ${total}ms`)
process.exitCode = failed ? 1 : code
