// SPDX-License-Identifier: CPAL-1.0
// 参数解析 / 平台识别 / 文件名与 URL 规则（离线，不碰文件系统）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_NODE_VERSION, PLATFORMS, UsageError, archiveName, bundleDirName, compareVersions,
  detectPlatform, nodeArchiveName, nodeDistUrl, nodeExecutableName, parseArgs,
} from '../build-portable.mjs'

test('缺省参数：本机平台留空、Node 用默认版本、输出 dist-portable、要构建要打包', () => {
  const a = parseArgs([])
  assert.equal(a.platform, undefined)
  assert.equal(a.node, DEFAULT_NODE_VERSION)
  assert.equal(DEFAULT_NODE_VERSION, '22.23.2')
  assert.equal(a.runtimeDir, undefined)
  assert.equal(a.out, 'dist-portable')
  assert.equal(a.repoRoot, undefined)
  assert.equal(a.skipBuild, false)
  assert.equal(a.pack, true)
  assert.equal(a.help, false)
})

test('长选项两种写法等价，--node 去掉 v 前缀', () => {
  const a = parseArgs(['--platform', 'linux-x64', '--node', 'v22.13.1', '--out=out2', '--runtime-dir', 'rt'])
  assert.deepEqual([a.platform, a.node, a.out, a.runtimeDir], ['linux-x64', '22.13.1', 'out2', 'rt'])
})

test('--skip-build / --no-pack 是开关；--help 单独走', () => {
  const a = parseArgs(['--skip-build', '--no-pack'])
  assert.equal(a.skipBuild, true)
  assert.equal(a.pack, false)
  assert.equal(parseArgs(['--help']).help, true)
})

test('四种平台名都在允许集合里，其它平台名报用法错误', () => {
  for (const p of PLATFORMS) assert.equal(parseArgs(['--platform', p]).platform, p)
  assert.deepEqual(PLATFORMS, ['win-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'])
  assert.throws(() => parseArgs(['--platform', 'win-arm64']), (e) => e instanceof UsageError && e.code === 'USAGE')
})

test('未知参数 / 开关带值 / 缺值 / 非选项参数都不静默放过', () => {
  assert.throws(() => parseArgs(['--wat']), /未知参数/)
  assert.throws(() => parseArgs(['--skip-build=1']), /不接受值/)
  assert.throws(() => parseArgs(['--out']), /需要一个值/)
  assert.throws(() => parseArgs(['--out', '--skip-build']), /需要一个值/)
  assert.throws(() => parseArgs(['stray']), /多余的参数/)
})

test('Node 版本低于 22.13 或形状不对一律拒绝', () => {
  assert.throws(() => parseArgs(['--node', '20.11.0']), /低于 22\.13/)
  assert.throws(() => parseArgs(['--node', '22.12.0']), /低于 22\.13/)
  assert.throws(() => parseArgs(['--node', '22.12']), /x\.y\.z/)
  assert.throws(() => parseArgs(['--node', 'latest']), /x\.y\.z/)
  assert.equal(parseArgs(['--node', '22.13.0']).node, '22.13.0')
  assert.equal(parseArgs(['--node', '23.0.0']).node, '23.0.0')
})

test('本机平台识别：win32/linux 只认 x64，darwin 认 arm64 与 x64', () => {
  assert.equal(detectPlatform('win32', 'x64'), 'win-x64')
  assert.equal(detectPlatform('win32', 'arm64'), undefined)
  assert.equal(detectPlatform('linux', 'x64'), 'linux-x64')
  assert.equal(detectPlatform('linux', 'arm64'), undefined)
  assert.equal(detectPlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(detectPlatform('darwin', 'x64'), 'darwin-x64')
  assert.equal(detectPlatform('freebsd', 'x64'), undefined)
})

test('运行时文件名按平台后缀：Windows zip，其它 tar.gz', () => {
  assert.equal(nodeArchiveName('22.23.2', 'win-x64'), 'node-v22.23.2-win-x64.zip')
  assert.equal(nodeArchiveName('22.23.2', 'linux-x64'), 'node-v22.23.2-linux-x64.tar.gz')
  assert.equal(nodeArchiveName('22.23.2', 'darwin-arm64'), 'node-v22.23.2-darwin-arm64.tar.gz')
  assert.equal(nodeExecutableName('win-x64'), 'node.exe')
  assert.equal(nodeExecutableName('darwin-x64'), 'node')
})

test('下载地址拼法：nodejs.org/dist/v<ver>/<file>', () => {
  assert.equal(nodeDistUrl('22.23.2', 'SHASUMS256.txt'), 'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt')
  assert.equal(nodeDistUrl('22.23.2', 'node-v22.23.2-win-x64.zip'), 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip')
})

test('目录名与压缩包名：gitrader-<版本>-<平台>', () => {
  assert.equal(bundleDirName('0.1.1', 'win-x64'), 'gitrader-0.1.1-win-x64')
  assert.equal(archiveName('0.1.1', 'win-x64'), 'gitrader-0.1.1-win-x64.zip')
  assert.equal(archiveName('0.1.1', 'linux-x64'), 'gitrader-0.1.1-linux-x64.tar.gz')
})

test('版本比较只看数字段', () => {
  assert.equal(compareVersions('22.13.0', '22.13'), 0)
  assert.equal(compareVersions('22.12.9', '22.13.0'), -1)
  assert.equal(compareVersions('22.14.0', '22.13.0'), 1)
})
