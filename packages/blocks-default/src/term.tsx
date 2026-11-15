// SPDX-License-Identifier: CPAL-1.0
import type { ComponentChildren } from 'preact'
import { Tooltip } from '@gitrader/workbench/ui'
import { t } from '@gitrader/workbench/i18n'
import { TERM_HELP } from './display'

// 名字既可能是中文原文（字典键）也可能是已翻译的显示名：两种都能查到释义
const HELP: Record<string, string> = { ...TERM_HELP, ...Object.fromEntries(Object.entries(TERM_HELP).map(([k, v]) => [t(k), v])) }

export function Term({ name, children, focusable = true }: { name: string; children?: ComponentChildren; focusable?: boolean }) {
  const text = HELP[name]
  return text ? <Tooltip text={text}><span tabIndex={focusable ? 0 : undefined}>{children ?? t(name)}</span></Tooltip> : <>{children ?? t(name)}</>
}
