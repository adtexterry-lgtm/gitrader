> 许可证：Apache-2.0。本包 Apache-2.0，可自由嵌入，无署名要求。

# @gitrader/plugin-template

两个最小的插件示例：一个**指标块**（`example/ema-reading/`，EMA 读数）和一个**工具插件**（`example/position-size/`，仓位计算，见下面「工具型插件示例」）。想写自己的插件，复制其中一个改名就行；第一次写从工具插件开始，步骤见 [`docs/plugin-quickstart.md`](../../docs/plugin-quickstart.md)。

## 装上它

把整个目录丢进 `~/.gitrader/plugins/`，重载：

```
cp -r example/ema-reading ~/.gitrader/plugins/ema-reading
gitrader plugins reload
```

工作台里出现「EMA 读数」块（块目录里加进布局即可）。没有安装步骤，没有向导：**文件丢进去就是安装**。

示例没有签名，内核只在开发者模式下加载未签名插件：`gitrader.json` 里 `plugins.developerMode` 设为 `true`。未签名的插件不能申请 `trade.live` / `venue.credentials`，这个示例也用不到。

## 目录里有什么

```
ema-reading/
  gitrader-plugin.json   插件清单（gitrader-plugin/1）：谁、什么版本、要什么权限、内容哈希
  block.json             这个块的清单（gitrader-block/1）：订阅什么、能查什么、能发什么命令、尺寸
  block.js               块本身（单文件 ESM，由 src/block.ts 打出来）
  fixtures/candles.json  离线回放：块不连内核也能渲染
```

## 权限怎么声明

**默认全部拒绝**，清单里写了才有，写了用户还要同意。这个示例只要两项：

| 清单 | 内容 | 含义 |
|---|---|---|
| `gitrader-plugin.json` → `permissions` | `["market.read", "ui.block"]` | 读行情；以块的形式出现在界面里 |
| `block.json` → `permissions` | `["market.read"]` | 块能订阅 / 查询的范围（必须是插件权限的子集） |
| `block.json` → `inputs.events` | `market.candles`，`maxHz: 1` | 只订阅 K 线，高频主题必须声明频率上限 |
| `block.json` → `inputs.queries` | `market.candles` | 只能查 K 线历史 |
| `block.json` → `actions` | 没有 | 不发任何命令；批准提案、下单、接管都不在第三方块的可申请范围内 |

块清单里没声明的订阅 / 查询 / 命令，桥一律拒绝（`test/plugin.test.ts` 逐条验证）。第三方块在 `sandbox="allow-scripts"` 的 iframe 里跑（不给 `allow-same-origin`）：碰不到宿主页面、没有存储、不联网，只能经块桥拿数据。**永远不可授予**的权限（提现、转账、批准、改风控、读凭据、装插件…）写进清单会被直接拒装。

## 钉版本 + 哈希

`gitrader-plugin.json` 的 `source.sha256` 是目录内容的哈希（除清单本身以外每个文件的路径与 sha256，排序后求哈希）。内核加载时重新算一遍，对不上就拒装；插件跑起来后内容变了也会被停掉。改了任何文件都要重新钉：

```
gitrader plugins pin ~/.gitrader/plugins/ema-reading     # 或在本包里：npm run build（先打包再钉）
```

`requires` 里的依赖必须是精确版本 + 哈希（这个示例没有依赖）。

## 开发与预览

```
npm run build -w @gitrader/plugin-template     # src/block.ts → example/ema-reading/block.js，并重新钉 example/ 下每个示例的哈希
npm test -w @gitrader/plugin-template          # 纯函数单测 + 清单 / 哈希 / 权限 + 内核加载器对拍 + 无头浏览器里的 iframe 预览
```

**预览（harness）**：`test/host-entry.ts` 模仿壳的块宿主——iframe 只给 `allow-scripts`，宿主用 SDK 的 `attachWindowBridge` + `createFixtureBridge`（读 `fixtures/candles.json`）服务它。块不连内核，用回放文件就能跑；`test/preview.browser.test.ts` 在无头 Edge 里验证渲染、随事件更新、切周期、以及确实被隔离。壳里的 iframe 宿主已接入；这里另外验证块在同一套桥协议上能跑、能过清单校验。

## 工具型插件示例：`example/position-size/`

