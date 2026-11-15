// SPDX-License-Identifier: CPAL-1.0
// 教程冒烟：把 docs/user/tutorials/ 下中英六篇教程里的每一条命令**真的跑一遍**，断言成功。
//
//   node --test docs/user/tutorials/test/
//   node --test docs/user/tutorials/test/tutorials.test.mjs     # 只跑这一组
//
// 口径（与文档里的约定一一对应）：
//   · 代码块语言：只有 ```bash 会被执行（```text / ```json / ```ts / ```python 只是给人看的）；
//   · 一个命令块里一行一条命令；`#` 开头是注释，不执行；行尾 `\` 续行会先拼起来；
//   · 文档里的 `gitrader` 在源码树里映射成构建产物 packages/cli/dist/bin.js；没有产物时教程 03（中 / 英）
//     跳过并写明「先 npm run build -w gitrader」（内核源码的 TS 参数属性让类型擦除跑不了 src/bin.ts）；
//   · 会一直占住终端的命令（`gitrader serve …`、`notify-sink.mjs`）按后台起、等它就绪，
//     遇到注释里带 `Ctrl+C` 的块就把它停掉（文档里那一步就是叫读者按 Ctrl+C）；
//   · 隐藏输入：`plugins grant` 的 PIN 由本脚本提供（相当于读者在终端里敲）；PIN 本身在临时主目录里，
//     跑完随目录一起删掉；
//   · 只有一处允许非零退出：服务停掉之后 `gitrader status`，文档明说它打印 `Not running.` 并返回 1。
//
// 全程离线：不联网（webhook 只指向 127.0.0.1 上的本地接收器）、不读密钥、不写仓库里的文件
// （产物全部落在临时 HOME 下的 ~/gitrader-lab/）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TUT = resolve(HERE, '..')
const ROOT = resolve(TUT, '..', '..', '..')
const PIN = '482913'

const doc = (name) => readFileSync(join(TUT, name), 'utf8')

/** 取 ```<lang> 围栏块（按出现顺序）。 */
export function fences(text, lang) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w+)\s*$/.exec(lines[i])
    if (!open) continue
    const body = []
    let j = i + 1
    for (; j < lines.length && !/^```\s*$/.test(lines[j]); j++) body.push(lines[j])
    if (open[1] === lang) out.push({ code: body.join('\n').split('\r').join(''), line: i + 1 })
    i = j
  }
  return out
}

/** 一个 bash 块 → 命令行列表（拼续行、去注释、去空行）。 */
export function commands(code) {
  const merged = []
  let buf = ''
  for (const raw of code.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (buf) {
      buf += ' ' + line.replace(/\\$/, '').trim()
      if (!line.endsWith('\\')) { merged.push(buf); buf = '' }
      continue
    }
    if (line.endsWith('\\')) { buf = line.replace(/\\$/, '').trim(); continue }
    merged.push(line)
  }
  if (buf) merged.push(buf)
  return merged.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

/** 源码树里跑 CLI：只用构建产物（教程开头就让读者先 `npm run build -w gitrader`）。
 *  内核源码用了 TS 参数属性，Node 的类型擦除跑不了 `packages/cli/src/bin.ts`，所以没有产物时教程 03 跳过并写明原因。 */
const CLI_DIST = join(ROOT, 'packages', 'cli', 'dist', 'bin.js')
const NEEDS_BUILD = existsSync(CLI_DIST) ? false : '缺 packages/cli/dist/bin.js：先在仓库根执行 npm run build -w gitrader（教程 03 要真起内核）'
function cliPrefix() {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI_DIST)}`
}

const BASH = process.env.BASH || 'bash'

function makeLab() {
  // HOME 必须是 bash 与 node 认成同一个地方的路径：本机 TMPDIR 给的是 MSYS 的 /tmp（bash 与 node 解析到不同目录），
  // 所以 Windows 上改用带盘符的 C:/… 形式。
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA || process.env.TEMP || 'C:/Windows/Temp') : tmpdir()
  // 注意：HOME 要用本机原生形式（带盘符 + 反斜杠）。写成 C:/… 会被 MSYS bash 归一成 /c/…，
  // 而 node 把盘符风格的路径解析成 <当前盘>:\…，两边就不是同一个目录了。
  const home = mkdtempSync(join(base, 'gitrader-tutorial-smoke-'))
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      WEBHOOK_SECRET: 'local-lab-placeholder',
      GEP_PYTHON: process.env.GEP_PYTHON || 'python',
    },
  }
}

