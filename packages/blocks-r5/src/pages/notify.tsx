// SPDX-License-Identifier: CPAL-1.0
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { StubBlockView } from '../kit'
import { ChannelDetailCard, ChannelsCard, RulesCard } from '../views/notify'
import { t } from '@gitrader/workbench/i18n'

const VIEWS = { channels: ChannelsCard, rules: RulesCard, detail: ChannelDetailCard } as const
function NotifyBlock(props: BlockProps) {
  const view = typeof props.config?.view === 'string' ? props.config.view : ''
  const View = Object.hasOwn(VIEWS, view) ? VIEWS[view as keyof typeof VIEWS] : undefined
  return View ? <View /> : <StubBlockView page="notify" title={t('通知')} />
}

export const notifyBlocks = [defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.notify',
    name: t('通知'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-notify' },
    isolation: 'inline',
    size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
    inputs: { queries: ['config.view', 'plugin.list'] },
    actions: ['config.notify.set', 'notify.test'],
    permissions: [],
    fixtures: ['./fixtures/notify.ts'],
  },
  component: NotifyBlock,
})]
