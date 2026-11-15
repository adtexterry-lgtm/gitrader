// SPDX-License-Identifier: CPAL-1.0
import { defineBlock, type BlockProps } from '@gitrader/blocks-sdk'
import { StubBlockView } from '../kit'
import { LabList } from '../views/lab-list'
import { LabDetailStub } from './lab-detail'
import { t } from '@gitrader/workbench/i18n'

const DETAIL_VIEWS = new Set(['head', 'tier', 'assumptions', 'bias', 'data', 'detail'])
function LabBlock(props: BlockProps) {
  const view = typeof props.config?.view === 'string' ? props.config.view : 'list'
  // P7 必须保留此分流；P8 只替换 LabDetailStub。
  if (DETAIL_VIEWS.has(view)) return <LabDetailStub config={props.config} />
  // 没有宿主桥（壳外直接调用）就没有内核可问：显示未接通桩，不假装有数据。
  return props.bridge ? <LabList /> : <StubBlockView page="lab" title={t('实验')} />
}

// 清单的 queries / actions 是宿主桥的放行名单。lab.get / lab.run / lab.export / lab.stage 是同块详情视图（P8）要用的，列表本身只用 lab.list。
// engine.strategies / account.list / lab.attach / lab.pack：详情前向卡「附加纸面运行」与回测卡「出证据包」（GQ-09 人面入口）；前两个查询要 account.read。
export const labBlocks = [defineBlock({
  manifest: {
    schema: 'gitrader-block/1',
    id: 'block.gitrader.lab',
    name: t('实验'),
    version: '0.1.0',
    vendor: { name: 'gitrader' },
    license: 'CPAL-1.0',
    entry: { module: './index.js', element: 'g5-lab' },
    isolation: 'inline',
    size: { minW: 1, minH: 1, defaultW: 1, defaultH: 1 },
    inputs: { queries: ['lab.list', 'lab.get', 'lab.run', 'lab.export', 'ledger.query', 'engine.strategies', 'account.list'] },
    permissions: ['ledger.read', 'account.read'],
    actions: ['lab.stage', 'lab.attach', 'lab.pack'],
    linkGroups: [{ group: 'experiment', mode: 'read' }],
    fixtures: ['./fixtures/lab.ts'],
  },
  component: LabBlock,
})]