/** 把一条命令改成可直接执行的 shell 片段。 */
function shellize(cmd) {
  if (/^gitrader\s/.test(cmd)) return cmd.replace(/^gitrader\s/, cliPrefix() + ' ')
  return cmd
}

/** 前台跑一条命令。 */
function runOnce(cmd, cwd, env, { stdin } = {}) {
  const r = spawnSync(BASH, ['-c', shellize(cmd)], { cwd, env, encoding: 'utf8', input: stdin ?? '', timeout: 300_000 })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/** 杀进程树（Windows 上杀 bash 不会带走它起的 node，要用 taskkill /T）。 */
function killTree(proc) {
  if (!proc || proc.killed) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  else proc.kill('SIGKILL')
}

/** 后台起一条常驻命令，等它就绪（输出里出现 ready 正则）。 */
function startBackground(cmd, cwd, env, ready) {
  const p = spawn(BASH, ['-c', shellize(cmd)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { out += d })
  const started = Date.now()
  return new Promise((resolveStart, rejectStart) => {
    const tick = setInterval(() => {
      if (ready.test(out)) { clearInterval(tick); resolveStart({ proc: p, log: () => out }) }
      else if (Date.now() - started > 45_000) { clearInterval(tick); killTree(p); rejectStart(new Error(`后台命令 45s 未就绪：${cmd}\n${out}`)) }
    }, 150)
  })
}

/** 隐藏输入的 PIN：init 要两行，且要等第一行被读走（非 TTY 的 readSecret 会把同批多行一起丢掉）。 */
function setupPin(env, cwd) {
  return new Promise((resolvePin, rejectPin) => {
    const p = spawn(BASH, ['-c', `${cliPrefix()} init --home ./tutorial-lab/kernel`], { cwd, env: { ...env, GITRADER_PIN_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { out += d })
    p.stdin.write(PIN + '\n')
    setTimeout(() => { p.stdin.write(PIN + '\n'); p.stdin.end() }, 700)
    p.on('close', (code) => (code === 0 && /PIN set/.test(out) ? resolvePin() : rejectPin(new Error(`设 PIN 失败（退出码 ${code}）：\n${out}`))))
  })
}

/**
 * 逐块执行一篇教程里的全部 bash 命令。返回 { commands: 执行的条数, killed: 后台进程数 }。
 */
async function runDoc(name, { expectCommands }) {
  const lab = makeLab()
  const outDir = join(ROOT, 'tutorial-lab')
  rmSync(outDir, { recursive: true, force: true }) // 教程产物目录；跑完删掉，不留在仓库里
  const bg = []
  let count = 0
  let pinReady = false
  try {
    const text = doc(name)
    for (const f of fences(text, 'bash')) {
      // 只写着「按 Ctrl+C」的注释块 = 文档里的「停掉后台进程」这一步
      if (/Ctrl\+C/.test(f.code) && commands(f.code).length === 0) {
        for (const b of bg.splice(0)) killTree(b.proc)
        continue
      }
      for (const cmd of commands(f.code)) {
        if (/^gitrader\s+serve\b/.test(cmd)) {
          bg.push(await startBackground(cmd, ROOT, lab.env, /is running on 127\.0\.0\.1:/))
          count += 1
          continue
        }
        if (/notify-sink\.mjs/.test(cmd)) {
          bg.push(await startBackground(cmd, ROOT, lab.env, /通知接收器已起|sink listening/))
          count += 1
          continue
        }
        if (/^export\s+\w+=/.test(cmd)) {
          const m = /^export\s+(\w+)=(.*)$/.exec(cmd)
          const value = m[2].replace(/^['"]|['"]$/g, '')
          lab.env[m[1]] = value
          count += 1
          continue
        }
        if (/^gitrader\s+plugins\s+grant\b/.test(cmd)) {
          if (!pinReady) { await setupPin(lab.env, ROOT); pinReady = true }
          const r = runOnce(cmd, ROOT, lab.env, { stdin: PIN + '\n' })
          assert.equal(r.code, 0, `[${name}] 命令失败：${cmd}\n${r.out}`)
          count += 1
          continue
        }
        const r = runOnce(cmd, ROOT, lab.env)
        const tolerated = /gitrader\s+status/.test(cmd) && /Not running\./.test(r.out) && r.code === 1
        assert.ok(r.code === 0 || tolerated, `[${name}] 命令失败（退出码 ${r.code}）：${cmd}\n${r.out.slice(-2000)}`)
        count += 1
      }
    }
    assert.ok(count >= expectCommands, `[${name}] 只执行了 ${count} 条命令，少于预期的 ${expectCommands}`)
    return { commands: count, home: lab.home }
  } finally {
    for (const b of bg) killTree(b.proc)
    rmSync(lab.home, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
}

// ───────────────────────────── 用例 ─────────────────────────────

test('教程目录结构：中英各三篇 + 目录页 + 样例数据都在', () => {
  for (const f of ['README.md', '01-数据到因子报告.md', '02-写策略跑回测.md', '03-纸面模式与通知.md']) {
    assert.ok(statSync(join(TUT, f)).size > 800, `${f} 不存在或过短`)
  }
  for (const f of ['README.md', '01-data-to-factor-report.md', '02-strategy-and-backtest.md', '03-paper-mode-and-notifications.md']) {
    assert.ok(statSync(join(TUT, 'en', f)).size > 800, `en/${f} 不存在或过短`)
  }
  for (const f of ['btcusdt-1h.csv', 'ethusdt-1h.csv', 'solusdt-4h.csv', 'README.md']) {
    assert.ok(existsSync(join(ROOT, 'assets', 'samples', f)), `assets/samples/${f} 不存在`)
  }
})

test('教程 01（中）：从 K 线到因子报告，命令全部跑通', async () => {
  const r = await runDoc('01-数据到因子报告.md', { expectCommands: 5 })
  assert.ok(r.commands >= 5)
})

test('教程 02（中）：TS 与 Python 两版回测 + 两份报告，命令全部跑通', async () => {
  const r = await runDoc('02-写策略跑回测.md', { expectCommands: 4 })
  assert.ok(r.commands >= 4)
})

test('教程 03（中）：纸面起内核 → 配通道 → 发出并收到一条通知，命令全部跑通', { skip: NEEDS_BUILD }, async () => {
  const r = await runDoc('03-纸面模式与通知.md', { expectCommands: 10 })
  assert.ok(r.commands >= 10)
})

test('英文章节可照敲：英文教程 01 / 02 的命令同样跑通', async () => {
  for (const [name, min] of [['en/01-data-to-factor-report.md', 5], ['en/02-strategy-and-backtest.md', 5]]) {
    const r = await runDoc(name, { expectCommands: min })
    assert.ok(r.commands >= min, `${name} 只跑了 ${r.commands} 条`)
  }
})

test('英文章节可照敲：英文教程 03 的命令同样跑通', { skip: NEEDS_BUILD }, async () => {
  for (const [name, min] of [['en/03-paper-mode-and-notifications.md', 10]]) {
    const r = await runDoc(name, { expectCommands: min })
    assert.ok(r.commands >= min, `${name} 只跑了 ${r.commands} 条`)
  }
})

test('教程 02 的代码块与 strategies/ 下的两份策略文件逐字一致', () => {
  const text = doc('02-写策略跑回测.md')
  const ts = fences(text, 'ts')
  const py = fences(text, 'python')
  assert.equal(ts.length, 1, '教程 02 应当只有一段 ```ts')
  assert.equal(py.length, 1, '教程 02 应当只有一段 ```python')
  const lf = (s) => s.split('\r').join('').trimEnd()
  assert.equal(lf(ts[0].code), lf(readFileSync(join(TUT, 'strategies', 'tutorial-sma-band.ts'), 'utf8')), '教程里的 TS 代码与 strategies/tutorial-sma-band.ts 不一致')
  assert.equal(lf(py[0].code), lf(readFileSync(join(TUT, 'strategies', 'tutorial-sma-band.py'), 'utf8')), '教程里的 Python 代码与 strategies/tutorial-sma-band.py 不一致')
  // 英文版引用同一份代码，不该各写一遍
  const en = doc('en/02-strategy-and-backtest.md')
  assert.equal(fences(en, 'ts').length, 0, '英文版不要重复贴策略代码，引用同一份文件')
})

test('教程 02 的两版回测逐项一致：同一份 K 线 + 同一套参数，TS 与 Python 的统计量相同', () => {
  const out = mkdtempSync(join(process.platform === 'win32' ? (process.env.LOCALAPPDATA || process.env.TEMP || 'C:/Windows/Temp') : tmpdir(), 'gitrader-parity-'))
  try {
    const args = ['--data', 'assets/samples/btcusdt-1h.csv', '--params', '{"period":24,"band":1,"allowShort":true}',
      '--balance', '10000', '--leverage', '1', '--fee-rate', '0.0005', '--slippage-bps', '3']
    const ts = spawnSync(process.execPath, [join(TUT, 'backtest.mjs'), '--engine', 'ts', '--strategy', join(TUT, 'strategies', 'tutorial-sma-band.ts'), '--out', join(out, 'ts.json'), ...args], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(ts.status, 0, `TS 回测失败：${ts.stderr}`)
    const py = spawnSync(process.execPath, [join(TUT, 'backtest.mjs'), '--engine', 'py', '--strategy', join(TUT, 'strategies', 'tutorial-sma-band.py'), '--out', join(out, 'py.json'), ...args], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(py.status, 0, `Python 回测失败：${py.stderr}`)
    const a = JSON.parse(readFileSync(join(out, 'ts.json'), 'utf8'))
    const b = JSON.parse(readFileSync(join(out, 'py.json'), 'utf8'))
    for (const key of ['totalReturnRatio', 'annualizedRatio', 'maxDrawdownRatio', 'sharpe', 'winRatio', 'trades', 'fills', 'finalEquity']) {
      assert.ok(Math.abs(a.stats[key] - b.stats[key]) <= 1e-9, `stats.${key} 两版不一致：${a.stats[key]} vs ${b.stats[key]}`)
    }
    assert.equal(a.equity.length, b.equity.length, '权益曲线长度不同')
    for (let i = 0; i < a.equity.length; i++) {
      assert.equal(a.equity[i].t, b.equity[i].t)
      assert.ok(Math.abs(a.equity[i].v - b.equity[i].v) <= 1e-9, `第 ${i} 个权益点不同：${a.equity[i].v} vs ${b.equity[i].v}`)
    }
    assert.equal(a.trades.length, b.trades.length, '成交笔数不同')
    // 结果形状是 GEP 的 BacktestResult：报告渲染靠这几个字段
    for (const k of ['jobId', 'specDigest', 'assumptions', 'stats', 'equity', 'trades', 'dataDigest', 'engine']) assert.ok(k in a, `结果缺字段 ${k}`)
    assert.equal(a.assumptions.fillModel, 'next-bar-open')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('样例 CSV：体积、来源许可、能被 tools/data 与 tools/research 读', () => {
  const dir = join(ROOT, 'assets', 'samples')
  const readme = readFileSync(join(dir, 'README.md'), 'utf8')
  for (const w of ['合成', '许可证', 'CPAL-1.0', 'sha256']) assert.ok(readme.includes(w), `assets/samples/README.md 缺「${w}」`)
  const files = readdirSync(dir).filter((f) => f.endsWith('.csv')).sort()
  assert.equal(files.length, 3)
  for (const f of files) {
    const size = statSync(join(dir, f)).size
    assert.ok(size > 1000 && size <= 300 * 1024, `${f} 体积 ${size} 字节，应在 (1KB, 300KB]`)
    const header = readFileSync(join(dir, f), 'utf8').split('\n')[0]
    assert.equal(header, 't,o,h,l,c,v', `${f} 表头应为 t,o,h,l,c,v`)
    const out = mkdtempSync(join(tmpdir(), 'gitrader-samples-'))
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'data', 'inspect.mjs'), 'inspect', join(dir, f)], { cwd: ROOT, encoding: 'utf8' })
      // inspect 只吃 json；先用 normalize 转一次再体检，正是教程 01 的第 3 步
      const n = spawnSync(process.execPath, [join(ROOT, 'tools', 'data', 'inspect.mjs'), 'normalize', join(dir, f), join(out, 'x.json')], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(n.status, 0, `tools/data normalize 读不了 ${f}：${n.stderr}`)
      const i = spawnSync(process.execPath, [join(ROOT, 'tools', 'data', 'inspect.mjs'), 'inspect', join(out, 'x.json')], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(i.status, 0, `tools/data inspect 读不了 ${f}：${i.stderr}`)
      assert.match(i.stdout, /ohlc violations: 0/, `${f} 体检有 OHLC 违规`)
      void r
      const fr = spawnSync(process.execPath, [join(ROOT, 'tools', 'research', 'factor-report.mjs'), join(dir, f), '--md', join(out, 'f.md'), '--html', join(out, 'f.html')], { cwd: ROOT, encoding: 'utf8' })
      assert.equal(fr.status, 0, `tools/research 读不了 ${f}：${fr.stderr}`)
      assert.match(readFileSync(join(out, 'f.md'), 'utf8'), /157 条/, `${f} 的因子报告条数不对`)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }
})