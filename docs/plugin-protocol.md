<!-- SPDX-License-Identifier: CPAL-1.0 -->
# 插件协议 `gitrader-plugin/1`（r2 修订，2026-10-13）

> 这是 Gitrader 五个底座协议里的第一个。别的插件作者会基于它写插件，所以这里精确到字段：每个字段的类型、默认值、校验规则、拒绝时的错误码。类型与 JSON Schema 的唯一出处仍是 `packages/protocol`（`src/plugin/manifest.ts`、`schemas/plugin.json`）；本文是它们的规范说明，两者冲突以代码为准并视为缺陷。
>
> 用户视角的操作说明在 `docs/plugins.md`；十分钟上手在 `docs/plugin-quickstart.md`。

## 0. 一页结论

- 一个插件 = 一个目录 + 一份 `gitrader-plugin.json`。**目录丢进 `~/.gitrader/plugins/` 就是安装**，没有安装向导、没有市场。
- 清单回答五个问题：你是谁（`id` / `vendor` / `version` / `source`）、你要什么（`permissions` / `net` / `secrets`）、你给什么（`kind` / `provides` / `tools` / `ui`）、你怎么跑（`runtime` / `entry` / `install`）、凭什么信你（`source.sha256` / `signature` / `compat` / `evidence`）。
- **默认拒绝**：清单里没声明的权限不存在；声明了还要用户本人逐项确认；确认过的权限才在内核放行。永远不可授予的十项权限写进清单即拒装。
- **工具必须声明**：插件暴露给 Agent 的每个工具都要写 `tools[]`（名字、说明、语义标签、入参 schema、可选出参 schema、所需权限）。没声明的工具内核不转发；入参按 schema 校验；出参声明了就校验。
- **诚实优先**：`evidence` 只接受带口径（回测 / 纸面 / 实盘）与时间窗的声明；回测声明必须附假设清单；前向声明必须附可核引用。文案里出现承诺收益类用语直接拒装。
- **r2 相对 M1 只做追加**：新增 `tools[]`、`evidence` 定型、结构化错误码、`compat` 真正生效、承诺用语检查、启用语义。仓内已有的清单不改一个字仍然通过校验；写法不规范的老清单可能因 `id` 前缀、`vendor.id`、`evidence` 定型这几条新规则被拒，码会说明怎么改。

## 1. 五条红线 → 设计对应

| 红线 | 本协议如何保证 | 落点 |
|---|---|---|
| 1 一切皆插件 | 引擎核心只认清单与五类通道（GSP 子进程通道、块桥、GEP 引擎、MCP、REST）；功能以 `kind` 分槽，同 kind 允许多实例并可排序（`instances`、内核绑定表）；新增功能先问"能不能写成一个 kind"。内核不内置任何 kind 的业务实现：随包的连接器、模拟场所、参考引擎也走同一份清单 | §3 `kind`、§7 实例 |
| 2 用户拥有第一性 | 清单与插件全部是用户目录里的文件；无"必须上传才能用"的字段——`privacy.hosted=true` 的插件必须同时申请 `net.fetch` 并列出主机白名单（`PRIVACY_HOSTED_WITHOUT_NET`）；`privacy.sends` 如实声明、可为空，但声明了就必须有 `net.fetch`（`PRIVACY_SENDS_WITHOUT_NET`）；`secrets[]` 只是句柄名，明文永不进插件进程；`credential.read` 永不可授予；连接器拿到的是签名句柄不是私钥 | §4 权限、§5.6 隐私一致性 |
| 2 / 3 用户拥有第一性 / 模型不碰钱 | 工具入参索要密钥 → `TOOL_SOLICITS_SECRET` 静态拒装 | §3.9 |
| 3 模型不碰钱 | 没有任何权限能让插件直接触达场所：`trade.propose` 只产出提案进内核状态机；`trade.live` 只给执行器 / 引擎且仍受授权书与风控闸约束；`decision-model` 这个 kind 不能申请任何 `trade.*`；`approval.decide` / `risk.relax` / `risk.temporaryRelax` / `policy.write` / `mandate.*` 永不可授予。风控闸门本身是第二个底座协议，不是插件 | §4 权限矩阵 |
| 4 前向才作数 | `evidence.claims[]` 每条必须写 `basis`（`backtest` / `paper` / `live`）与 `window`；`backtest` 必须附 `assumptions`；`paper` / `live` 必须附 `ref`（实验注册表或账本引用，格式由第三个协议定）；界面与 MCP 展示时 `backtest` 一律标"假设性" | §5.5 证据 |
| 5 零承诺语言 | `name` / `desc` / `tools[].desc` / `risk.disclosure` / `evidence.notes` 里出现承诺收益类用语 → `PROMISE_LANGUAGE`，拒装 | §5.7 |

## 2. 文件与目录

```
~/.gitrader/plugins/<目录名>/gitrader-plugin.json          # 丢进去就是安装
~/.gitrader/plugins/<插件id>/<版本>/gitrader-plugin.json    # 也认这种落盘形态
```

- 目录名随意；身份看清单里的 `id`，不看目录名。同一 `id` 出现多次，`version` 最高的生效，其余被拒（`DUPLICATE_ID`，规则见 §5.1）。
- 清单文件名固定 `gitrader-plugin.json`，UTF-8，JSON（不是 JSON5 / YAML）。
- 目录内除清单外的每个文件都参与内容哈希（`node_modules/` 顶层目录除外）。
- 重载：`gitrader plugins reload`（服务在跑就通知服务，不在跑就离线扫一遍）。每次安装 / 升级 / 移除都写账本。

## 3. 清单字段（顶层）

类型记法：`Ms` = 整数毫秒；`Sha256` = `sha256:` + 64 位十六进制；`Decimal` = 十进制字符串。"必填"指 JSON Schema `required`。未列出的字段一律放行（§8 兼容规则）。

