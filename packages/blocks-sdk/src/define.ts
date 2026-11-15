// SPDX-License-Identifier: Apache-2.0
// 块定义 API：defineBlock（清单 + 组件 + 生命周期）与块注册表。宿主（workbench）用注册表把工作区条目解析成可渲染的块。
import type { BlockBridge } from './bridge'
import { parseBlockRef, validateBlockManifest, type BlockManifest } from './manifest'

/** 宿主传给块组件的属性。 */
export interface BlockProps {
  bridge: BlockBridge
  instanceId: string
  config: Record<string, unknown>
  /** 合并写回本实例的 config（宿主负责保存进工作区）。 */
  setConfig(patch: Record<string, unknown>): void
  channel: string
  /** 当前瓦片的网格尺寸（单位：网格）。 */
  grid: { w: number; h: number }
  /** tile = 工作区瓦片；popout = 独立窗口；preview = 开发预览。 */
  mode: 'tile' | 'popout' | 'preview'
}

export interface BlockDefinition {
  manifest: BlockManifest
  /** 一方 inline 块的组件（框架无关：Preact 函数组件满足 (props) => VNode）。清单 entry.element 指向自定义元素时可省略。 */
  component?: (props: BlockProps) => unknown
  /** 生命周期：实例挂载时调用，返回清理函数（卸载时调用）。 */
  setup?(props: BlockProps): void | (() => void)
  /**
   * 第三方块（isolation = iframe）的入口：宿主把 moduleUrl 放进 sandbox="allow-scripts" 的 iframe 里加载。
   * 模块里调 connectHostBridge({blockId, instanceId})（读 window.__GITRADER_BLOCK__）拿到远程桥，再自己渲染。
   * TODO(protocol): moduleUrl 由插件宿主（内核）给出，形状待 B 对齐。
   */
  remote?: { moduleUrl: string }
}

/** 定义一个块。清单不合格直接抛错（开发期尽早失败；插件宿主装载时用 validateBlockManifest 拿问题清单）。 */
export function defineBlock(def: BlockDefinition): BlockDefinition {
  const issues = validateBlockManifest(def.manifest)
  if (issues.length) throw new Error(`块清单不合格（${def.manifest?.id ?? '?'}）：` + issues.map((i) => `${i.path} ${i.message}`).join('；'))
  return def
}

export class BlockRegistry {
  private defs = new Map<string, BlockDefinition>()

  register(def: BlockDefinition): this {
    this.defs.set(`${def.manifest.id}@${def.manifest.version}`, def)
    return this
  }

  /** `id@version` 精确匹配；只给 id 或版本找不到时退到同 id 的最新注册版本。 */
  resolve(ref: string): BlockDefinition | undefined {
    const exact = this.defs.get(ref)
    if (exact) return exact
    const { id } = parseBlockRef(ref)
    let best: BlockDefinition | undefined
    for (const d of this.defs.values()) if (d.manifest.id === id) best = d
    return best
  }

  has(ref: string): boolean { return this.resolve(ref) !== undefined }
  list(): BlockDefinition[] { return [...this.defs.values()] }
  unregister(id: string): void { for (const k of [...this.defs.keys()]) if (k.startsWith(id + '@')) this.defs.delete(k) }
}
