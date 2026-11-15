// SPDX-License-Identifier: CPAL-1.0
// 界面偏好的 Preact 钩子：Table 等组件读密度。偏好仓库在 core/prefs.ts（壳启动时 setPrefsStore 注入）。
import { useEffect, useState } from 'preact/hooks'
import { PrefsStore, effectiveDensity } from '../../core/prefs'

let store = new PrefsStore()
export function setPrefsStore(s) { store = s }
export function getPrefsStore() { return store }

const viewportH = () => { try { return window.innerHeight } catch (_e) { return 900 } }

/** const L = useLayout() → { theme, nav, density(生效值), densityPref }。 */
export function useLayout() {
  const [p, setP] = useState(store.get())
  const [h, setH] = useState(viewportH())
  useEffect(() => store.subscribe(setP), [])
  useEffect(() => {
    const on = () => setH(viewportH())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return { ...p, density: effectiveDensity(p.density, h), densityPref: p.density }
}
