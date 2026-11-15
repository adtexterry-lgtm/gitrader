// SPDX-License-Identifier: CPAL-1.0
// 夹具预览（契约 §4.1 fixtures）：块不连内核，用 SDK 的夹具桥（createFixtureBridge）喂回放文件，在一个空白页里渲染。
// 由 test/render.browser.test.ts 用 esbuild 打成脚本后注入页面；window.mountPreview(blockId, rootEl) 挂载一个块。
import { createFixtureBridge, type BlockFixtures } from '@gitrader/blocks-sdk'
import { BridgeContext } from '@gitrader/blocks-sdk/preact'
import { h, render } from 'preact'
import agent from '../fixtures/agent-activity.json'
import positions from '../fixtures/positions.json'
import risk from '../fixtures/risk.json'
import statusbar from '../fixtures/statusbar.json'
import { defaultBlocks } from '../src/index'

const FIX: Record<string, unknown> = {
  'block.gitrader.positions': positions, 'block.gitrader.agent-activity': agent, 'block.gitrader.risk': risk, 'block.gitrader.statusbar': statusbar,
}
const TIME_KEYS = new Set(['ts', 'recordedAt', 'expiresAt', 'createdAt', 'updatedAt', 'openedAt', 'lastSeenAt', 'notAfter', 'notBefore', 'at'])

/** 回放文件里的时间是生成那一刻的绝对时间；预览时整体平移到"现在"，倒计时才有意义。 */
function rebase(v: unknown, shift: number, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => rebase(x, shift))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebase(x, shift, k)]))
  return typeof v === 'number' && TIME_KEYS.has(key) && v > 1e12 ? v + shift : v
}

declare global { interface Window { mountPreview(id: string, root: HTMLElement): void } }
window.mountPreview = (id, root) => {
  const def = defaultBlocks.find((d) => d.manifest.id === id)
  if (!def || !def.component) throw new Error(`没有这个块：${id}`)
  const raw = FIX[id] as { _now: number } & BlockFixtures
  const fx = rebase(structuredClone(raw), Date.now() - raw._now) as BlockFixtures
  const bridge = createFixtureBridge(def.manifest, fx)
  const C = def.component as (p: unknown) => never
  render(h(BridgeContext.Provider, { value: bridge }, h(C, { bridge, instanceId: 'bi_preview', config: {}, setConfig: () => undefined, channel: 'A', grid: { w: 15, h: 10 }, mode: 'preview' })), root)
}
