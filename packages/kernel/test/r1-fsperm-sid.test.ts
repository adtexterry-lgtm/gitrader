// SPDX-License-Identifier: CPAL-1.0
// release-r1：密钥文件收紧权限按 SID 授权，不靠 whoami 打印的账户名（中文计算机名 / 用户名在 GBK 控制台下会被读成乱码，icacls 报 1332）。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aclPrincipal, tightenFile } from '../src/util/fsperm'

describe('fsperm 授权对象', () => {
  it('whoami /user 的 CSV 里取 SID：账户名是乱码也不影响', () => {
    const garbled = Buffer.from('"terry的blade18\\terry","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n', 'utf8').toString('latin1')
    expect(aclPrincipal(garbled, {})).toBe('*S-1-5-21-1111111111-2222222222-3333333333-1001')
  })
  it('SID 只认最后一列：账户名里夹着 SID 样的字也不取', () => {
    expect(aclPrincipal('"S-1-1-0\\x","S-1-5-21-1-2-3-1001"\r\n', {})).toBe('*S-1-5-21-1-2-3-1001')
    expect(aclPrincipal('"S-1-1-0\\x"\r\n', { USERNAME: 'alice' })).toBe('alice')
  })
  it('拿不到 SID（例如 PATH 里是只打用户名的 whoami）就用环境变量里的账户名；连用户名都没有就是空（不收紧）', () => {
    expect(aclPrincipal('terry\n', { USERDOMAIN: '机器名', USERNAME: '张三' })).toBe('机器名\\张三')
    expect(aclPrincipal('', { USERNAME: 'alice' })).toBe('alice')
    expect(aclPrincipal('', { USERDOMAIN: '机器名' })).toBe('')
    expect(aclPrincipal('', {})).toBe('')
  })
  it('真收紧一个文件：成功，本人仍可读；Windows 上只剩一条授权，给的是当前用户的 SID', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'r1-fsperm-')), 'secret.txt')
    writeFileSync(f, 'x')
    expect(tightenFile(f)).toBe(true)
    expect(readFileSync(f, 'utf8')).toBe('x')
    if (process.platform === 'win32') {
      const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      const me = aclPrincipal(execFileSync(join(sys, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'latin1' }))
      expect(me).toMatch(/^\*S-1-5-21-/)
      const aces = execFileSync(join(sys, 'icacls.exe'), [f], { encoding: 'latin1' }).split(/\r?\n/).filter((l) => /:\(/.test(l))
      expect(aces).toHaveLength(1)
      expect(execFileSync(join(sys, 'icacls.exe'), [f, '/findsid', me], { encoding: 'latin1' })).toMatch(/secret\.txt/)
    }
  })
})
