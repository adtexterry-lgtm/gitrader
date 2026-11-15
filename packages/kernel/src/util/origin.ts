// SPDX-License-Identifier: CPAL-1.0
import { deriveOriginActorType } from '../proto'
import type { Actor, Origin, OriginVia } from '../proto'
import { newRequestId } from './ids'

/** 造 Origin：requestId 由 Gitrader 生成；actorType 由 actor 前缀推出（行为人不能自报）。 */
export function mkOrigin(actor: Actor, tool: string, via: OriginVia, extra: Partial<Pick<Origin, 'onBehalfOf' | 'causation' | 'requestId'>> = {}): Origin {
  return { actor, actorType: deriveOriginActorType(actor), tool, requestId: extra.requestId ?? newRequestId(), via, ...(extra.onBehalfOf ? { onBehalfOf: extra.onBehalfOf } : {}), ...(extra.causation ? { causation: extra.causation } : {}) }
}
export const systemOrigin = (tool: string, component = 'kernel'): Origin => mkOrigin(`system:${component}`, tool, 'internal')
