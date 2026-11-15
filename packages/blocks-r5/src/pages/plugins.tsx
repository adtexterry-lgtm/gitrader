// SPDX-License-Identifier: CPAL-1.0
// 插件页的块：id block.gitrader.plugins@0.1.0，配置 {tab: 'installed' | 'discover'}。
// plugin.grant / plugin.uninstall 在 FIRST_PARTY_ONLY_ACTIONS 里：只有这个一方 inline 块能发，第三方（iframe）清单声明它们会被校验拒绝。
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { Card, Unwired } from '../kit'
import { PluginsPageView } from '../views/plugins'
import { t } from '@gitrader/workbench/i18n'

/** 没有桥（单测里直接调函数、预览外）= 未接通；有桥才挂真页面（钩子都在 PluginsPageView 里，桥有无不随渲染变）。 */
function PluginsBlock(props: BlockProps) {
  if (!props.bridge) return <div data-page="plugins" data-g5-page="plugins"><Card title={t('插件')} data-page="plugins" data-g5-page="plugins"><Unwired message={t('未连接内核')} /></Card></div>
  return <PluginsPageView config={props.config} setConfig={props.setConfig} />
}

export const pluginsBlock = defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.plugins',
    name: t('插件'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-plugins' },
    isolation: 'inline',
    size: { minW: 6, minH: 5, defaultW: 15, defaultH: 9 },
    inputs: { queries: ['plugin.list', 'venue.status'] },
    actions: ['plugin.grant', 'plugin.start', 'plugin.stop', 'plugin.uninstall', 'plugin.reload'],
    permissions: [],
    fixtures: ['./fixtures/plugins.ts'],
  },
  component: PluginsBlock,
})

export const pluginsBlocks = [pluginsBlock]
