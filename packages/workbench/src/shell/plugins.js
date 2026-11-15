// SPDX-License-Identifier: CPAL-1.0
// 已装插件块：内核 [约定] 查询 plugin.blocks → {blocks:[{pluginId, manifest, moduleUrl}]}（TODO(protocol)，内核装载 / 重载插件后即时反映）。
// 清单不合格（含 vendor / fixtures 形状）、不是 iframe 隔离的一律不渲染，并返回问题清单给日志。插件块不受信（不能带 proposal.approve）。
import { validateBlockManifest } from '@gitrader/blocks-sdk'
import { t } from '../ui/lib/i18n.js'

/** 把内核报告的插件块同步进注册表（新增注册、消失的注销）。返回 { defs, problems }。 */
export function syncPluginBlocks(registry, known, list) {
  const problems = []
  const defs = []
  const seen = new Set()
  for (const it of list || []) {
    const m = it && it.manifest
    const issues = validateBlockManifest(m)
    if (issues.length) { problems.push({ id: (m && m.id) || '?', issues }); continue }
    if (m.isolation !== 'iframe') { problems.push({ id: m.id, issues: [{ path: 'isolation', message: t('插件块必须是 iframe 隔离') }] }); continue }
    if (typeof it.moduleUrl !== 'string' || !it.moduleUrl) { problems.push({ id: m.id, issues: [{ path: 'moduleUrl', message: t('内核没有给出入口地址') }] }); continue }
    seen.add(m.id)
    const def = { manifest: m, remote: { moduleUrl: it.moduleUrl } }
    const prev = known.get(m.id)
    if (!prev || prev.remote.moduleUrl !== def.remote.moduleUrl || prev.manifest.version !== m.version) { registry.unregister(m.id); registry.register(def); known.set(m.id, def) }
    defs.push(known.get(m.id))
  }
  for (const id of [...known.keys()]) if (!seen.has(id)) { registry.unregister(id); known.delete(id) }
  return { defs, problems }
}