| 字段 | 类型 | 必填 | 默认 | 校验 | 说明 |
|---|---|---|---|---|---|
| `schema` | `"gitrader-plugin/1"` | 是 | — | 常量 | 清单格式。主版本号变了才会变 |
| `id` | string | 是 | — | `^[a-z0-9-]+(\.[a-z0-9-]+){2,}$` | `<kind>.<vendor>.<name>` 三段以上。r2 起前缀必须等于 `kind`（`decision-model` 的前缀写 `decision`）：`ID_PREFIX_MISMATCH` |
| `package` | `"skill"` \| `"block"` | 是 | — | 枚举 | 分发形态只有两种：技能包（教 Agent、带工具）与块包（界面块）。`package=skill` 时 `kind` 必须是 `skill`：`PACKAGE_KIND_MISMATCH` |
| `kind` | 见 §3.1 | 是 | — | 枚举 | 插件在底座上占哪个槽 |
| `name` | string | 是 | — | 非空，≤ 80 字符 | 展示名。承诺用语检查 |
| `desc` | string | 是 | — | 非空，≤ 400 字符 | 一段话说明。承诺用语检查 |
| `tags` | string[] | 是 | — | — | 自由标签，供目录检索 |
| `version` | string | 是 | — | 精确语义化版本 `x.y.z[-pre]` | 不接受范围，不接受 `latest` |
| `vendor` | §3.2 | 是 | — | — | 作者身份 |
| `source` | §3.3 | 是 | — | — | 出处 + 内容哈希（钉版本） |
| `license` | §3.4 | 是 | — | — | 许可信息 |
| `runtime` | §3.5 | 是 | — | — | 怎么跑 |
| `entry` | §3.6 | 视 runtime | — | — | 入口 |
| `install` | §3.7 | 是 | — | `requireHashes` 必为 `true` | 安装方式 |
| `permissions` | 权限名[] | 是 | — | 枚举，不重复；见 §4 | **缺省就是全部拒绝**，所以必须显式写（可为 `[]`） |
| `net` | `{hosts: string[]}` | 声明 `net.fetch` 时 | — | 主机名或 `*.` 通配，非空：`NET_HOSTS_EMPTY` | 出网白名单 |
| `secrets` | string[] | 否 | `[]` | — | 需要用户提供的密钥**句柄名**（如 `"coingecko_api_key"`）；明文由内核保管，插件只拿到句柄 |
| `config` | object | 否 | `{}` | — | 插件自己的配置模板；实例配置在内核绑定表里 |
| `privacy` | `{hosted, sends[]}` | 是 | — | 见 §5.6 | 数据去向声明 |
| `tos` | `{commercial, redistribute, attribution}` | `kind=datasource` 时 | — | — | 数据条款 |
| `mcp` | §3.8 | runtime 为 `stdio-mcp` / `remote-mcp` 时 | — | — | MCP 服务器描述 |
| `provides` | object | 是 | — | 按 kind | 提供物（连接器写 `{venue, capabilities}`，引擎写 `{gep}`，块写 `{blocks}`） |
| `tools` | §3.9 | 否 | `[]` | 见 §3.9 | **r2 新增**。暴露给 Agent 的工具清单 |
| `protector` | `{rules?, pre?, budgetMs?}` | `kind=protector` 时 | — | 仅 `protector` kind 可声明；`rules` 只允许内置规则且不得自带 `source`（由内核并入时写入） | 保护器规则与预检能力 |
| `instances` | `{multiple, ordered, max?}` | 否 | `{multiple:false, ordered:false}` | `max ≥ 1` | 同 kind 可否多实例、是否有顺序 |
| `ui` | `{blocks: (object\|string)[]}` | `kind=block` 时 | — | — | 块清单引用（`gitrader-block/1`） |
| `engine` | `{gep, launch?}` | `kind=engine` 时 | — | `gep.versions/transports/modes` 非空 | GEP 引擎声明 |
| `evidence` | §3.10 | `kind ∈ {strategy, factor, decision-model}` 时 | — | 见 §5.5 | **r2 定型**。业绩 / 效果声明 |
| `fixtures` | `{offline: string[], smoke: string[]}` | 是 | — | — | 离线回放与冒烟夹具路径（可为空数组） |
| `risk` | `{disclosure, worstCase, builderAttribution:"off"}` | `kind ∈ {strategy, executor}` 时 | — | 非空字符串 | 风险披露。承诺用语检查 |
| `requires` | §3.11 | 否 | `[]` | 版本精确 + 哈希 | 依赖钉死 |
| `compat` | `{gitrader, gep?, pluginSchema}` | 是 | — | 见 §8 | **r2 起真正生效**：不满足即拒装 |
| `signature` | §3.12 | 发布时 | — | — | Ed25519 签名；没有它只能在开发者模式加载 |
| `x-*` | 任意 | 否 | — | 协议 schema 不校验 | 扩展字段；GSP 宿主识别 `x-launch`（§6.1–6.2），其他扩展原样保留 |

### 3.1 `kind`（12 种，槽位）

| kind | 槽位 | 典型运行时 | 备注 |
|---|---|---|---|
| `connector` | 场所连接 | node / sidecar | 唯一能申请 `venue.credentials` 的 kind；拿到的是签名句柄 |
| `datasource` | 数据提供器 | node / sidecar / stdio-mcp / rest | 必须写 `tos`；数据一律自带 Key |
| `factor` | 因子 / 本地分类模型 | node / sidecar | 不得配置远端端点（`FACTOR_HAS_NET`） |
| `decision-model` | 快决策模型 | sidecar / rest | 只能产出概率与置信度，不能申请 `trade.*` |
| `executor` | 执行器 | node / sidecar / engine | 可申请 `trade.live`，仍过风控闸 |
| `protector` | 风控规则（保护器） | node / builtin | 全部叠加，任一拒绝即拒绝；规则参数改动走签名快照（第二个协议） |
| `strategy` | 策略 | engine / node | 必须写 `evidence` 与 `risk` |
| `workflow-template` | 编排模板 | builtin | 工作流 JSON 为一等接口 |
| `engine` | 引擎 / 回测内核 | sidecar / 远程 | 必须写 `engine.gep`；语言无关 |
| `block` | 界面块 | browser | 必须写 `ui.blocks`；跑在 `sandbox="allow-scripts"` 的 iframe |
| `skill` | 技能包（SKILL.md + 工具） | node / stdio-mcp | `package` 必须是 `skill`；**工具型插件的默认 kind** |
| `layout-preset` | 布局预设 | builtin | 新手预设靠它，不另做界面 |

要加新 kind：先在 `packages/protocol/CHANGELOG.md` 登记，补 §4 权限矩阵一行、GSP 方法集、`provides` 形状，缺一不加。候选（统计检验包、模型网关、账本导出、插件注册表）见文末待拍板清单。

### 3.2 `vendor`

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `id` | string | 是 | 非空；必须等于 `id` 的第二段：`VENDOR_ID_MISMATCH` |
| `name` | string | 是 | 非空 |
| `kind` | `builtin` \| `partner` \| `community` \| `self` | 是 | 枚举 |
| `verified` | boolean | 是 | 只有 `builtin` / `partner` 且已签名时内核才会把它当真；未签名清单里写 `true` 会被内核改回 `false` 展示 |
| `url` | string \| null | 否 | — |

### 3.3 `source`

