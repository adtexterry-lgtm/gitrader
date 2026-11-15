// SPDX-License-Identifier: CPAL-1.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyExport } from '../src/ledger'
import type { ExportManifest } from '../src/ledger'
import type { LedgerEntry } from '../../protocol/src'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

let h: Harness
let sessionToken = ''

beforeEach(async () => {
  h = await makeHarness()
  const started = await h.k.start({ port: 0 })
  sessionToken = h.k.auth.exchangeBoot(started.bootToken).sessionToken
})
afterEach(async () => { await h.cleanup() })
function serverUrl(protocol: 'http' | 'ws' = 'http'): string {
  const address = h.k.http?.server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server address unavailable')
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `${protocol}://${host}:${address.port}`
}

const op = async (name: string, params: unknown) => {
  const res = await fetch(`${serverUrl()}/api/op/${name}`, {
    method: 'POST', headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
  })
  return { status: res.status, json: await res.json() as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('B3 confined file operations', () => {
  it('rejects an absolute ledger export destination before writing outside exports', async () => {
    const outside = join(h.home, 'outside-export')

    const result = await op('ledger.export', { dir: outside })

    expect(result.status).toBe(400)
    expect(result.json.error).toMatchObject({ name: 'INVALID_PARAMS' })
    expect(statSync(h.home).isDirectory()).toBe(true)
    expect(() => statSync(outside)).toThrow()
  })

  it('exports to a nested relative directory and verifies the ledger roundtrip', async () => {
    const result = await op('ledger.export', { dir: 'nested/valid' })
    expect(result.status).toBe(200)
    const dir = join(h.home, 'exports', 'nested', 'valid')
    const entries = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LedgerEntry)
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ExportManifest
    expect(verifyExport(entries, manifest).ok).toBe(true)
  })

  it('rejects an existing linked export output before writing any artifact', async () => {
    const dir = join(h.home, 'exports', 'nested')
    const target = join(h.home, 'outside-export-target')
    mkdirSync(join(h.home, 'exports'), { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'ledger.jsonl'), 'unchanged')
    symlinkSync(target, dir, 'junction')
    const before = h.k.ledger.count()

    const result = await op('ledger.export', { dir: 'nested' })

    expect(result.status).toBe(400)
    expect(result.json.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'Invalid ledger export destination' })
    expect(readFileSync(join(target, 'ledger.jsonl'), 'utf8')).toBe('unchanged')
    expect(h.k.ledger.count()).toBe(before)
    expect(() => statSync(join(dir, 'manifest.json'))).toThrow()
  })

  it('rejects lab.verify reading a valid JSON file outside lab', async () => {
    const outside = join(h.home, 'outside-canary.json')
    writeFileSync(outside, JSON.stringify({ schema: 'gitrader-experiment-export/1' }))

    const result = await op('lab.verify', { file: outside })

    expect(result.status).toBe(400)
    expect(result.json.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'Invalid experiment export input' })
  })

  it('reads a valid experiment JSON file through a relative lab path', async () => {
    mkdirSync(join(h.home, 'lab', 'nested'), { recursive: true })
    writeFileSync(join(h.home, 'lab', 'nested', 'valid.json'), JSON.stringify({}))

    const result = await op('lab.verify', { file: 'nested/valid.json' })

    expect(result.status).toBe(200)
    expect(result.json.result.status).toBe('diff')
  })

  it('rejects a lab directory and a file larger than 8 MiB with the fixed error', async () => {
    mkdirSync(join(h.home, 'lab', 'nested'), { recursive: true })
    const large = join(h.home, 'lab', 'nested', 'large.json')
    writeFileSync(large, ' '.repeat(8 * 1024 * 1024 + 1))

    for (const file of ['nested', 'nested/large.json']) {
      const result = await op('lab.verify', { file })
      expect(result.status).toBe(400)
      expect(result.json.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'Invalid experiment export input' })
    }
  })

  it('rejects a lab symlink even when its target remains within the home', async () => {
    mkdirSync(join(h.home, 'lab'), { recursive: true })
    mkdirSync(join(h.home, 'lab-source-dir'), { recursive: true })
    const target = join(h.home, 'lab-source-dir', 'linked.json')
    writeFileSync(target, JSON.stringify({}))
    symlinkSync(join(h.home, 'lab-source-dir'), join(h.home, 'lab', 'linked'), 'junction')

    const result = await op('lab.verify', { file: 'linked/linked.json' })

    expect(result.status).toBe(400)
    expect(result.json.error).toMatchObject({ name: 'INVALID_PARAMS', message: 'Invalid experiment export input' })
  })
})
