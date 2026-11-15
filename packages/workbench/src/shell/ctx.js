// SPDX-License-Identifier: CPAL-1.0
// 壳的全局上下文：内核客户端、控制器、联动中枢、块注册表、PIN 弹层请求、导航。
import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import { t } from '../ui/lib/i18n.js'

export const ShellCtx = createContext(null)

/** const { controller, kernel, registry, hub, go, requestPin, ... } = useShell() */
export function useShell() {
  const v = useContext(ShellCtx)
  if (!v) throw new Error(t('useShell 必须在壳内使用'))
  return v
}