| 字段 | 类型 | 必填 | 校验 |
|---|---|---|---|
| `repo` | string | 是 | 非空（本地开发写 `local/<名>`） |
| `commit` | string | 是 | 40 位十六进制（本地开发可全 0） |
| `sha256` | Sha256 | 是 | = `sha256(JCS(制品清单))`，制品清单 = 目录内除清单外每个文件的 `{path, sha256}` 按路径排序。内核重算，对不上 → `HASH_MISMATCH` |
| `fetchedAt` | Ms | 是 | — |
| `inspiredBy` | string | 否 | 借鉴出处（许可合规用） |

用 `gitrader plugins pin <目录>` 自动写 `source.sha256`。**改了清单以外的任何文件都要重新 pin**（清单本身不进哈希，只改清单不用重新 pin）。

### 3.4 `license`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `spdx` | string | 是 | SPDX 标识，如 `Apache-2.0` |
| `redistribute` | `bundle` \| `implement` \| `user-install` \| `reference-only` | 是 | 能否随包分发 |
| `notice` | string | 是 | 给用户看的一句话 |
| `commercialUse` | boolean | 是 | — |
| `attribution` / `weightsLicense` | string | 否 | — |
| `dependencies[]` | `{name, spdx, redistribute}` | 否 | LGPL / GPL 依赖逐个列出 |

### 3.5 `runtime`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | `builtin` \| `node` \| `sidecar` \| `python-sidecar` \| `browser` \| `stdio-mcp` \| `remote-mcp` \| `rest` | 是 | GSP 支持 `node`，以及带 `x-launch` 的 `sidecar` / `python-sidecar`；远程入口见 §6.2；其他本地运行时返回 5002 |
| `node` | string | 否 | 建议的 Node 主版本 |
| `python` | string | 否 | 仅 Python 旁车的可选便利，`^\d+\.\d+$` |
| `native` | boolean | 是 | 是否含原生二进制 |
| `diskMB` | number ≥ 0 | 是 | 占盘估计 |
| `download[]` | `{name, source, sizeMB, sha256, consent:"required"}` | 否 | 需要额外下载的东西，每项都要用户同意 |

### 3.6 `entry`

| runtime | 必填项 | 校验 |
|---|---|---|
| `node` | `module`（相对路径） | 文件必须存在（`ENTRY_NOT_FOUND`）且在插件目录内（`ENTRY_ESCAPES`）；缺失 → `ENTRY_MISSING` |
| `browser` | `module` + `element` | 同上 |
| `sidecar` / `python-sidecar` | `transport`；stdio 用 `x-launch.command` | ws/wss 本轮返回 5002，清单 tokenRef 忽略；见 §6.1–6.2；历史 `entry.command[]` 单独存在时仍不执行 |
| `remote-mcp` / `rest` | `url` | 非 loopback 必须 `https` / `wss` |
| `builtin` | 无 | — |

### 3.7 `install`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `by` | `bundle` \| `user-consent` \| `user-install` \| `remote` | 是 | 谁把它装上 |
| `detect` / `lockfile` | string | 否 | 已装检测命令 / 锁文件 |
| `requireHashes` | `true` | 是 | 写别的值 schema 直接拒 |

### 3.8 `mcp`

`{transport, url?, command?, tools: {allow: string[], deny: string[]}}`。`allow` / `deny` 是对上游 MCP 工具名的过滤；经过过滤后仍要在 `tools[]` 里逐个声明才会被内核暴露（r2）。

### 3.9 `tools[]`（r2 新增）

每个暴露给 Agent 的工具一条。没写在这里的工具，内核不转发（`PLUGIN_TOOL_UNKNOWN`，5008）。

| 字段 | 类型 | 必填 | 默认 | 校验 |
|---|---|---|---|---|
| `name` | string | 是 | — | `^[A-Za-z0-9_-]{1,64}$`（与主流模型供应商的函数名约束一致：字母、数字、下划线、连字符，不允许点），同一清单内唯一：`TOOL_NAME_DUPLICATE` |
| `desc` | string | 是 | — | 非空，≤ 200 字符；承诺用语检查 |
| `tags` | string[] | 是 | — | 语义标签，供工具面按意图筛选（第五个协议）。推荐词表 `PLUGIN_TOOL_TAGS`：`market` `account` `ledger` `risk` `backtest` `signal` `factor` `data` `utility` `ui`；词表开放，自定义标签放行 |
| `input` | JSON Schema（2020-12）object | 是 | — | 必须是 `type: "object"` 且能编译：`TOOL_SCHEMA_INVALID`。调用时入参不合 → `INVALID_PARAMS`（-32602），`message` 带字段路径 |
| `output` | JSON Schema object | 否 | — | 声明了就校验返回值；不合 → `PLUGIN_RESULT_INVALID`（5009），结果不转发给 Agent |
| `permissions` | 权限名[] | 否 | `[]` | 必须是 `manifest.permissions` 的子集：`TOOL_PERMISSION_UNDECLARED`。调用时每项都要已授予，否则 `MANDATE_LIMIT`（2004） |

规则：
- `runtime.type = browser` 的插件不能有 `tools`（块经块桥工作，不走 `tool.call`）：`TOOLS_NOT_CALLABLE`。
- `input` / `output` 不接受异步校验（`$async`）；`pattern` 不接受"量词套在含量词或分支的分组上"的写法（如 `(a+)+`、`(a|aa)+`、`(foo|bar)+`、`^[a-z]+(-[a-z]+)*$`——这条规则宁可误杀，改成不嵌套的写法即可）、回溯引用或超过 256 字符；整份 schema 不超过 64 KB：均报 `TOOL_SCHEMA_INVALID`。目的是降低第三方 schema 让内核主线程灾难性回溯的风险；没有分组的多项式回溯（如 `^.*.*.*=$`）目前挡不住，是已知残余风险，彻底办法（不受信校验放进 worker 并加超时）另立项。
- 返回值序列化超过 1 MiB → `PAYLOAD_TOO_LARGE`（5007），不校验也不转发。
- `provides.tools` 只是给目录看的摘要，不参与校验；以 `tools[]` 为准。
- 工具入参密钥索要检查（`TOOL_SOLICITS_SECRET`）：只扫描成功序列化且未超上限的 `tools[i].input` JSON Schema，不扫 `output`、清单级 `config`、`enum` / `const` 的值或 `default` / `examples` 里的标量（对象 / 数组照常遍历）；其余所有对象与数组子节点递归扫描。`properties` 映射名和 `required[]` 字符串按键名规则扫描，`patternProperties` / `$defs` / `definitions` / `dependentSchemas` 的映射名不扫描但其值继续遍历；映射名恰为 `enum`、`default` 等时仍按映射处理。键名经 NFKC、移除 Unicode 格式字符、camelCase 拆分及空白 / `_` / `-` / 点 / 冒号 / 数字分隔后，按连续完整词元或末尾复数匹配；含中文时再按归一后的中文词表子串匹配。文本限于各节点的 `title` / `description`，先做 camelCase 与连字符 / 下划线拆分，再复用 `normalizeForScan` 的繁简归一，英文按词界、中文按子串匹配；句柄说明仍会拒绝。词表以 `secret-solicit.ts` 为准，并入内核词表独有的 `seed`。原始属性名恰为 `seed`、父属性名为 `spec` 且其直接 schema 的 `type` 为 `number` / `integer` 时放行该键（仅 `spec.seed`，其他父级一律拒）；`required[]` 中的 `seed` 仅当所属对象为 `spec` 且同级 `properties.seed.type` 明确为数值类型时放行。string、未声明类型、`seed phrase` / `seed words` 仍拒；此例外不跳过该节点的 `title` / `description`。键名最后词元（含复数）为 `ref` / `id` / `handle` / `hash` / `fingerprint` / `digest` / `name` 时放行，但不放行说明文字；单独的 `token`、`key`、`publicKey`、`address` 不命中。文本没有否定放行，宁可误杀。同一节点按属性名、`title`、`description` 的顺序只报一条，命中后仍继续扫描子 schema。

