// SPDX-License-Identifier: CPAL-1.0
// ⑤ run(argv, io)：inspect 成功为 0 且 stdout 含 interval / gaps；不存在文件与未知子命令为 2。
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/index'
import { dropTmpDir, HOUR, makeTmpDir, T0, writeFixture } from './helpers'

let dir = ''

beforeAll(() => {
  dir = makeTmpDir()
})
afterAll(() => {
  dropTmpDir(dir)
})

async function capture(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await run(argv, {
    stdout: (text: string) => {
      stdout += text
    },
    stderr: (text: string) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

const CSV = ['t,o,h,l,c,v', ...[0, 1, 2, 4].map((i) => `${T0 + i * HOUR},100,110,90,105,10`)].join('\n') + '\n'

describe('run', () => {
  it('inspect 返回 0，stdout 含 interval 与 gaps', async () => {
    const path = writeFixture(dir, 'cli.csv', CSV)
    const r = await capture(['inspect', path, `--root=${dir}`])
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('interval:')
    expect(r.stdout).toContain('1h')
    expect(r.stdout).toContain('gaps: 1')
    expect(r.stdout).toContain('missing 1')
    expect(r.stdout).toContain(path)
  })

  it('不存在的文件返回 2，stderr 含路径', async () => {
    const missing = join(dir, 'no-such-file.csv')
    const r = await capture(['inspect', missing, `--root=${dir}`])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(missing)
    expect(r.stdout).toBe('')
  })

  it('未知子命令返回 2 并给出用法', async () => {
    const r = await capture(['bogus'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown command: bogus')
    expect(r.stderr).toContain('usage:')
  })

  it('normalize 与 manifest 子命令可用', async () => {
    const source = writeFixture(dir, 'cli-src.csv', CSV)
    const out = join(dir, 'cli-out.json')
    const n = await capture(['normalize', source, out, `--root=${dir}`])
    expect(n.code).toBe(0)
    expect(n.stdout).toContain('format: json')
    expect(n.stdout).toContain('duplicates: 0')
    const m = await capture(['manifest', source, out, '--kind=funding', `--root=${dir}`])
    expect(m.code).toBe(0)
    expect(m.stdout).toContain('manifest: 2 file(s)')
    expect(m.stdout).toContain('kind: funding')
  })

  it('缺参数时返回 2，不抛异常', async () => {
    expect((await capture(['inspect'])).code).toBe(2)
    expect((await capture(['normalize', 'only-one.csv'])).code).toBe(2)
    expect((await capture(['manifest'])).code).toBe(2)
    expect((await capture([])).code).toBe(2)
    expect((await capture(['inspect', 'a.csv', '--kind=weird'])).code).toBe(2)
  })
})
