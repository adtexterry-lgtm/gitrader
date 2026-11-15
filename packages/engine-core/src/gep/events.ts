// SPDX-License-Identifier: CPAL-1.0
// engine-core 出口上的事件序列校验（审计 L4-04）。
//
// 协议包的 `checkEventSequence` 假设调用方已经过 schema（FINDINGS-L1 的 L1-11 把它判为备注），
// 所以喂畸形事件时会在 `type.indexOf` / `e.seq` 上抛 TypeError；而它的文档写的是"返回问题列表"。
// 本包不改协议包：在 engine-core 的 proto 出口上加一层形状门，坏形状进 problems，永不抛。
// 形状合格的条目仍交给协议包判定（seq 严格递增、eventId 去重、type 与 stream 一致），
// 判定规则只有一份，不在这里复制。
import { checkEventSequence as protocolCheckEventSequence, type GepEvent } from '../../../protocol/src/gep/index'

/** `GepEvent` 的必需形状；缺一项就记一条 problem，不再往下传。 */
function shapeProblems(raw: unknown, index: number): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`event[${index}] is not an object`]
  }
  const e = raw as Record<string, unknown>
  const bad: string[] = []
  if (typeof e.seq !== 'number' || !Number.isFinite(e.seq)) bad.push('seq is not a finite number')
  if (typeof e.eventId !== 'string' || e.eventId === '') bad.push('eventId is not a non-empty string')
  if (typeof e.stream !== 'string' || e.stream === '') bad.push('stream is not a non-empty string')
  if (typeof e.type !== 'string') bad.push('type is not a string')
  return bad.length === 0 ? [] : [`event[${index}]: ${bad.join('; ')}`]
}

/**
 * 检查事件序列：形状不对的记一条 problem，形状合格的按协议判定
 * （seq 严格递增且无重复、eventId 无重复、type 与 stream 一致）。返回问题列表（空 = 通过）。
 */
export function checkEventSequence(events: readonly unknown[], prevSeq = 0): string[] {
  if (!Array.isArray(events)) return ['events is not an array']
  const problems: string[] = []
  const wellFormed: GepEvent[] = []
  events.forEach((raw, index) => {
    const bad = shapeProblems(raw, index)
    if (bad.length > 0) problems.push(...bad)
    else wellFormed.push(raw as GepEvent)
  })
  return problems.concat(protocolCheckEventSequence(wellFormed, prevSeq))
}