### 3.10 `evidence`（r2 定型）

```
evidence: { claims: EvidenceClaim[], notes?: string }
EvidenceClaim: { metric: string, value: Decimal, basis: "backtest"|"paper"|"live",
                 window: { from: Ms, to: Ms }, ref?: string, assumptions?: string[] }
```

`claims` 必填但可为空数组——"没有数字"是诚实答案。规则见 §5.5。

### 3.11 `requires[]`

`{kind: "plugin"|"pypi"|"npm"|"binary", name, version, sha256}`。`version` 必须精确（`REQUIRES_VERSION_INEXACT`），`sha256` 必填。没有 `latest`。

### 3.12 `signature`

`{alg: "ed25519", keyId, digest, sig}`。`digest = sha256(JCS(清单去掉 signature) ‖ JCS(制品清单))`；`sig` 是对 `digest` 的 Ed25519 签名（base64）；`keyId` 必须在信任根里（内置信任根 + `gitrader.json` 的 `plugins.trustRoots`）。

- 不在信任根：`SIGNATURE_KEY_UNTRUSTED`；摘要不符：`SIGNATURE_DIGEST_MISMATCH`；验签失败：`SIGNATURE_INVALID`。
- 没有签名：只有 `plugins.developerMode: true` 才加载（`UNSIGNED_NOT_ALLOWED`），且不得申请 `trade.live` / `venue.credentials`（`UNSIGNED_FORBIDDEN_PERMISSION`）。

## 4. 权限模型

三层，缺一不可：**声明**（清单 `permissions`）→ **授予**（用户本人、逐项、入账）→ **放行**（内核 API 层每次调用检查）。声明只是"可能有"，不是"有"。

### 4.1 可申请的 14 项与 kind 矩阵

| 权限 | 含义 | 可申请的 kind |
|---|---|---|
| `market.read` | 读行情 | 全部 |
| `account.read` | 读账户 / 持仓 | 全部 |
| `ledger.read` | 读账本 | 全部 |
| `ledger.append` | 追加账本（信号 / 决策 / 备注） | 全部 |
| `trade.paper` | 在纸面账户执行 | strategy, executor, engine |
| `trade.propose` | 产出提案（进内核状态机，人批） | strategy, executor, engine |
| `trade.live` | 实盘执行（仍受授权书 + 风控闸） | executor, engine |
| `takeover.trigger` | 触发自保动作（停新开仓 / 撤单 / 全平 / 自降级），只在自身作用域 | protector, executor, engine, block |
| `venue.credentials` | 使用场所凭据（签名句柄，不是私钥） | connector |
| `net.fetch` | 出网（须 `net.hosts`） | datasource, decision-model, connector, engine |
| `fs.read.user` | 读用户指定的文件 | engine, factor, datasource |
| `workspace.control` | 改布局 | block, skill |
| `ui.block` | 作为块出现在界面 | block |
| `notify.user` | 给用户发通知 | protector, engine, block |

kind 不在表里却申请 → `PERMISSION_KIND_MISMATCH`；不认识的权限名 → `PERMISSION_UNKNOWN`。

### 4.2 永远不可授予的 10 项（写进清单即拒装：`PERMISSION_NEVER_GRANTABLE`）

`withdraw`、`transfer`、`approval.decide`、`risk.relax`、`policy.write`、`mandate.issue`、`mandate.promote`、`credential.read`、`plugin.install`、`risk.temporaryRelax`。

插件不能提现、转账、批准提案、放宽风控（含临时放宽）、写风控策略、签发或升级授权书、读明文凭据、装别的插件。这十项没有任何配置能打开。

### 4.3 授予与启用（r2 明确）

- `plugin.grant(id, permissions[], 在场证明)`：只能授予清单里声明过的；逐项；写账本 `plugin.permission_granted`；持久化，重载后仍在。
- **启用** = 用户至少确认过一次（`grant` 调用过，哪怕 `permissions: []`）。没启用的插件，内核不转发任何工具调用（`MANDATE_LIMIT`，2004）。这保证"目录里出现"≠"Agent 能用"。
- 工具调用放行条件：插件校验通过 ∧ 已启用 ∧ 工具已声明 ∧ 工具 `permissions` 全部已授予 ∧ 入参合 schema。检查顺序与错误：没有这个插件 / 校验没过 → `INVALID_PARAMS`（消息里列出问题码）；未启用 → `MANDATE_LIMIT`；未声明 → `PLUGIN_TOOL_UNKNOWN`；入参不合 → `INVALID_PARAMS`；权限未授予 → `MANDATE_LIMIT`。
- 放行后若插件进程还没运行，内核自动拉起（相当于 `start`）；支持 Node 和带合法 `x-launch` 的 `sidecar` / `python-sidecar`；不支持的本地运行时及本轮关闭的 ws/wss 返回 `CAPABILITY_UNSUPPORTED`（5002）。
- 撤销：`plugin.uninstall`（在场证明）停进程、删目录、删授予记录；账本记录永不删除。

### 4.4 强制程度（如实）

权限在**内核 API 层**强制。进程权限限制只用于 Node 插件（不继承宿主业务环境、工作目录为插件目录、`--permission --allow-fs-read=<插件目录>`）；这不是完整安全沙箱，Node 22 不强制网络限制。普通可执行旁车以当前用户全权运行，**没有沙箱**，可直接访问该用户可访问的文件和网络；环境白名单与 cwd 校验不限制这些能力。需要隔离时由用户提供操作系统隔离。第三方插件的信任主要来自签名与来源审查；同一系统用户下的恶意代码不在保证范围（`docs/security.md` T-C）。

