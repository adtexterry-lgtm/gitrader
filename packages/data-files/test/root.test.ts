// SPDX-License-Identifier: CPAL-1.0
// L5-06 回归：本包所有读写都必须落在 `root` 里。
// 每条都配一个正向对照（root 内的同一操作成功），避免「全都抛错」式的假通过。
import { symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectCandleFile, manifestFor, normalizeCandleFile, resolveWithin, run } from '../src/index'
import { dropTmpDir, HOUR, makeTmpDir, T0, writeFixture } from './helpers'

let root = ''
let outside = ''
const CSV = ['t,o,h,l,c,v', `${T0},100,110,90,105,10`, `${T0 + HOUR},105,115,95,110,11`].join('\n') + '\n'

beforeAll(() => {
  root = makeTmpDir()
  outside = makeTmpDir()
  writeFixture(outside, 'secret.csv', CSV)
  writeFixture(root, 'inside.csv', CSV)
})
afterAll(() => {
  dropTmpDir(root)
  dropTmpDir(outside)
})

describe('读取：`../` 与绝对路径都出不了 root', () => {
  it('同一文件：root 内读成功，`../` 相对路径被拒', () => {
    const inside = join(root, 'inside.csv')
    expect(inspectCandleFile(inside, { root }).rows).toBe(3)

    const escape = join('..', basename(outside), 'secret.csv')
    expect(() => inspectCandleFile(escape, { root })).toThrow(/escapes the data root/)
  })

  it('绝对路径指向 root 外 → 拒绝（哪怕文件确实存在）', () => {
    const target = join(outside, 'secret.csv')
    expect(() => inspectCandleFile(target, { root })).toThrow(/escapes the data root/)
    expect(() => manifestFor([{ path: target }], { root })).toThrow(/escapes the data root/)
  })

  it('root 内绝对路径仍可用（正向对照）', () => {
    const entries = manifestFor([{ path: join(root, 'inside.csv') }], { root })
    expect(entries[0]?.path).toBe(join(root, 'inside.csv'))
  })
})

describe('不传 root 时不约束路径（与批 10 之前一致）', () => {
  it('root 外的文件可直接读', () => {
    const target = join(outside, 'secret.csv')
    expect(inspectCandleFile(target).rows).toBe(3)
    expect(manifestFor([{ path: target }])[0]?.path).toBe(target)
  })

  it('root 外的源文件与输出都可读写', () => {
    const source = writeFixture(outside, 'no-root-source.csv', CSV)
    const out = join(outside, 'no-root-out.json')
    const report = normalizeCandleFile(source, out)
    expect(report.path).toBe(out)
    expect(report.rows).toBe(2)
  })
})

describe('写入：normalize 的输出同样受 root 约束', () => {
  it('输出 `../` 越界 → 拒绝，且不落盘', () => {
    const escape = join('..', basename(outside), 'written-by-plugin.json')
    expect(() => normalizeCandleFile('inside.csv', escape, { root })).toThrow(/output file escapes the data root/)
  })

  it('输出绝对路径越界 → 拒绝', () => {
    expect(() => normalizeCandleFile('inside.csv', join(outside, 'abs.json'), { root })).toThrow(/output file escapes the data root/)
  })

  it('输出落在 root 内 → 成功（正向对照）', () => {
    const report = normalizeCandleFile('inside.csv', join('nested', 'out.json'), { root })
    expect(report.path).toBe(join(root, 'nested', 'out.json'))
    expect(report.rows).toBe(2)
  })
})

describe('root 本身不合法时明确报错', () => {
  it('root 不存在 → data root does not exist（不静默降级成 cwd）', () => {
    expect(() => resolveWithin(join(root, 'no-such-root'), 'x.csv')).toThrow(/data root does not exist/)
  })

  it('绝对路径 root 自身与子路径都算在内', () => {
    expect(resolveWithin(root, '.')).toBe(root)
    expect(resolveWithin(root, join('a', 'b.csv'))).toBe(join(root, 'a', 'b.csv'))
  })
})

describe('符号链接不能把落点带出 root', () => {
  let linkable = true
  beforeAll(() => {
    try {
      symlinkSync(outside, join(root, 'link'), 'junction')
    } catch {
      linkable = false
    }
  })

  it('经 junction 读 root 外的文件 → 拒绝', () => {
    if (!linkable) return
    expect(() => inspectCandleFile(join('link', 'secret.csv'), { root })).toThrow(/escapes the data root/)
  })
})

describe('CLI：--root 越界返回 2', () => {
  it('inspect 越界 → code 2，stderr 指明越界', async () => {
    let stderr = ''
    const code = await run(
      ['inspect', join('..', basename(outside), 'secret.csv'), `--root=${root}`],
      { stdout: () => {}, stderr: (t: string) => { stderr += t } },
    )
    expect(code).toBe(2)
    expect(stderr).toContain('escapes the data root')
  })

  it('--root= 空值 → code 2', async () => {
    let stderr = ''
    const code = await run(['inspect', 'inside.csv', '--root='], { stdout: () => {}, stderr: (t: string) => { stderr += t } })
    expect(code).toBe(2)
    expect(stderr).toContain('--root needs a directory')
  })

  it('--root 后面没值 → code 2', async () => {
    let stderr = ''
    const code = await run(['inspect', 'inside.csv', '--root'], { stdout: () => {}, stderr: (t: string) => { stderr += t } })
    expect(code).toBe(2)
    expect(stderr).toContain('--root needs a directory')
  })

  it('--root 后面紧跟另一个选项 → code 2（不把 --kind 当目录名）', async () => {
    let stderr = ''
    const code = await run(
      ['inspect', 'inside.csv', '--root', '--kind=candles'],
      { stdout: () => {}, stderr: (t: string) => { stderr += t } },
    )
    expect(code).toBe(2)
    expect(stderr).toContain('--root needs a directory')
  })

  it('--root 内相对路径成功（正向对照）', async () => {
    let stdout = ''
    const code = await run(['inspect', 'inside.csv', `--root=${root}`], { stdout: (t: string) => { stdout += t }, stderr: () => {} })
    expect(code).toBe(0)
    expect(stdout).toContain('interval:')
  })
})
