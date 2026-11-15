// SPDX-License-Identifier: Apache-2.0
// 预览用的宿主页脚本（模仿壳的 BlockHost）：iframe 只给 allow-scripts（不给 allow-same-origin），宿主侧 attachWindowBridge 用夹具桥服务它。
// 夹具桥读回放文件，块不连内核也能跑；由 preview.browser.test.ts 用 esbuild 打包后注入页面。
import { attachWindowBridge, createFixtureBridge, type BlockFixtures, type BlockManifest } from '@gitrader/blocks-sdk'
import block from '../example/ema-reading/block.json'
import fixtures from '../example/ema-reading/fixtures/candles.json'

declare global { interface Window { mountBlock(js: string): HTMLIFrameElement } }

window.mountBlock = (js) => {
  const bridge = createFixtureBridge(block as unknown as BlockManifest, structuredClone(fixtures) as unknown as BlockFixtures)
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.style.cssText = 'width:420px;height:200px;border:0'
  const ids = JSON.stringify({ blockId: block.id, instanceId: 'bi_preview' })
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;color:#EDEDEF;font:13px/1.3 system-ui,"Microsoft YaHei UI",sans-serif}</style></head><body><div id="root"></div><script>window.__GITRADER_BLOCK__=${ids}</script><script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
  document.body.append(frame)
  attachWindowBridge(frame.contentWindow as Window, bridge)
  return frame
}