**M1 现状**：Node 插件还没有"插件 → 内核"的宿主调用通道（`host.*`），所以 `market.read` 这类权限对 Node 插件目前只是声明与授予记录，还没有可调用的数据面；块（browser 运行时）经块桥已有订阅 / 查询面。宿主调用通道是下一个增量（见待拍板清单）。

## 5. 校验规则（语义层，JSON Schema 管不到的）

校验分两层：JSON Schema（结构、枚举、格式）→ 语义检查（跨字段）。任一层失败即拒绝，不启动、不登记为块。所有问题结构化返回：`{code, path, message, hint?}`。

**结构层没过就不做语义层**：一份清单可能要修两轮才干净——先修结构层报的 `SCHEMA`，再看语义层的码；`gitrader plugins check` 多跑几轮直到 `ok`。例外：结构层在 `/permissions/N` 的枚举失败直接映射成 `PERMISSION_NEVER_GRANTABLE` 或 `PERMISSION_UNKNOWN`（hint 列出 14 个合法权限名）。结构层过了之后，语义层、哈希、签名、入口、兼容的问题一次报全。

### 5.1 身份
- `ID_PREFIX_MISMATCH`：`id` 第一段 ≠ `kind`（`decision-model` 对应前缀 `decision`）。
- `VENDOR_ID_MISMATCH`：`id` 第二段 ≠ `vendor.id`。
- `DUPLICATE_ID`：同一目录树里多个清单同 `id`，只保留 `version` 最高的那个（版本相同取已装的那个，再相同取路径排序靠前的），其余拒绝并在消息里指出赢家目录。升级后，已授予的权限只保留新清单仍声明的那些；启用状态保留。
- `PACKAGE_KIND_MISMATCH`：`package=skill` 但 `kind≠skill`。

### 5.2 权限
- `PERMISSION_NEVER_GRANTABLE` / `PERMISSION_UNKNOWN` / `PERMISSION_KIND_MISMATCH`（§4）。
- `NET_HOSTS_EMPTY`：声明 `net.fetch` 但 `net.hosts` 空。
- `FACTOR_HAS_NET`：`kind=factor` 配置了 `net`。
- `UNSIGNED_FORBIDDEN_PERMISSION`：未签名却申请 `trade.live` / `venue.credentials`。

### 5.3 kind 必填项
- `KIND_REQUIRES_FIELD`：`engine` 缺 `engine.gep`；`datasource` 缺 `tos`；`strategy` / `factor` / `decision-model` 缺 `evidence`；`strategy` / `executor` 缺 `risk`；`block` 缺 `ui.blocks`；MCP 运行时缺 `mcp`。

### 5.4 工具（§3.9）
`TOOL_NAME_DUPLICATE`、`TOOL_SCHEMA_INVALID`、`TOOL_PERMISSION_UNDECLARED`、`TOOLS_NOT_CALLABLE`。
`TOOL_SOLICITS_SECRET`：工具入参或其说明文字索要密钥，安装前拒装；见 §3.9。

### 5.5 证据
- `EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS`：`basis=backtest` 的声明没有非空 `assumptions`（至少写明成本、滑点、数据来源与区间）。
- `EVIDENCE_FORWARD_NEEDS_REF`：`basis=paper` / `live` 的声明没有 `ref`。
- `EVIDENCE_WINDOW_INVALID`：`window.from ≥ window.to`。
- 数字永不修饰：`value` 原样展示；内核与界面不做任何"年化""剔除异常"之类的二次加工。

### 5.6 隐私一致性
- `PRIVACY_SENDS_WITHOUT_NET`：`privacy.sends` 非空但没有申请 `net.fetch`（数据不可能离开本机，声明不自洽）。
- `PRIVACY_HOSTED_WITHOUT_NET`：`privacy.hosted=true` 但没有 `net.fetch` / `net.hosts`。
- 反过来允许：有 `net.fetch` 但 `sends: []`（只拉数据、不发用户数据）。

### 5.7 承诺用语
`PROMISE_LANGUAGE`：`name` / `desc` / `tools[].desc` / `risk.disclosure` / `evidence.notes` 命中 `PLUGIN_PROMISE_PATTERNS`（中英各若干条：保证收益、保本、必胜、躺赚、零风险、无风险、guaranteed、risk-free、"can't lose" 等；完整正则以 `manifest.ts` 为准）。命中即拒装，`message` 指出命中的词。

### 5.8 完整性与信任
`HASH_MISMATCH`、`UNSIGNED_NOT_ALLOWED`、`SIGNATURE_KEY_UNTRUSTED`、`SIGNATURE_DIGEST_MISMATCH`、`SIGNATURE_INVALID`、`ENTRY_MISSING`、`ENTRY_NOT_FOUND`、`ENTRY_ESCAPES`、`MANIFEST_UNREADABLE`（不是 JSON / 读不到）、`SCHEMA`（JSON Schema 层失败，`path` 指向字段）。

### 5.9 兼容
`COMPAT_SCHEMA_UNSUPPORTED`、`COMPAT_RANGE_INVALID`、`COMPAT_GITRADER_UNSATISFIED`（§8）。

## 6. 生命周期

```
installed ──start──▶ starting ──hello 成功──▶ ready ◀──健康恢复── degraded
    ▲                                    │                         ▲
    │                                    ├──健康检查失败 / 进程退出──┘
    │                                    │
    └────── stop ──▶ stopping ──▶ stopped       连续崩溃 ≥ 5 次 / 10 分钟 ──▶ failed
```

| 状态 | 含义 |
|---|---|
| `installed` | 扫描到且校验通过（或失败，看 `ok`），未启动 |
| `starting` | 子进程已拉起，等 `plugin.hello` 回应（5 s） |
| `ready` | 握手成功，可接 `tool.call` |
| `degraded` | 健康检查失败或进程退出后等待重启；仍保留记录 |
| `stopping` / `stopped` | shutdown RPC 最多 1 s，随后退出宽限默认 5 s；exit 后 stdio 排空最多再等 2 s |
| `failed` | 10 分钟内崩溃 5 次，不再自动重启，通知用户 |

常量（`PLUGIN_HEALTH`）：健康检查每 10 s、超时 3 s、连续 3 次失败即重启；窗口内第 n 次失败后等待 min(1 s × 2^(n−1), 60 s)，第 5 次直接 failed；关机 RPC 超时 1 s，退出宽限默认 5 s（shutdownGraceMs），exit 后 stdio 排空默认 2 s（stdioCloseGraceMs）。

