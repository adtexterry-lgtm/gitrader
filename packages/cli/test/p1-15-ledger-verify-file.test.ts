// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LedgerEntry } from '@gitrader/protocol'
import { Kernel, fileProvider } from '@gitrader/kernel'
import { main } from '../src/index'
import type { CliIo } from '../src/index'

const NL = String.fromCharCode(10)
let home: string
let out: string[]
let err: string[]

const io = (): CliIo => ({
  out: (s) => { out.push(s) },
  err: (s) => { err.push(s) },
  env: { GITRADER_HOME: home },
  interactive: false,
  deviceKey: fileProvider,
  readSecret: async () => { throw new Error('unexpected prompt') },
})
const run = (argv: string[]): Promise<number> => main(argv, io())
const text = (): string => out.join('') + err.join('')

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'gitrader-verify-'))
  out = []
  err = []
  expect(await run(['init', '--no-pin'])).toBe(0)
  const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
  try {
    for (let i = 0; i < 5; i++) {
      k.ledger.append({ type: 'note', origin: { actor: 'user:usr_local', actorType: 'human', tool: 'test', requestId: 'r', via: 'cli' }, subject: { orgId: 'org_local' }, payload: { text: `n${i}` } })
    }
  } finally { await k.stop() }
  // B3：--out 是 <home>/exports 下的相对路径（受限导出）
  expect(await run(['ledger', 'export', '--out', 'exp'])).toBe(0)
  out = []
  err = []
})

afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))

describe('gitrader ledger verify <file-or-dir>', () => {
  it('intact export verifies', async () => {
    expect(await run(['ledger', 'verify', join(home, 'exports', 'exp')])).toBe(0)
    expect(text()).toMatch(/导出件完好：\d+ 条，链头 [0-9a-f]{12}/)
    // fix-r4 C2：完好件要报出已核对签名与是否和本机库比对
    expect(text()).toMatch(/已核对签名（install-[0-9a-f]+）/)
    expect(text()).toMatch(/已与本机库比对/)
  })

  it('删最后一行并把 manifest 的 toSeq / count / lastHash 改成新末行 → 退出码 2，原因是签名', async () => {
    const dir = join(home, 'exports', 'exp')
    const file = join(dir, 'ledger.jsonl')
    const lines = readFileSync(file, 'utf8').split(NL).filter((line) => line !== '')
    lines.pop()
    writeFileSync(file, lines.join(NL) + NL, 'utf8')
    const prev = JSON.parse(lines.at(-1)!) as LedgerEntry
    const mp = join(dir, 'manifest.json')
    const m = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, unknown>
    m.toSeq = prev.seq
    m.count = lines.length
    m.lastHash = prev.hash
    writeFileSync(mp, JSON.stringify(m, null, 2), 'utf8')
    expect(await run(['ledger', 'verify', dir])).toBe(2)
    expect(text()).toMatch(/导出件被改动：manifest signature invalid/)
  })

  it('--json 输出带 signer 与库比对结果', async () => {
    expect(await run(['ledger', 'verify', join(home, 'exports', 'exp'), '--json'])).toBe(0)
    const j = JSON.parse(out.join('')) as { ok: boolean; signer?: string; db?: { compared: boolean; newerEntries?: number } }
    expect(j.ok).toBe(true)
    expect(j.signer).toMatch(/^install-/)
    expect(j.db?.compared).toBe(true)
  })

  it('导出之后库里又新增条目：仍然通过并说明新增条数', async () => {
    const k = await Kernel.create({ home, timers: false, deviceKeyProvider: fileProvider })
    try { k.ledger.append({ type: 'note', origin: { actor: 'user:usr_local', actorType: 'human', tool: 'test', requestId: 'r2', via: 'cli' }, subject: { orgId: 'org_local' }, payload: { text: 'later' } }) } finally { await k.stop() }
    expect(await run(['ledger', 'verify', join(home, 'exports', 'exp')])).toBe(0)
    expect(text()).toMatch(/库里在导出之后又新增 \d+ 条/)
  })

  it('本机库里的签名密钥和导出件不一致（换了机器 / 库被换）→ 退出码 2', async () => {
    const dir = join(home, 'exports', 'exp')
    const mp = join(dir, 'manifest.json')
    const m = JSON.parse(readFileSync(mp, 'utf8')) as { installKey: { keyId: string } }
    m.installKey.keyId = 'install-deadbeef'
    writeFileSync(mp, JSON.stringify(m, null, 2), 'utf8')
    expect(await run(['ledger', 'verify', dir])).toBe(2)
    expect(text()).toMatch(/导出件被改动：/)
  })

  it('降级成 /1 的删尾件：不写「完好」，说明无法证明末尾没被删，并提示库里在这之后还有条目', async () => {
    const dir = join(home, 'exports', 'exp')
    const file = join(dir, 'ledger.jsonl')
    const lines = readFileSync(file, 'utf8').split(NL).filter((line) => line !== '')
    lines.pop()
    writeFileSync(file, lines.join(NL) + NL, 'utf8')
    const prev = JSON.parse(lines.at(-1)!) as LedgerEntry
    const mp = join(dir, 'manifest.json')
    const m = JSON.parse(readFileSync(mp, 'utf8')) as Record<string, unknown>
    delete m.signature; delete m.chainHead; delete m.complete
    m.schema = 'gitrader-ledger-export/1'
    m.toSeq = prev.seq; m.count = lines.length; m.lastHash = prev.hash
    writeFileSync(mp, JSON.stringify(m, null, 2), 'utf8')
    expect(await run(['ledger', 'verify', dir])).toBe(0)
    expect(text()).not.toMatch(/导出件完好/)
    expect(text()).toMatch(/链内自洽，但这是旧版无签名导出件，无法证明末尾没有被删/)
    expect(text()).toMatch(/库里在这之后还有 \d+ 条（可能是导出后新增，也可能是导出件被截断；旧版件无法区分）/)
  })

  it('没有本机库时只验导出件自身，并说明未比对', async () => {
    const dir = join(home, 'exports', 'exp')
    rmSync(join(home, 'data', 'gitrader.sqlite'), { force: true })
    expect(await run(['ledger', 'verify', dir])).toBe(0)
    expect(text()).toMatch(/已核对签名/)
    expect(text()).toMatch(/未与本机库比对/)
  })

  it('one byte changed reports the seq and exits 2', async () => {
    const file = join(home, 'exports', 'exp', 'ledger.jsonl')
    const entries = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as LedgerEntry)
    const target = entries[2]!
    target.payload = { ...(target.payload ?? {}), text: 'tampered' }
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    expect(await run(['ledger', 'verify', file])).toBe(2)
    expect(text()).toMatch(/导出件被改动：第 2 条起对不上/)
    expect(text()).toMatch(/LEDGER BROKEN at seq 2/)
  })

  it('missing file exits 2 with chinese text', async () => {
    expect(await run(['ledger', 'verify', join(home, 'nope')])).toBe(2)
    expect(text()).toMatch(/读不出导出件/)
  })
})
