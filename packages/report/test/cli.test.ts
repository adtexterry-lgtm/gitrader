// SPDX-License-Identifier: CPAL-1.0
// CLI：返回码 0/2、stdout / stderr 文案、文件写入、空成交、参数解析。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseArgs, run } from '../src/cli'
import { DISCLAIMER } from '../src/types'
import { buildEmptyFixture, buildFixture } from './fixture'

interface Captured {
  out: string
  err: string
}

async function call(argv: string[]): Promise<{ code: number; io: Captured }> {
  const io: Captured = { out: '', err: '' }
  const code = await run(argv, {
    stdout: (s) => {
      io.out += s
    },
    stderr: (s) => {
      io.err += s
    },
  })
  return { code, io }
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gitrader-report-'))
}

function writeResult(dir: string, name: string, payload: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  return path
}

describe('参数解析', () => {
  it('report <file> --md/--html/--title 各就各位', () => {
    expect(parseArgs(['report', 'r.json', '--md', 'a.md', '--html', 'a.html', '--title', '测试'])).toEqual({
      file: 'r.json',
      md: 'a.md',
      html: 'a.html',
      title: '测试',
    })
  })

  it('未知参数、缺取值、缺文件都报错', () => {
    expect(parseArgs(['report', 'r.json', '--md'])).toHaveProperty('error')
    expect(parseArgs(['report', 'r.json', '--nope', 'x'])).toHaveProperty('error')
    expect(parseArgs(['report'])).toHaveProperty('error')
  })
})

describe('run 的返回码与输出', () => {
  it('文件不存在 → 2，stderr 说清楚路径', async () => {
    const { code, io } = await call(['report', join(tmpDir(), 'missing.json')])
    expect(code).toBe(2)
    expect(io.err).toContain('无法读取结果文件')
    expect(io.out).toBe('')
  })

  it('不是合法 JSON → 2', async () => {
    const dir = tmpDir()
    const path = writeResult(dir, 'bad.json', '{ not json')
    const { code, io } = await call(['report', path])
    expect(code).toBe(2)
    expect(io.err).toContain('不是合法 JSON')
  })

  it('缺 stats / equity → 2', async () => {
    const dir = tmpDir()
    const path = writeResult(dir, 'shape.json', { trades: [] })
    const { code, io } = await call(['report', path])
    expect(code).toBe(2)
    expect(io.err).toContain('缺少 stats 对象或 equity 数组')
  })

  it('不带输出参数时把 Markdown 打到 stdout，返回 0', async () => {
    const dir = tmpDir()
    const path = writeResult(dir, 'r.json', buildFixture())
    const { code, io } = await call(['report', path])
    expect(code).toBe(0)
    expect(io.err).toBe('')
    expect(io.out).toContain('# 回测报告')
    expect(io.out).toContain('| 盈利因子（总盈利 / 总亏损） | 1.50 |')
    expect(io.out).toContain(DISCLAIMER)
  })

  it('--md / --html 落盘，stdout 报路径，HTML 是自包含的', async () => {
    const dir = tmpDir()
    const path = writeResult(dir, 'r.json', buildFixture())
    const mdPath = join(dir, 'out.md')
    const htmlPath = join(dir, 'out.html')
    const { code, io } = await call(['report', path, '--md', mdPath, '--html', htmlPath, '--title', '我的回测'])
    expect(code).toBe(0)
    expect(io.out).toContain(mdPath)
    expect(io.out).toContain(htmlPath)
    const md = readFileSync(mdPath, 'utf8')
    const html = readFileSync(htmlPath, 'utf8')
    expect(md).toContain('# 我的回测')
    expect(html).toContain('<svg')
    expect(html.includes('<script')).toBe(false)
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(300 * 1024)
  })

  it('空成交结果 → 0，输出「无成交」（Markdown 与 HTML 两条路都不崩）', async () => {
    const dir = tmpDir()
    const path = writeResult(dir, 'empty.json', buildEmptyFixture())
    const mdPath = join(dir, 'empty.md')
    const htmlPath = join(dir, 'empty.html')
    const { code } = await call(['report', path, '--md', mdPath, '--html', htmlPath])
    expect(code).toBe(0)
    expect(readFileSync(mdPath, 'utf8')).toContain('_无成交_')
    expect(readFileSync(htmlPath, 'utf8')).toContain('无成交')
  })

  it('缺 trades 字段的结果也能渲染（按空成交处理）', async () => {
    const dir = tmpDir()
    const fixture = buildFixture()
    const path = writeResult(dir, 'notrades.json', { stats: fixture.stats, equity: fixture.equity, params: fixture.params })
    const { code, io } = await call(['report', path])
    expect(code).toBe(0)
    expect(io.out).toContain('_无成交_')
  })

  it('写盘失败（目录不存在）→ 2，stderr 有原因', async () => {
    const dir = tmpDir()
    const path = writeResult(dir, 'r.json', buildFixture())
    const { code, io } = await call(['report', path, '--md', join(dir, 'no-such-dir', 'x.md')])
    expect(code).toBe(2)
    expect(io.err).toContain('写入报告失败')
  })
})