**GSP 通道（Node 与本地可执行旁车）**：JSON-RPC 2.0 over stdio NDJSON，内核 → 插件方向：`plugin.hello {gsp, token, plugin:{id,version}, permissions, config}`、`plugin.health {}`、`plugin.shutdown {}`、`tool.call {tool, args}`。插件返回里任何名为 `privateKey` / `secret` / `mnemonic` 一类的字段整条丢弃（`SECRET_FIELD_REJECTED`，5006）。插件返回 JSON-RPC `error` 时：`-32602` 转成 `INVALID_PARAMS`，`-32601` 转成 `CAPABILITY_UNSUPPORTED`（5002），其余一律 `INTERNAL`（4001）；`message` 原样透传，不翻译、不改写。插件 → 内核方向（`host.*`）M1 未开通。

**写一个工具的约定**（Node 运行时）：处理函数收到 `tool.call` 的 `params.args`（已经按 `tools[].input` 校验过），返回一个 JSON 可序列化的值（若声明了 `tools[].output`，返回前会被校验）；参数虽合 schema 但业务上不可接受（如入场价等于止损价）时返回 JSON-RPC error `{code: -32602, message}`；没实现的工具返回 `-32601`（调用方看到 5002）；其他异常返回 `-32603`（调用方看到 4001）。模板 `packages/plugin-template/example/position-size/gsp.mjs` 已把这套循环写好：抛 `InvalidParams` 即 `-32602`，抛别的 `Error` 即 `-32603`，照抄即可。

重载时内容哈希变了的运行中插件会被停掉；目录消失的插件停掉并写 `plugin.removed`。

### 6.1 任意可执行文件

`sidecar` 与 `python-sidecar` 是冻结 schema 已有的运行时，不新增 `exec` 枚举。
启动配置放顶层 `x-launch` 扩展中，内部复用 `EngineLaunchCommand` 校验：

```json
{
  "runtime": { "type": "sidecar", "native": false, "diskMB": 1 },
  "entry": { "transport": "stdio" },
  "x-launch": { "command": "<executable>", "args": ["plugin.py"], "cwd": ".", "env": {} }
}
```

`command` 直接执行，不经 shell；`args` 原样传递。`cwd` 默认插件目录，
相对路径也从插件目录解析；inspect 即校验 x-launch，cwd 越界以 ENTRY_ESCAPES 拒绝，任何 transport 均不能绕过 entry.module 检查。环境显式传入 PATH、Windows 的 SystemRoot、显式
`env` 与宿主生成的 `GITRADER_GSP_TOKEN`；显式 env 不能覆盖该通道令牌。
Windows 运行时还会自动补入 HOMEDRIVE、HOMEPATH、LOGONSERVER、SYSTEMDRIVE、TEMP、USERDOMAIN、USERNAME、USERPROFILE、WINDIR 等系统键；环境回归测试核对完整键集合。HOME、其他通道令牌及宿主业务变量均不继承。不要在清单 env 写业务凭据。
这不是操作系统沙箱：普通旁车有当前用户的文件与网络权限。

hello 超时 5 s、普通 RPC 10 s、health 每 10 s / 超时 3 s / 连续失败 3 次重启；
握手失败与退出计入同一 10 分钟窗口；等待 min(1 s × 2^(n−1), 60 s)，第 5 次进入 failed。shutdown 请求超时 1 s，
随后退出宽限默认 5 s；超时尝试终止持有的进程树，Windows taskkill 失败时兜底终止持有的 child。等到 exit 后，stdio 默认最多再排空 2 s，超时销毁句柄，避免孙进程继承 stdout 导致挂住；这不保证结束已脱离父进程的孙进程。stop 同时取消待重启，
显式 start 才恢复。Node 的启动参数、权限模型与环境保持原样。
仅有历史 `entry.command[]`、没有 `x-launch` 的旁车仍返回 5002。

### 6.2 远程 ws 插件

`entry.transport` 为 `ws` / `wss` 时，本轮 inspect 与 start 一律返回 Problem 5002：
`remote plugins arrive with S3-C`。不建连接、不读取通道凭据、不写连接账本。
清单 URL 位于 `entry.url`；`x-launch.auth.tokenRef` 被忽略，inspect 会给出 warning。
宿主仅按插件 id 派生 `env:GITRADER_PLUGIN_TOKEN_<ID>`：ID 转大写，非字母数字替换为下划线。

S3-C 解锁前必须完成：WebSocket 整帧 JSON 解析（允许多行）、`maxWsFrameBytes` 上限；
非 loopback 必须 wss，并要求 `privacy.hosted=true` 与 `net.hosts` 包含目标主机；
握手失败与断开共享重试窗口，并补真实传输与凭据边界验收。
保留的适配器复用引擎客户端，当前不可从插件宿主启动。
真实远程 wss、证书链与 mTLS 均未实测，本轮不宣称支持。

### 6.3 GSP 迷你套件

