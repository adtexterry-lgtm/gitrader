# 插件

> 字段级规范：[`plugin-protocol.md`](plugin-protocol.md)　·　十分钟上手：[`plugin-quickstart.md`](plugin-quickstart.md)

插件把"个性化的东西"装进 Gitrader：指标、数据源、保护器、面板块、技能包等。**文件丢进目录就是安装**，没有安装向导、没有市场。

> **当前现状**：内核可发现、校验、钉版本、授权并拉起 Node 插件；浏览器块已通过壳的 iframe 宿主接入，使用隔离桥与权限校验。先启用插件再把块加入工作区。

## 目录约定

```
~/.gitrader/plugins/<目录名>/gitrader-plugin.json      # 丢进去就是安装
~/.gitrader/plugins/<插件id>/<版本>/gitrader-plugin.json  # 也认这种落盘形态
```

丢进去后运行 `gitrader plugins reload`（服务在跑就通知服务，不在跑就离线扫一遍）。`gitrader plugins list` 看每个插件：通过还是被拒绝、已授予和待授予的权限、被拒的原因。每次安装 / 升级 / 移除都会写进账本。

校验用 `gitrader plugins check <目录>`，不需要装进去、不需要服务在跑：每行 `码  路径  说明`，最后一行 `ok <id>@<版本>` 或 `REJECTED <n> problem(s)`（退出码 0 / 2）；`--strict` 按"未签名不放行"的口径检查，`--json` 输出机器可读结果。启用用 `gitrader plugins grant <id> [权限名…]`（要 PIN，逐项授予；零权限插件不写权限名就是只启用；当前授权入口为命令行；先停服务再运行 `plugins grant`）。试调工具用 `gitrader plugins call <id> <工具> <入参>`，入参可以是字面 JSON、`@文件` 或 `-`（标准输入；Windows 上用 `@文件` 最省心）；服务在跑走服务，不在跑临时起内核；已启用但没运行的插件会在第一次调用时自动拉起。

两个可抄的例子在 `packages/plugin-template/example/`：`ema-reading`（一个 EMA 读数指标块）和 `position-size`（一个零权限的工具插件，第一次写插件从它抄起，步骤见 [`plugin-quickstart.md`](plugin-quickstart.md)）。

## 清单：`gitrader-plugin/1`

`gitrader-plugin.json` 的主要字段：`schema`、`id`、`kind`（`connector` / `datasource` / `factor` / `decision-model` / `executor` / `protector` / `strategy` / `workflow-template` / `engine` / `block` / `skill` / `layout-preset`）、`name`、`version`、`vendor`、`source`（含内容哈希）、`license`、`runtime`（`type`：`node` / `browser` / `builtin` 等）、`entry`、`permissions`、`ui.blocks`、`requires`、`signature`、`compat`。完整字段与校验规则以 `packages/protocol/src/plugin/manifest.ts` 和 `schemas/plugin.*.json` 为准。

M1 内核**只能拉起 `runtime.type = "node"` 的插件**（子进程）；别的运行时类型能通过清单校验，但启动时返回"M1 不支持"。

### `tools[]`：暴露给 Agent 的工具

每个工具一条：`name`、`desc`、`tags`、`input`（JSON Schema，必须是 `type: "object"`）、可选的 `output`（JSON Schema）和 `permissions`（必须是清单 `permissions` 的子集）。**没写进 `tools[]` 的工具，内核不转发**（`PLUGIN_TOOL_UNKNOWN`，5008）。调用时入参先过 `input`，不合是 `INVALID_PARAMS`（-32602，说明带字段路径）；声明了 `output` 的，返回值不合是 `PLUGIN_RESULT_INVALID`（5009），结果不会给到 Agent。工具声明了 `permissions` 的，每一项都要已授予，否则 `MANDATE_LIMIT`（2004）。浏览器运行时的块不走 `tools`（`TOOLS_NOT_CALLABLE`）。

```json
"tools": [
  { "name": "position_size", "desc": "…", "tags": ["utility", "risk"],
    "input": { "type": "object", "required": ["equity", "stop"], "properties": { "equity": { "type": "string" }, "stop": { "type": "string" } } },
    "output": { "type": "object", "required": ["qty"] },
    "permissions": [] }
]
```

