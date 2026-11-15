// SPDX-License-Identifier: CPAL-1.0
// 自带检查脚本的验收（GQ-62 / GQ-63）：这三个脚本本身就是测试，这里再补两条
// ① 当前仓库必须 exit 0（否则 CI 是红的）；
// ② 反例锁死「不是放宽到什么都过」——把仓库快照拷到临时根目录，塞一个密钥形状的键 /
//    删掉限流面板，脚本必须变红并点名。
// 换根目录跑反例的办法：把脚本与它读的目录原样拷到临时根的同一相对位置（脚本用 import.meta.url 定位仓库根，
// 不支持 --root）；不动仓库里的任何文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')

const tmp = (tag) => mkdtempSync(join(tmpdir(), `gitrader-verify-${tag}-`))
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }
const run = (script) => spawnSync(process.execPath, [script], { encoding: 'utf8' })
const out = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`

/** docker/verify-docker.mjs 只读 docker/ 下的文件，但会按「仓库根 = docker/..」检查 COPY 源与 compose 挂载路径是否存在。 */
function dockerSnapshot(root) {
  cpSync(join(REPO, 'docker'), join(root, 'docker'), { recursive: true })
  cpSync(join(REPO, 'ops'), join(root, 'ops'), { recursive: true })
  for (const rel of ['package.json', 'package-lock.json', 'tsconfig.base.json', 'LICENSE', 'NOTICE']) {
    put(join(root, rel), existsSync(join(REPO, rel)) ? readFileSync(join(REPO, rel)) : '')
  }
  for (const rel of ['scripts', 'packages', 'assets']) mkdirSync(join(root, rel), { recursive: true })
  return join(root, 'docker', 'verify-docker.mjs')
}

/** ops/verify-ops.mjs 读 ops/** 与三个源码文件（指标名、topic 枚举、state 枚举）。 */
function opsSnapshot(root) {
  cpSync(join(REPO, 'ops'), join(root, 'ops'), { recursive: true })
  for (const rel of ['packages/kernel/src/metrics.ts', 'packages/kernel/src/events.ts', 'packages/protocol/src/model/risk.ts']) {
    cpSync(join(REPO, rel), join(root, rel))
  }
  return join(root, 'ops', 'verify-ops.mjs')
}

test('verify-docker：当前仓库 exit 0；.env.example 里混进密钥形状的键仍然会红', () => {
  const ok = run(join(REPO, 'docker', 'verify-docker.mjs'))
  assert.equal(ok.status, 0, out(ok).slice(-800))

  const root = tmp('docker')
  try {
    const script = dockerSnapshot(root)
    assert.equal(run(script).status, 0, '快照本身必须先是通过的（否则反例没有意义）')
    const envFile = join(root, 'docker', '.env.example')
    writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}GITRADER_API_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxx\n`)
    const bad = run(script)
    assert.equal(bad.status, 1, out(bad).slice(-800))
    assert.match(out(bad), /GITRADER_API_TOKEN/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verify-docker：.env.example 里出现未知的普通键也要红（放行的是具体的键，不是「什么都行」）', () => {
  const root = tmp('docker-unknown')
  try {
    const script = dockerSnapshot(root)
    const envFile = join(root, 'docker', '.env.example')
    writeFileSync(envFile, `${readFileSync(envFile, 'utf8')}GITRADER_SOMETHING_ELSE=1\n`)
    const bad = run(script)
    assert.equal(bad.status, 1, out(bad).slice(-800))
    assert.match(out(bad), /GITRADER_SOMETHING_ELSE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('verify-ops：当前仓库 exit 0；仪表盘删掉「被限流的调用」面板 → 红并点名 gitrader_op_rate_limited_total', () => {
  const ok = run(join(REPO, 'ops', 'verify-ops.mjs'))
  assert.equal(ok.status, 0, out(ok).slice(-800))

  const root = tmp('ops')
  try {
    const script = opsSnapshot(root)
    assert.equal(run(script).status, 0, '快照本身必须先是通过的')
    const dashFile = join(root, 'ops', 'grafana', 'dashboards', 'gitrader-overview.json')
    const dash = JSON.parse(readFileSync(dashFile, 'utf8'))
    assert.ok(Array.isArray(dash.panels) && dash.panels.some((p) => p.id === 10), '快照里没有 id=10 的面板')
    dash.panels = dash.panels.filter((p) => p.id !== 10)
    writeFileSync(dashFile, `${JSON.stringify(dash, null, 2)}\n`)
    const bad = run(script)
    assert.equal(bad.status, 1, out(bad).slice(-800))
    assert.match(out(bad), /gitrader_op_rate_limited_total/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('GQ-63：*-trade README 不再声称内核下单路径可用', () => {
  for (const n of ['alpaca', 'binance', 'bitget', 'bybit', 'gateio', 'ibkr', 'okx']) {
    const text = readFileSync(join(REPO, 'packages', `connector-${n}-trade`, 'README.md'), 'utf8')
    assert.doesNotMatch(text, /即可走内核的下单路径/, n)
    assert.match(text, /未经真网验证，不得接实盘|不得接实盘/, `${n} 的 README 少了「不得接实盘」这句`)
  }
})