运行 `npm run conformance:gsp -w packages/protocol`，默认对内存假插件自测；
用 `GSP_LAUNCH`（`command/args/env/cwd` JSON）测试任意语言 stdio 插件，
或用 `GSP_ENDPOINT` 与 `GSP_TOKEN` 测试已运行的 ws 插件。
详情见 [套件说明](../packages/protocol/conformance/README.md#gsp-迷你一致性套件)，
[Python 参考插件](../packages/protocol/examples/python-plugin/README.md) 提供一键入口。

G01–G08 使用如下参考约定：hello 请求 `gsp="0.1.x"`，结果
`{gsp:"0.1.0"}`；版本不兼容 5001，错令牌 5003 且 1 s 内断开；
describe 返回完整插件清单，通过现有 `validatePluginManifest`；
health 返回 `{ok:true}`；error.data 使用现有 Problem；嵌套秘密字段拒绝为 5006；
shutdown 在 5 s 内退出，stdio 退出码 0。没有新增协议 schema、类型或版本。
旧 Node 示例仅实现原有简版循环，未宣称已通过这套更完整的参考约定。

## 7. 实例与隔离

- 实例绑定是内核对象（`PluginInstanceBinding`），不在清单里：同 kind 多实例按 `order` 依次生效（保护器全部叠加，任一拒绝即拒绝）。
- 每个本地插件一个子进程、一把一次性通道令牌、一份授予记录（按 `id` 键控）。A 的授予对 B 无效；A 崩溃不影响 B。Node 的 `--allow-fs-read` 只放自己的目录；任意可执行旁车没有沙箱，需由用户自行提供操作系统隔离。本轮远程插件返回 5002，不创建连接或子进程。
- 块（browser 运行时）在 `sandbox="allow-scripts"` 的 iframe 里跑，不给 `allow-same-origin`，只能经块桥拿清单里声明过的订阅 / 查询 / 命令。

## 8. 版本与兼容规则

| 对象 | 规则 |
|---|---|
| 清单格式 `schema` | `gitrader-plugin/<major>`。同一 major 内只追加字段、追加枚举值，不改名、不改语义、不收紧已有字段（r2 对 `evidence` 的定型是草案期内的例外，已登记）。破坏性变更 = 新 major，旧 major 至少再支持一个产品次版本 |
| 未知字段 | 顶层与任意子对象里的未知字段一律放行、原样保留。`x-` 前缀保留给扩展，永不被协议占用；本宿主的 `x-launch` 行为见 §6.1–6.2 |
| 插件 `version` | 精确语义化版本；升级 = 新目录或新版本子目录 + 重新 pin；内核按内容哈希判断"升级"而不是比较版本号 |
| `compat.pluginSchema` | 必须等于内核支持的清单 major（现在是 `"1"`）：`COMPAT_SCHEMA_UNSUPPORTED` |
| `compat.gitrader` | 语义化版本范围，内核版本（`KERNEL_VERSION`）不在范围内 → `COMPAT_GITRADER_UNSATISFIED`。范围语法：比较符 `>= > <= < =`、`^`、`~`、精确版本、`*`；空格 = 与，`\|\|` = 或。写不对 → `COMPAT_RANGE_INVALID` |
| `compat.gep` | 引擎插件声明的 GEP 版本，协商只看 `major.minor` |
| `requires[]` | 精确版本 + 哈希 |
| 错误码 | 只追加，不复用编号 |

## 9. 错误码

两套：**清单问题码**（字符串，`PluginIssue.code`，拒装阶段，出现在 `gitrader plugins check` / `plugins list` / `plugin.list` 的 `problems[]`）和 **Problem 码**（数字，契约 §2.8，运行阶段）。

### 9.1 清单问题码（`PLUGIN_ISSUE_CODES`）

| 码 | 阶段 | 修法提示 |
|---|---|---|
| `MANIFEST_UNREADABLE` | 读文件 | 检查文件名、JSON 语法 |
| `SCHEMA` | JSON Schema | `path` 指到字段；对照 §3 |
| `ID_PREFIX_MISMATCH` / `VENDOR_ID_MISMATCH` / `DUPLICATE_ID` / `PACKAGE_KIND_MISMATCH` | 身份 | §5.1 |
| `PERMISSION_NEVER_GRANTABLE` / `PERMISSION_UNKNOWN` / `PERMISSION_KIND_MISMATCH` / `NET_HOSTS_EMPTY` / `FACTOR_HAS_NET` / `UNSIGNED_FORBIDDEN_PERMISSION` | 权限 | §4、§5.2 |
| `KIND_REQUIRES_FIELD` | kind 必填 | §5.3 |
| `TOOL_NAME_DUPLICATE` / `TOOL_SCHEMA_INVALID` / `TOOL_PERMISSION_UNDECLARED` / `TOOLS_NOT_CALLABLE` | 工具 | §3.9 |
| `TOOL_SOLICITS_SECRET` | 工具 | §3.9（工具入参索要密钥，拒装） |
| `PROTECTOR_RULES_INVALID` | 保护器 | 仅 `protector` kind 可声明；规则须为内置类型且不得自带 `source`，由内核并入时写入 |
| `EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS` / `EVIDENCE_FORWARD_NEEDS_REF` / `EVIDENCE_WINDOW_INVALID` | 证据 | §5.5 |
| `PRIVACY_SENDS_WITHOUT_NET` / `PRIVACY_HOSTED_WITHOUT_NET` | 隐私 | §5.6 |
| `PROMISE_LANGUAGE` | 文案 | 删掉承诺收益的说法 |
| `REQUIRES_VERSION_INEXACT` | 依赖 | 写精确版本 |
| `HASH_MISMATCH` | 完整性 | `gitrader plugins pin <目录>` |
| `UNSIGNED_NOT_ALLOWED` / `SIGNATURE_KEY_UNTRUSTED` / `SIGNATURE_DIGEST_MISMATCH` / `SIGNATURE_INVALID` | 信任 | 开开发者模式，或把公钥加进 `plugins.trustRoots`，或重签 |
| `ENTRY_MISSING` / `ENTRY_NOT_FOUND` / `ENTRY_ESCAPES` | 入口 | §3.6 |
| `COMPAT_SCHEMA_UNSUPPORTED` / `COMPAT_RANGE_INVALID` / `COMPAT_GITRADER_UNSATISFIED` | 兼容 | §8 |

### 9.2 运行阶段 Problem 码（本协议用到的）

| 码 | 名 | 何时 |
|---|---|---|
| -32602 | `INVALID_PARAMS` | 没有这个插件 / 插件校验没过（消息列出问题码）；工具入参不合 `tools[].input`（`message` 带路径）；插件自己回的 `-32602` 也经此透传 |
| 2004 | `MANDATE_LIMIT` | 插件未启用 / 工具所需权限未授予 / 试图授予永不可授予的权限 |
| 3003 | `VENUE_UNAVAILABLE` | 插件进程中途退出 |
| 4001 | `INTERNAL` | 插件自己抛出的其他错误（`message` 原样透传） |
| 4004 | `BUSY` | 工具调用超时（默认 10 s） |
| 5002 | `CAPABILITY_UNSUPPORTED` | 不支持的本地 runtime、缺 x-launch 的旁车、本轮关闭的 ws/wss；或插件回 `-32601`（没实现这个工具） |
| 5006 | `SECRET_FIELD_REJECTED` | 插件返回里出现密钥类字段 |
| 5007 | `PAYLOAD_TOO_LARGE` | 返回值序列化超过 1 MiB |
| 5008 | `PLUGIN_TOOL_UNKNOWN` | **r2 新增**：调用了清单里没声明的工具 |
| 5009 | `PLUGIN_RESULT_INVALID` | **r2 新增**：返回值不合 `tools[].output` |
| —（清单问题码，无新增运行数字码） | `TOOL_SOLICITS_SECRET` | 安装前发现工具入参索要密钥，拒装；见 §3.9、§9.1 |

## 10. 示例

### 10.1 合法：一个工具型技能包（Node 运行时，无需网络，零权限）

```json
{
  "schema": "gitrader-plugin/1",
  "id": "skill.example.position-size",
  "package": "skill",
  "kind": "skill",
  "name": "仓位计算",
  "desc": "按账户权益、单笔风险比例、入场价与止损价算出下单数量。纯本地计算，不读任何数据。",
  "tags": ["utility", "risk", "example"],
  "version": "0.1.0",
  "vendor": { "id": "example", "name": "Example", "kind": "self", "verified": false, "url": null },
  "source": { "repo": "local/position-size", "commit": "0000000000000000000000000000000000000000", "sha256": "sha256:<pin 后自动填>", "fetchedAt": 1791500000000 },
  "license": { "spdx": "Apache-2.0", "redistribute": "bundle", "notice": "示例代码，随便改。", "commercialUse": true },
  "runtime": { "type": "node", "node": "22", "native": false, "diskMB": 1 },
  "entry": { "module": "./index.mjs" },
  "install": { "by": "user-install", "requireHashes": true },
  "permissions": [],
  "privacy": { "hosted": false, "sends": [] },
  "provides": { "tools": ["position_size"] },
  "tools": [
    {
      "name": "position_size",
      "desc": "给定权益、风险比例、入场价、止损价，返回数量（十进制字符串）。",
      "tags": ["utility", "risk"],
      "input": {
        "type": "object",
        "required": ["equity", "riskPct", "entry", "stop"],
        "properties": {
          "equity": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]+)?$" },
          "riskPct": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]+)?$" },
          "entry": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]+)?$" },
          "stop": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]+)?$" }
        },
        "additionalProperties": false
      },
      "output": { "type": "object", "required": ["qty"], "properties": { "qty": { "type": "string" } } },
      "permissions": []
    }
  ],
  "fixtures": { "offline": [], "smoke": [] },
  "compat": { "gitrader": ">=0.1.0 <0.2.0", "pluginSchema": "1" }
}
```

### 10.2 非法：多处错误，分两轮报出

```json
{
  "schema": "gitrader-plugin/1",
  "id": "strategy.acme.moon",
  "package": "block",
  "kind": "strategy",
  "name": "月球策略",
  "desc": "保证收益，年化 300%。",
  "tags": [],
  "version": "1.0",
  "vendor": { "id": "acme", "name": "Acme", "kind": "community", "verified": true, "url": null },
  "source": { "repo": "acme/moon", "commit": "0000000000000000000000000000000000000000", "sha256": "sha256:0000000000000000000000000000000000000000000000000000000000000000", "fetchedAt": 1 },
  "license": { "spdx": "MIT", "redistribute": "bundle", "notice": "", "commercialUse": true },
  "runtime": { "type": "node", "native": false, "diskMB": 1 },
  "entry": { "module": "./index.mjs" },
  "install": { "by": "user-install", "requireHashes": true },
  "permissions": ["trade.live", "withdraw"],
  "privacy": { "hosted": true, "sends": ["positions"] },
  "provides": {},
  "evidence": { "claims": [ { "metric": "sharpe", "value": "3.1", "basis": "backtest", "window": { "from": 1, "to": 2 } } ] },
  "risk": { "disclosure": "无风险。", "worstCase": "无", "builderAttribution": "off" },
  "fixtures": { "offline": [], "smoke": [] },
  "compat": { "gitrader": "*", "pluginSchema": "2" }
}
```

第一轮 `gitrader plugins check`（结构层没过，只报结构层）：

```
SCHEMA                            /version          must match pattern "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$"
PERMISSION_NEVER_GRANTABLE        /permissions/1    permission withdraw can never be granted
REJECTED 2 problem(s)
```

把 `version` 改成 `1.0.0`、删掉 `withdraw` 后第二轮（语义层 + 哈希 + 兼容一次报全）：

```
PERMISSION_KIND_MISMATCH          /permissions/0    kind strategy cannot request trade.live
UNSIGNED_FORBIDDEN_PERMISSION     /permissions/0    unsigned plugin must not request trade.live
PROMISE_LANGUAGE                  /desc             promise-like wording: "保证收益"
PROMISE_LANGUAGE                  /risk/disclosure  promise-like wording: "无风险"
PRIVACY_HOSTED_WITHOUT_NET        /privacy/hosted   hosted plugin must request net.fetch and list net.hosts
PRIVACY_SENDS_WITHOUT_NET         /privacy/sends    privacy.sends declared without net.fetch
EVIDENCE_BACKTEST_NEEDS_ASSUMPTIONS /evidence/claims/0  backtest claims must list assumptions
COMPAT_SCHEMA_UNSUPPORTED         /compat/pluginSchema  this kernel supports plugin schema "1"
HASH_MISMATCH                     /source/sha256    hash mismatch: … (run: gitrader plugins pin <dir>)
REJECTED 9 problem(s)
```

修完再 `check`，直到 `ok`。消息文本以实际输出为准，码是稳定的。

另一个独立工具入参拒绝示例（不计入上面非法清单的 `REJECTED` 数量）：

```
TOOL_SOLICITS_SECRET /tools/0/input/properties/privateKey tool position_size: parameter "privateKey" asks for a secret; tool arguments must never carry keys, mnemonics, passwords or API secrets
```

## 11. 待拍板清单（设计上没有自作主张填默认值的点）

| # | 问题 | 现状 | 我的建议（未定稿） |
|---|---|---|---|
| 1 | 蓝图里的"统计检验包 / 模型网关 / 账本导出 / 插件注册表"要不要现在加 kind | 没加 | 等第一个真实插件出现再加；"账本是插件"按"账本导出 / 落盘后端是插件、仅追加语义是底座"理解 |
| 2 | 内置信任根放谁的公钥、发布密钥谁保管 | 空 | **已定（2026-10-14）**：两把 Ed25519 密钥（官方插件 / 商店）由维护者离线生成保管，公钥进内置信任根；签名只在不跑 Agent 的环境或 CI 受保护环境里做；信任根清单公开并带吊销；后续增加无长期密钥的签名算法 |
| 3 | Node 插件的宿主调用通道（`host.*`：读行情 / 读账户 / 追加账本） | 未开通，权限只是记录 | 作为插件协议 r3 的唯一内容，跟风控闸门协议并行 |
| 4 | 承诺用语词表的具体条目与中英文范围 | 已给首版 | 维护者 过目后定稿；词表变更走 CHANGELOG |
| 5 | 工具语义标签词表 | 已给 10 个推荐词，开放 | 等工具面协议（第五个）定稿时收口为受控词表 |
| 6 | `evidence.claims[].ref` 的格式 | 自由字符串 | 第三个协议（实验注册表）定稿后改为实验 id / 账本条目 id 的引用格式 |
| 7 | "启用 = 至少确认过一次"这条语义 | 已实现为 `grant(id, [])` | 可接受则保留；若要独立 `plugin.enable` 操作再加 |
| 8 | 浏览器块挂进工作台 | iframe 宿主已接入 | 工作台负责隔离桥、权限及工作区挂载 |
| 9 | 第三方 MCP 服务器（`stdio-mcp` / `remote-mcp`）在插件闸门外的风险 | M1 不能拉起 | 开通前先定"MCP 工具也必须逐个写进 `tools[]`"的强制规则（本文已写） |