### `evidence`：业绩与回测数字

`evidence: { claims: [...], notes? }`，每条声明是 `{ metric, value, basis, window: { from, to }, ref?, assumptions? }`。`value` 是十进制字符串，`basis` 是 `backtest` / `paper` / `live`。回测声明必须写 `assumptions`（成本、滑点、数据来源与区间），纸面和实盘声明必须带 `ref`；`window.from` 要早于 `window.to`。`claims` 可以是空数组：没有数字是诚实的答案。内核和界面原样展示数字，不做二次加工；`name` / `desc` / `risk.disclosure` / `evidence.notes` 里出现承诺收益的措辞会被拒装（`PROMISE_LANGUAGE`）。

### 启用

**启用** = 你本人至少确认过一次（`gitrader plugins grant`，哪怕不授予任何权限）。目录里出现、校验通过的插件，在启用前内核不转发任何工具调用（`MANDATE_LIMIT`，2004）。启用与授予的权限都持久化，重载后仍在，每次授予写账本。

## 钉版本 + 内容哈希

- 清单里的 `source.sha256` = 包内除清单外每个文件的 `{路径, sha256}`（按路径排序）的哈希。内核加载时重新算一遍，**对不上就拒绝**；插件跑起来之后内容变了，会被停掉。
- 改了任何文件，都要重新钉：`gitrader plugins pin <插件目录>`。
- 依赖（`requires`）必须是精确版本加哈希，不提供 `latest`。

## 签名与开发者模式

- 已签名插件：清单里的 `signature` 是对"清单（去掉签名）加文件清单"摘要的 Ed25519 签名，签名密钥必须在信任根里。信任根 = 内置信任根（**M1 为空**，发布时填入）加上你在 `gitrader.json` 的 `plugins.trustRoots` 里手动加的公钥。
- 未签名插件：只有 `plugins.developerMode: true` 才会加载（本地开发用）。未签名插件**不能**申请 `trade.live` 和 `venue.credentials`。
- 签名不对、密钥不在信任根里，插件直接被拒绝。

## 权限：默认拒绝

- 清单里**声明**了才可能有，声明了还要**你本人确认**（会话即可）后才授予，逐项授予，授予入账。没授予的权限，内核 API 层一律拒绝。
- 可申请的权限：`market.read`、`account.read`、`ledger.read`、`ledger.append`、`trade.paper`、`trade.propose`、`trade.live`（仍受授权书与风控闸约束）、`takeover.trigger`（只在自身作用域）、`venue.credentials`（仅连接器）、`net.fetch`、`fs.read.user`、`workspace.control`、`ui.block`、`notify.user`。
- **永远不可授予**，清单里一写就拒装：`withdraw`、`transfer`、`approval.decide`、`risk.relax`、`policy.write`、`mandate.issue`、`mandate.promote`、`credential.read`、`plugin.install`、`risk.temporaryRelax`。也就是说，插件不能提现、转账、批准提案、放宽风控、签发或升级授权书、读取明文凭据、装别的插件。
- **启用**：插件要先被你本人启用一次（`gitrader plugins grant <id>`），内核才会转发它的工具调用；零权限的工具插件只需要这一步。
- 工具调用放行条件：校验通过、已启用、工具已在 `tools[]` 声明、工具声明的权限全部已授予、入参合 schema。

## 隔离：不是安全沙箱

- Node 插件跑在**独立子进程**里：不继承你的环境变量、工作目录是插件目录、通过标准输入输出与内核通信，并带上 Node 的 `--permission` 与 `--allow-fs-read=<插件目录>`（限制文件读取和子进程）。
- **这不是安全沙箱。** 权限在内核 API 层强制（插件要拿数据只能经内核）；进程层的限制是尽力而为，Node 22 不强制网络限制。第三方插件的信任主要来自签名与来源审查。同一系统用户下的恶意代码不在保证范围，见 `docs/security.md`。
- 崩溃自动退避重启，并有定时健康检查。
- 第三方块（浏览器运行时）按设计在 `sandbox="allow-scripts"` 的 iframe 里跑（不给 `allow-same-origin`），只能经块桥拿清单里声明过的订阅 / 查询 / 命令；这一部分的壳侧接线见上面的"M1 现状"。
