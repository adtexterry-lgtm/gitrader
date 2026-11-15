// SPDX-License-Identifier: CPAL-1.0
// 实验详情：lab 块按 config.view 分流到这里。head / tier / assumptions / bias / data 各是一张卡（壳按分区各放一个实例）；
// detail = 一块出全页的竖排整栈（壳外预览、夹具场景用）。实验号取块配置的 experimentId，否则读联动组 experiment（壳把 #/lab/<id> 写进去）。
import type { TierId } from '../../model-lab'
import { useExperimentId } from './data'
import { HeadView } from './head'
import { AssumptionsView, BiasView, DataView } from './side'
import { TierCard } from './tier'

const TIERS: readonly TierId[] = ['forward', 'holdout', 'backtest']

export function LabDetailView({ config }: { config: Record<string, unknown> }) {
  const id = useExperimentId(config)
  const view = typeof config.view === 'string' ? config.view : 'detail'
  const tier = TIERS.find((t) => t === config.tier) ?? 'forward'
  switch (view) {
    case 'head': return <HeadView experimentId={id} />
    case 'tier': return <TierCard tier={tier} experimentId={id} />
    case 'assumptions': return <AssumptionsView experimentId={id} />
    case 'bias': return <BiasView experimentId={id} />
    case 'data': return <DataView experimentId={id} />
    default: return <div className="lab-stack" data-view="detail">
      <HeadView experimentId={id} />{TIERS.map((t) => <TierCard tier={t} experimentId={id} key={t} />)}
      <AssumptionsView experimentId={id} /><BiasView experimentId={id} /><DataView experimentId={id} />
    </div>
  }
}
