// SPDX-License-Identifier: CPAL-1.0
// R3-12：experiment create 的 subject 写错时，错误带 JSON 指针路径（/subject/strategy/…），不再只回「Invalid experiment input」；写对（带 sha256）能建成。
import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness } from './helpers/harness'
import type { Harness } from './helpers/harness'

const harnesses: Harness[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.cleanup())) })
const create = (subject: unknown, h: Harness): Promise<any> => h.k.lab.handle('create', { patch: { title: 'qa', hypothesis: 'qa', subject } }, h.human()) as Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
const message = (p: Promise<unknown>): Promise<string> => p.then(() => 'created', (e: { problem?: { name: string; message: string } }) => `${e.problem?.name}: ${e.problem?.message}`)

describe('experiment create 的 subject', () => {
  it('缺 kind / version：报 /subject/strategy/kind 和 /subject/strategy/version，并说明 sha256 从哪来', async () => {
    const h = await makeHarness(); harnesses.push(h)
    const m = await message(create({ strategy: { id: 'ema-cross' }, params: {} }, h))
    expect(m).toMatch(/^INVALID_PARAMS: /)
    expect(m).toContain('/subject/strategy/kind')
    expect(m).toContain('/subject/strategy/version')
    expect(m).toContain('strategySha256')
  })

  it('strategy / workflow / subject 本身形状不对也带路径', async () => {
    const h = await makeHarness(); harnesses.push(h)
    expect(await message(create({ strategy: 'ema-cross', params: {} }, h))).toContain('/subject/strategy must be an object')
    expect(await message(create({ workflow: { id: 'w' }, params: {} }, h))).toContain('/subject/workflow/kind')
    expect(await message(create('ema-cross', h))).toContain('/subject must be an object')
    expect(await message(create({ strategy: { kind: 'strategy', id: 'a', version: '1' }, params: [] }, h))).toContain('/subject/params')
  })

  it('照文档写全 {kind, id, version, sha256} 能建成，subject.strategy.id 保留', async () => {
    const h = await makeHarness(); harnesses.push(h)
    const exp = await create({ strategy: { kind: 'strategy', id: 'ema-cross', version: '0.1.0', sha256: `sha256:${'a'.repeat(64)}` }, params: {} }, h)
    expect(exp.experimentId).toMatch(/^exp_/)
    expect(exp.subject.strategy.id).toBe('ema-cross')
  })
})
