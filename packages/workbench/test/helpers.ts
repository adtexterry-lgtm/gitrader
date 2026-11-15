// SPDX-License-Identifier: CPAL-1.0
import { PLACEHOLDER_MANIFESTS } from '../src/core/placeholders'
import type { SizeLookup } from '../src/core/workspace'
import { parseBlockRef } from '@gitrader/blocks-sdk'

const byId = new Map(PLACEHOLDER_MANIFESTS.map((m) => [m.id, m]))

/** 用占位清单的尺寸约束做 sizeOf。 */
export const sizeOf: SizeLookup = (ref) => {
  const m = byId.get(parseBlockRef(ref).id)
  return m ? { ...m.size } : undefined
}
