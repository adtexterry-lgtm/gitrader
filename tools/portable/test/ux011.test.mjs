// SPDX-License-Identifier: CPAL-1.0
// ux-011（C 包）：便携包的启动脚本、启动器、README.txt 与 zip 路径分隔符。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findPromiseWords, launcherCmd, launcherSh, packBundle, readmeText, startCmd, startSh } from '../build-portable.mjs'

test('UX-04：启动器设置 GITRADER_LAUNCHER 为自己的完整路径', () => {
  assert.match(launcherCmd(), /set "GITRADER_LAUNCHER=%~dp0gitrader\.cmd"/)
  assert.match(launcherCmd(), /^@echo off/)
  assert.match(launcherSh(), /GITRADER_LAUNCHER="\$HERE\/gitrader"\nexport GITRADER_LAUNCHER/)
})

test('UX-25：start.cmd 认 GITRADER_HOME，且不写死只查 %USERPROFILE%', () => {
  const t = startCmd()
  assert.match(t, /if defined GITRADER_HOME set "CFG=%GITRADER_HOME%\\gitrader\.json"/)
  assert.match(t, /if not exist "%CFG%" \(/)
  assert.match(startSh(), /GITRADER_HOME:-/)
})

test('UX-13 / UX-31 / UX-35：start 脚本走 serve --open，不含 powershell，没有管道过滤器', () => {
  const t = startCmd()
  assert.match(t, /serve %\* --open/)
  assert.equal(/powershell|Start-Process/i.test(t), false)
  assert.equal(t.includes(' | '), false)
  assert.equal(t.includes('不自动开浏览器'), false)
  const sh = startSh()
  assert.match(sh, /serve "\$@" --open/)
  assert.equal(/OPENER|read -r/.test(sh), false)
  assert.equal(sh.includes(' | '), false)
})

test('UX-11 / UX-12：README.txt 中英双语，含升级与卸载', () => {
  const r = readmeText('0.1.1', 'win-x64', '22.23.2')
  for (const k of ['中文', 'English', '升级：', '卸载：', 'Upgrade:', 'Uninstall:', 'bin\\gitrader.cmd stop']) assert.ok(r.includes(k), `缺 ${k}`)
  assert.equal((r.match(/^1\. /gm) ?? []).length, 2, '中英各一份步骤')
  assert.deepEqual(findPromiseWords(r), [])
})

test('UX-25：win zip 条目路径用 / 而不是反斜杠', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'gr-zip-'))
  try {
    const bundle = join(root, 'gitrader-0.0.0-win-x64')
    mkdirSync(join(bundle, 'bin'), { recursive: true })
    writeFileSync(join(bundle, 'bin', 'gitrader.cmd'), 'x')
    writeFileSync(join(bundle, 'start.cmd'), 'x')
    const { archive } = packBundle(bundle, 'win-x64')
    const list = spawnSync(join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-tf', archive], { encoding: 'utf8' })
    assert.equal(list.status, 0)
    assert.match(list.stdout, /gitrader-0\.0\.0-win-x64\/bin\/gitrader\.cmd/)
    assert.equal(list.stdout.includes('\\'), false, '不该出现反斜杠')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('UX-04：bin/gitrader.cmd 新增的 GITRADER_LAUNCHER 行全是 ASCII（cmd 在 GBK 代码页下会把多字节注释拆坏）', () => {
  const lines = launcherCmd().split('\r\n').filter((l) => /GITRADER_LAUNCHER|^setlocal/.test(l))
  assert.ok(lines.length >= 3)
  for (const l of lines) assert.match(l, /^[\x20-\x7e]*$/)
})
