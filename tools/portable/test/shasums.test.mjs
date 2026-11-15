// SPDX-License-Identifier: CPAL-1.0
// 校验和与下载流程的离线单测：喂假的 SHASUMS256.txt + 假文件，覆盖「过」与「不过」两条路径。
// 不联网：fetch 全部由测试注入，解压步骤也由测试注入（真实解压由 extractArchive 负责，见 pack 测试的 zip 路径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BuildError, downloadNodeRuntime, expectedDigest, parseShasums, sha256Buffer, sha256File, verifyDigest,
} from '../build-portable.mjs'

const ASSET = 'node-v22.23.2-win-x64.zip'
const BODY = Buffer.from('not-a-real-node-archive-just-bytes')
const DIGEST = sha256Buffer(BODY)

const tmp = () => mkdtempSync(join(tmpdir(), 'gitrader-portable-sums-'))

/** 假响应：同一份对象既能当文本读也能当二进制读（真实 fetch 也是这样）。 */
const fakeResponse = (body) => ({
  ok: true,
  status: 200,
  text: async () => (typeof body === 'string' ? body : body.toString('utf8')),
  arrayBuffer: async () => {
    const b = Buffer.from(body)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  },
})

/** 假 fetch：按 URL 末段分派 SHASUMS256.txt 与归档文件。 */
function fakeFetch({ shasums, archive = BODY, seen = [] }) {
  return async (url) => {
    seen.push(url)
    if (url.endsWith('/SHASUMS256.txt')) return fakeResponse(shasums)
    return fakeResponse(archive)
  }
}

test('parseShasums：认 sha256sum 格式，忽略空行 / 注释 / 坏行，大小写归一', () => {
  const text = [
    '3f1a' + '0'.repeat(60) + '  node-v22.23.2-darwin-arm64.tar.gz',
    '',
    '# comment line',
    `${DIGEST.toUpperCase()}  ${ASSET}`,
    `${'a'.repeat(64)} *node-v22.23.2-linux-x64.tar.gz`,
    'not a shasum line',
    `${'b'.repeat(60)}  short-digest.zip`,
  ].join('\r\n')
  const map = parseShasums(text)
  assert.equal(map.size, 3)
  assert.equal(map.get(ASSET), DIGEST)
  assert.equal(map.get('node-v22.23.2-linux-x64.tar.gz'), 'a'.repeat(64))
  assert.equal(map.get('node-v22.23.2-darwin-arm64.tar.gz'), '3f1a' + '0'.repeat(60))
  assert.equal(map.has('short-digest.zip'), false)
  assert.equal(map.has('not a shasum line'), false)
})

test('expectedDigest：命中取小写，未命中抛 CHECKSUM_MISSING', () => {
  const text = `${DIGEST}  ${ASSET}\n`
  assert.equal(expectedDigest(text, ASSET), DIGEST)
  assert.throws(() => expectedDigest(text, 'node-v22.23.2-sunos.tar.gz'),
    (e) => e instanceof BuildError && e.code === 'CHECKSUM_MISSING')
})

test('verifyDigest：一致返回 true；不一致抛 CHECKSUM_MISMATCH 并带上文件名', () => {
  assert.equal(verifyDigest(DIGEST, sha256Buffer(BODY), ASSET), true)
  const wrong = 'f'.repeat(64)
  assert.throws(() => verifyDigest(wrong, DIGEST, ASSET), (e) => {
    assert.equal(e.code, 'CHECKSUM_MISMATCH')
    assert.match(e.message, /node-v22\.23\.2-win-x64\.zip/)
    assert.match(e.message, new RegExp(wrong))
    return true
  })
})

test('verifyDigest：期望值形状不对（空 / 太短 / 非十六进制）抛 CHECKSUM_MALFORMED', () => {
  for (const bad of ['', 'abc', 'z'.repeat(64), undefined]) {
    assert.throws(() => verifyDigest(bad, DIGEST, ASSET), (e) => e.code === 'CHECKSUM_MALFORMED')
  }
})

test('sha256File 与内存里的 sha256 一致（临时文件，不联网）', () => {
  const dir = tmp()
  try {
    const f = join(dir, 'payload.bin')
    writeFileSync(f, BODY)
    assert.equal(sha256File(f), DIGEST)
    assert.equal(readFileSync(f).length, BODY.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('downloadNodeRuntime（过）：校验通过后交给解压步骤，返回解压出的运行时目录', async () => {
  const dir = tmp()
  try {
    const seen = []
    let extracted = null
    const runtime = await downloadNodeRuntime({
      version: '22.23.2',
      platform: 'win-x64',
      destDir: join(dir, 'cache'),
      fetchImpl: fakeFetch({ shasums: `${'0'.repeat(64)}  other.zip\n${DIGEST}  ${ASSET}\n`, seen }),
      extract: (archive, platform, dest) => {
        extracted = { archive, platform, dest }
        mkdirSync(join(dest, 'node-v22.23.2-win-x64'), { recursive: true })
        writeFileSync(join(dest, 'node-v22.23.2-win-x64', 'node.exe'), '')
      },
      log: () => {},
    })
    assert.deepEqual(seen, [
      'https://nodejs.org/dist/v22.23.2/SHASUMS256.txt',
      'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip',
    ])
    assert.equal(runtime, join(dir, 'cache', 'unpacked', 'node-v22.23.2-win-x64'))
    assert.equal(extracted.platform, 'win-x64')
    assert.equal(sha256File(extracted.archive), DIGEST, '落盘的归档就是校验过的那份')
    assert.ok(existsSync(join(runtime, 'node.exe')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('downloadNodeRuntime（不过）：sha256 不匹配时抛错、删掉坏文件、不解压', async () => {
  const dir = tmp()
  try {
    let extractCalled = false
    const err = await downloadNodeRuntime({
      version: '22.23.2',
      platform: 'win-x64',
      destDir: join(dir, 'cache'),
      fetchImpl: fakeFetch({ shasums: `${'e'.repeat(64)}  ${ASSET}\n` }),
      extract: () => { extractCalled = true },
      log: () => {},
    }).then(() => null, (e) => e)
    assert.ok(err instanceof BuildError)
    assert.equal(err.code, 'CHECKSUM_MISMATCH')
    assert.equal(extractCalled, false, '校验没通过就不该解压')
    assert.equal(existsSync(join(dir, 'cache', ASSET)), false, '坏文件要删掉，不能留在缓存里下次复用')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('downloadNodeRuntime：清单里没有这个平台 → CHECKSUM_MISSING，且不发第二个请求', async () => {
  const dir = tmp()
  try {
    const seen = []
    const err = await downloadNodeRuntime({
      version: '22.23.2', platform: 'linux-x64', destDir: join(dir, 'cache'),
      fetchImpl: fakeFetch({ shasums: `${DIGEST}  ${ASSET}\n`, seen }), extract: () => {}, log: () => {},
    }).then(() => null, (e) => e)
    assert.equal(err.code, 'CHECKSUM_MISSING')
    assert.equal(seen.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('downloadNodeRuntime：清单 HTTP 失败 → DOWNLOAD_FAILED（不把错误当数据）', async () => {
  const dir = tmp()
  try {
    const err = await downloadNodeRuntime({
      version: '22.23.2', platform: 'win-x64', destDir: join(dir, 'cache'),
      fetchImpl: async () => ({ ok: false, status: 503 }), extract: () => {}, log: () => {},
    }).then(() => null, (e) => e)
    assert.equal(err.code, 'DOWNLOAD_FAILED')
    assert.match(err.message, /503/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
