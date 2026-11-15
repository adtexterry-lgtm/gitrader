// SPDX-License-Identifier: CPAL-1.0
// 块注册表：占位块（壳自带，保证三个块位在 G 的块落地前也能摆出）+ blocks-default 的真块（同 id 覆盖占位）。
// 内核装载的插件块已通过 registry.register 与 BlockHost 接入 iframe 隔离桥。
// blocks-default 约定：导出 `defaultBlocks: BlockDefinition[]`（用 defineBlock 定义；一方 inline 块）。
import { BlockRegistry } from '@gitrader/blocks-sdk'
import * as BD from '@gitrader/blocks-default'
import { r5Blocks } from '@gitrader/blocks-r5'
import { PLACEHOLDER_MANIFESTS } from '../core/placeholders'
import { EmptyState } from '../ui/components/core.jsx'

function PlaceholderBody({ name }) {
  return <EmptyState compact art="no-data" />
}

/** 返回 { registry, firstParty }：firstParty 是随内核发布的一方块 id 集合（可带 proposal.approve 等一方专属命令）。 */
export function createRegistry(ui) {
  const selectedUi = ui ?? (typeof window !== 'undefined' && new URL(window.location.href).searchParams.get('ui') === 'r4' ? 'r4' : 'r5')
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-ui', selectedUi)
  const registry = new BlockRegistry()
  const firstParty = new Set()
  for (const m of PLACEHOLDER_MANIFESTS) {
    registry.register({ manifest: m, component: () => <PlaceholderBody name={m.name} />, placeholder: true })
    firstParty.add(m.id)
  }
  const real = Reflect.get(BD, 'defaultBlocks') ?? []
  for (const d of real) {
    registry.register(d)
    firstParty.add(d.manifest.id)
  }
  if (selectedUi === 'r5') {
    for (const d of r5Blocks) {
      registry.register(d)
      firstParty.add(d.manifest.id)
    }
  }
  return { registry, firstParty }
}
