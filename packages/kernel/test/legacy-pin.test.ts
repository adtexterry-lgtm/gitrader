// SPDX-License-Identifier: CPAL-1.0
// 集成修补（H，v2 复验）：旧格式 pin.json（version 1，没有设备密钥）不能一直留着——验证通过即就地升级到 version 2，并给密钥库换钥。
import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceKey, fileProvider } from '../src/device-key'
import { PinStore } from '../src/pin'
import { FakeClock } from '../src/util/clock'
import { FAST_SCRYPT } from './helpers/harness'

describe('旧格式 PIN 文件（version 1）', () => {
  it('验证通过 → 先换钥再升级成 version 2（带设备密钥）；之后只拷走文件、没有设备密钥就验不了', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitrader-legacy-'))
    const clock = new FakeClock()
    try {
      const path = join(dir, 'pin.json')
      const oldKey = await new PinStore(path, clock, FAST_SCRYPT).setup('48291600') // 没有设备密钥 → version 1
      expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
      // 升级前先留一份旧文件：模拟"已经被拷走的旧备份"
      mkdirSync(join(dir, 'old'), { recursive: true }); copyFileSync(path, join(dir, 'old', 'pin.json'))
      const ps = new PinStore(path, clock, FAST_SCRYPT, new DeviceKey(join(dir, 'device.key.json'), fileProvider))
      const calls: Buffer[][] = []
      ps.onLegacyUpgrade = (o, n) => { calls.push([o, n]) }
      const key = await ps.verify('48291600')
      expect(calls).toHaveLength(1)
      expect(calls[0]![0]!.equals(oldKey)).toBe(true)
      expect(calls[0]![1]!.equals(key)).toBe(true)
      expect(key.equals(oldKey)).toBe(false)
      expect(ps.version()).toBe(2)
      expect((await ps.verify('48291600')).equals(key)).toBe(true) // 再验：v2 路径，不再升级
      expect(calls).toHaveLength(1)
      // 升级后的文件被拷到没有设备密钥的地方：正确 PIN 也过不了
      const copy = new PinStore(path, clock, FAST_SCRYPT, new DeviceKey(join(dir, 'elsewhere', 'device.key.json'), fileProvider))
      await expect(copy.verify('48291600')).rejects.toThrow(/device key/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('换钥回调失败 → 保持 version 1、照常放行（下次再试），不会把密钥库锁死', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitrader-legacy-'))
    const clock = new FakeClock()
    try {
      const path = join(dir, 'pin.json')
      const oldKey = await new PinStore(path, clock, FAST_SCRYPT).setup('48291600')
      const ps = new PinStore(path, clock, FAST_SCRYPT, new DeviceKey(join(dir, 'device.key.json'), fileProvider))
      ps.onLegacyUpgrade = () => { throw new Error('keystore busy') }
      expect((await ps.verify('48291600')).equals(oldKey)).toBe(true)
      expect(ps.version()).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
