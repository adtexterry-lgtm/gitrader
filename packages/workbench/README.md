> 许可证：CPAL-1.0 开源（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/workbench

工作台壳（Preact + esbuild 单文件，无 CDN）。当前是**最小检阅版**：固定布局（持仓与盈亏 / Agent 活动与待批 / 风险状态 三个块位 + 底部状态条）、设置（连接：网络主网 / 测试网；钥匙：PIN、钥匙导入）、关于（字标、版本、第三方声明抽屉含 KLineChart（含 TradingView 署名））、⌘K（四条：暂停 Agent / 撤销全部挂单 / 全部平仓 / 打开设置）、PIN 弹层、鉴权引导。

```
npm run build  -w @gitrader/workbench      # → dist/{index.html,app.js,app.css}（GITRADER_UI_OUT 改输出目录）
npm run test   -w @gitrader/workbench      # vitest：布局引擎 / 控制器 / ⌘K / 会话 / 偏好
npm run verify -w @gitrader/workbench      # 无头 Edge 冒烟（需要 playwright-core：npm i -D playwright-core，或 GITRADER_PLAYWRIGHT 指到它的目录；浏览器用 GITRADER_EDGE 或自动找 Edge / Chrome；截图目录 GITRADER_SHOTS）：三档截图 → reports/F-shots/（相对仓库根；GITRADER_SHOTS 可改），无滚动、控制台 0 错误、PIN / 钥匙 / ⌘K 旅程、视觉体检
node verify/serve.mjs                      # 起夹具内核 + 壳，打印 URL 与 PID（手工看 / 跑 design/run-audit.mjs）
```

## 对内核与 G 的约定

- **引导**：内核服务 `dist/index.html` 时把 `<!--BOOTSTRAP-->` 替换成 `<meta name="gitrader-bootstrap" content="一次性令牌">`；页面读完即从 DOM 抹掉，`POST /api/session {bootstrap}` 换 `{sessionToken, user, ws?}`，会话令牌只在内存。WS 线格式见 `@gitrader/blocks-sdk` 的 `src/client.ts` 头部注释。以上均为 TODO(protocol)，等 B 的 api/ 对齐；夹具内核（SDK 的 `testing` 子路径）按同一约定实现。
- **块**：G 在 `@gitrader/blocks-default` 导出 `defaultBlocks: BlockDefinition[]`（`defineBlock({manifest, component})`），壳按同 id 覆盖占位块。块只拿到 `bridge`（props 或 `@gitrader/blocks-sdk/preact` 的钩子），不直连内核。壳画瓦片的外框与块名，块只画内容（根元素撑满 100%，长内容自己用 `ScrollArea`）。
- **组件库**：`import { Card, Table, Button, ActorMark, ActorFilter, ... } from '@gitrader/workbench/ui'`（令牌 `theme.css`，只许 `var(--gr-*)`，不写颜色字面量）。「谁做的」小标 `ActorMark origin={...}` 与来源筛选器 `ActorFilter` + `matchesActorFilter(origin, filter)`（人 / 引擎 / LLM Agent / 系统，按内核盖章的 `origin.actorType`，缺省按 actor 前缀推断）是检阅块的固定件。
- **内核接口名**（`src/core/host-api.ts`，TODO(protocol)，改名只改这一个文件）：`settings.get` / `settings.network.set` / `pin.set` / `credential.import`（契约 §5.1）/ `takeover.<档>` / `trading_state.resume`；需要在场证明时内核回 `ATTESTATION_REQUIRED`，壳弹 PIN 层后带 `attestation:{method:'pin',pin}` 重发一次。

## 插件区、会话失效、动效

- **插件区**：固定布局下方、可折叠（状态记在本机）。内核 `plugin.blocks` 查询（[约定]，TODO(protocol)）返回 `{blocks:[{pluginId, manifest, moduleUrl}]}`，壳每 5 s 同步一次；清单必须通过 `validateBlockManifest`（`vendor = {name,url?}`、`fixtures` 数组，见 protocol v0.1.6）且 `isolation = "iframe"`。每个插件块一个 `sandbox="allow-scripts"` 的 iframe（不给 `allow-same-origin`），桥走 `iframe.ts`（postMessage + MessageChannel，清单约束在宿主桥里强制）。没有已装插件块时整个区域不出现。
  - **对内核的两个要求**：① 插件文件路由（夹具里是 `/plugins/<目录>/<文件>`，`moduleUrl` 指向它），响应必须带 `Access-Control-Allow-Origin: *`（sandbox 里源是 null，模块脚本要 CORS）；② 壳页面的 CSP 是 `script-src 'self'`，所以 iframe 的 srcdoc 里**没有内联脚本**：块标识经 iframe `name` 传入，由同源的 `/block-boot.js`（随 dist 发布）在入口模块之前写成 `window.__GITRADER_BLOCK__`。夹具内核用和真内核同一份 CSP，冒烟里真的撞过。
- **会话失效**：引导令牌缺失 / 已用 / 换票 401 → 先试 `GET /api/session/relink`（TODO(protocol)，B 在加；接受 `{sessionToken,user,ws?}` 或 `{bootstrap}`），仍不行 → 一张极简卡「会话已失效 · 在终端运行 `gitrader open --print` 获取新链接」（可复制命令、重试）；连不上内核是另一张卡「无法连接内核」。已在线的页面被内核关掉会话（WS 鉴权失败，客户端不再重连）也落到同一张卡。
- **动效**：不依赖任何动画库（GreenSock 标准许可不是 OSI 许可，不随本仓库分发）。`src/ui/motion.js` 用 CSS transition / Web Animations API / rAF：页面与 toast 入场淡入 + 上移 8 px（240 ms，不回弹）、数字滚动 300 ms、图表绘入 600 ms；悬停不放大不倾斜；全部尊重 `prefers-reduced-motion`。

## 已做 / 留口（总会话 2026-10-10 范围调整）

已做：上述最小检阅版；视觉系统搬运（主题令牌、74 图标、字标 B、组件库、插画）；`run-audit` 视觉体检；无纵向滚动条（`.gr-app` 视口即容器）。

留口（`src/core/` 里已有纯逻辑与测试，**界面未接**，等通知）：网格拖拽 / 缩放布局引擎（`workspace.ts`）、多工作区保存 / 加载 / Agent 改布局提示（`controller.ts` + `HostApi.workspace*`）、三套预设（`presets.ts`）、联动组 UI（`LinkHub` 在 SDK 里，宿主已把它传给每个块的桥）、完整 ⌘K（加命令往 `buildCommands` 追加）、块弹出窗（SDK 的 `attachWindowBridge` / `connectHostBridge` 已有）、钥匙生成 / 撤销（`HostApi.generateKey / revokeKey`）、主题 / 密度 / 导航左右界面（`PrefsStore` 与 `?nav=` `?density=` 参数已有）。

## 性能

壳空载首屏（夹具内核，本机无头 Edge，5 次中位数）：壳首次渲染约 40–50 ms，页面 load 完成约 60–70 ms（门槛 ≤ 1 s）。**8 块同屏 60 fps 的测法（由 H 实测）**：真内核 + G 的八块，DevTools Performance 录 10 s（行情推送开满、盘口 `maxHz` 按清单），看 Frames 的 DOM 帧时间 p95 ≤ 16.7 ms；或在页面里跑 `let n=0,t=performance.now();(function f(){n++;requestAnimationFrame(f)})();setTimeout(()=>console.log(n/((performance.now()-t)/1000)),10000)`，窗口必须可见（遮挡会被 Chromium 节流）。
