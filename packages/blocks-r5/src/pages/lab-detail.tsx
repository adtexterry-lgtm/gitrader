// SPDX-License-Identifier: CPAL-1.0
import type { BlockProps } from '@gitrader/blocks-sdk'
import { StubBlockView } from '../kit'
import { LabDetailView } from '../views/lab-detail/index'
import { t } from '@gitrader/workbench/i18n'

/**
 * lab 块的详情分流目标（pages/lab.tsx 在 view = head / tier / assumptions / bias / data / detail 时渲染它）。
 * 带块配置 = 真视图；不带（桩时代的无参调用、壳外直接调）仍是「未接通」桩。
 */
export function LabDetailStub(props: Partial<Pick<BlockProps, 'config'>>) {
  return props.config ? <LabDetailView config={props.config} /> : <StubBlockView page="lab-detail" title={t('实验详情')} />
}
/** 详情没有自己的块 id：同块 lab 按 view 分流，清单在 pages/lab.tsx。 */
export const labDetailBlocks = []