一个 Node 运行时、**零权限、不联网**的技能包，只暴露一个工具 `position_size`：`qty = equity × riskPct ÷ 100 ÷ |entry − stop|`，8 位小数向下取整，入参出参都是十进制字符串。

```
position-size/
  gitrader-plugin.json   清单：kind skill、permissions []、tools[]（入参 / 出参 JSON Schema）、compat、内容哈希
  index.mjs              position_size 本体；作为进程入口时用 gsp.mjs 起循环
  gsp.mjs                通用循环（40 行以内）：serve({ tools: { 工具名: async (args) => 结果 } })
  decimal.mjs            BigInt 定点（8 位小数）：parse / format / absDiff / mulDiv，金额不走浮点数
```

`gsp.mjs` 处理 `plugin.hello` / `plugin.health` / `plugin.shutdown` / `tool.call`：未知方法或未声明的工具回 JSON-RPC `-32601`，工具里抛 `InvalidParams` 回 `-32602`（比如 `entry === stop`），其余异常回 `-32603`（message 不带堆栈）。日志只写 stderr。想加自己的工具：在 `serve({ tools })` 里加一个函数，并在清单 `tools[]` 里加同名声明（没声明的工具内核不转发）。

装上、启用、调用：

```
cp -r example/position-size ~/.gitrader/plugins/position-size
gitrader plugins reload
gitrader plugins grant skill.example.position-size
gitrader plugins call skill.example.position-size position_size '{"equity":"10000","riskPct":"1","entry":"100","stop":"95"}'
# → {"qty":"20.00000000"}
```

`test/position-size.test.ts` 覆盖：纯函数（向下取整、对称、`entry === stop`）、清单与哈希、直接起子进程验 GSP 循环、再用真内核对拍（启用前被拒 2004 → 启用后返回 `{ qty: "20.00000000" }`；缺 `stop` 为 -32602；未声明的工具为 5008）。`npm run build -w @gitrader/plugin-template` 会重新钉 `example/` 下**每个**示例的哈希，也可以单独运行 `node scripts/pin.mjs`。

## 任意语言与远程 GSP

需要任意可执行文件或 Python 插件时，使用已有的 `sidecar` /
`python-sidecar` 运行时和 `x-launch` 扩展，见
[插件协议 §6.1–6.3](../../docs/plugin-protocol.md#61-任意可执行文件)。
[Python 参考插件](../protocol/examples/python-plugin/README.md) 提供
hello、describe、health、shutdown、echo 与一键 G01–G08 验证；
[GSP 迷你套件](../protocol/conformance/README.md#gsp-迷你一致性套件)
支持 GSP_LAUNCH 子进程及 GSP_ENDPOINT 远程目标。
本包旧 Node 工具示例保持原有简版循环，尚未具备迷你套件要求的令牌、
版本协商与 describe，应先按参考实现补齐再宣称通过。
本地可执行旁车以当前用户全权运行，没有沙箱。内核远程 ws/wss 本轮在 inspect/start 返回 5002（remote plugins arrive with S3-C），不建立连接；GSP_ENDPOINT 仅是独立套件入口。S3-C 完成帧大小与隐私边界门禁后才可解锁，wss + mTLS 未实测。

## 换成现成的指标库

`src/ema.ts` 是纯函数实现（前 N 根的简单平均当种子，再按 `k = 2/(N+1)` 递推），没有依赖。想用 [trading-signals](https://github.com/bennycode/trading-signals) 之类的库：装进本包依赖（要钉精确版本），把 `ema()` 换成库调用，其余不用动；重新 `npm run build`，哈希会更新。

## 它是怎么读行情的

1. 握手：`connectHostBridge()`（宿主在 `window.__GITRADER_BLOCK__` 里给 `blockId` / `instanceId`）。
2. 启动时 `bridge.query('market.candles', …)` 取最近 200 根 15 分钟 K 线预热；之后订阅 `market.candles`，同一根（同开盘时间）的更新覆盖、新 K 线追加。
3. 标的跟着联动组 `symbol`（只读）走；别的块切了标的，这里自动重订。
4. 只画数字：EMA 值、最新收盘价、收盘价相对 EMA 的偏离。颜色只用 `currentColor` 和透明度，跟随宿主。
