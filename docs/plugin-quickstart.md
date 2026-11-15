# 插件快速上手：十分钟写出并跑通第一个工具插件

> 许可证：CPAL-1.0（本文档）；协议包与插件模板为 Apache-2.0，可自由嵌入。字段级规范见 [`plugin-protocol.md`](plugin-protocol.md)，目录约定与权限模型见 [`plugins.md`](plugins.md)。

这篇走一遍最短路径：复制一个现成的工具型插件（`position_size`，按权益、风险比例、入场价、止损价算下单数量，零权限、不联网），改成自己的名字，校验、安装、启用、调用。读完你会知道一个插件从"一个目录"到"Agent 能调用的工具"要过哪几关。

前提：
- 本机有 Node 22，已装好 `gitrader`（安装方式见仓库 README）。
- **在交互式终端里跑过 `gitrader init`**：它会建 `~/.gitrader/`（Windows 是 `%USERPROFILE%\.gitrader\`；环境变量 `GITRADER_HOME` 可改）并让你设一个 PIN（6–12 位数字，或 8–64 位口令）。第 4 步启用插件要用这个 PIN。在没有终端的环境（CI、Agent 的 shell）里 `init` 只建目录不设 PIN，并打印 `PIN not set (no interactive terminal)`——那就换个终端再跑一次 `gitrader init`。
- 示例没有签名，所以先打开开发者模式（只在本机开发时用）：`init` 生成的 `gitrader.json` 里已经有 `"plugins": { "developerMode": false, "trustRoots": [] }`，把 `developerMode` 改成 `true` 即可。
- 示例在仓库 `packages/plugin-template/example/position-size/`。用 npm 装的、手边没有仓库：示例清单完整印在 [`plugin-protocol.md` §10.1](plugin-protocol.md)，另外两个文件（`gsp.mjs` 通用循环、`index.mjs` 工具本体）加起来不到 60 行，按 §6「写一个工具的约定」照写即可。

> 目录里出现 ≠ Agent 能用。内核分三关：**校验通过** → **你本人启用**（第 4 步）→ **调用时按工具声明再校验入参**。下面每一步对应其中一关。

## 1. 复制示例，改成你的名字

示例在仓库的 `packages/plugin-template/example/position-size/`，一共四个文件：

```
position-size/
  gitrader-plugin.json   清单：谁、什么版本、有哪些工具、要什么权限、内容哈希
  index.mjs              工具本体：position_size
  gsp.mjs                40 行以内的通用循环（读 stdin 的一行一个 JSON-RPC 请求，写 stdout 的应答）
  decimal.mjs            8 位小数的定点运算（金额不用浮点数）
```

复制到工作目录，比如 `./my-size`（macOS / Linux 用 `cp -r`，Windows PowerShell 用 `Copy-Item -Recurse`）：

```
cp -r packages/plugin-template/example/position-size ./my-size
```

打开 `my-size/gitrader-plugin.json`，改三处（`<你>` 与 `<名>` 用小写字母、数字、`-`）：

| 字段 | 示例值 | 改成 | 规则 |
|---|---|---|---|
| `id` | `skill.example.position-size` | `skill.<你>.<名>` | 第一段必须等于 `kind`（这里是 `skill`），第二段必须等于 `vendor.id` |
| `vendor.id` / `vendor.name` | `example` / `Example` | `<你>` / 你的名字 | `vendor.id` 要和 `id` 的第二段一致，否则 `VENDOR_ID_MISMATCH` |
| `name` | `仓位计算` | 你喜欢的名字 | 不超过 80 字 |

别的字段先不动。`tools[]` 里的 `name`（`position_size`）是调用时用的工具名，`index.mjs` 里 `serve({ tools: { position_size: … } })` 的键必须与它一致。

## 2. 校验：`gitrader plugins check`

改完后钉哈希（内容哈希写回清单的 `source.sha256`；改了清单以外的任何文件都要重新钉，只改清单不用——所以这里 pin 出来的哈希和示例一样是正常的），再校验：

```
gitrader plugins pin ./my-size
gitrader plugins check ./my-size
```

预期输出（最后一行是结论，退出码 0）：

```
ok skill.<你>.<名>@0.1.0
```

故意改坏一处看看。把 `desc` 改成含承诺收益的说法（比如"保证收益"），再跑一次：

```
gitrader plugins check ./my-size
```

```
PROMISE_LANGUAGE  /desc  promise-like wording: "保证收益"
    remove wording that promises returns or removes risk
REJECTED 1 problem(s)
```

每行是 `码  路径  说明`，路径是清单里的 JSON 指针，退出码 2。改回去、重新 `pin`，直到再看到 `ok`。想在脚本里用，加 `--json`；想按"没签名不放行"的口径检查，加 `--strict`（默认按开发者模式检查）。常见的码见本文最后一节。

## 3. 装进插件目录并重载

文件丢进去就是安装：

```
cp -r ./my-size ~/.gitrader/plugins/my-size
gitrader plugins reload
```

预期输出（服务在跑时开头会多一句 `running service`）：

```
Reloaded: +1 ~0 -0, rejected 0
```

`gitrader plugins list` 能看到这一行（零权限插件 `pending` 和 `granted` 都是空的；`enabled:no` 说明还没启用）：

```
ok        skill.<你>.<名>  0.1.0  skill  granted:[] pending:[] enabled:no
```

如果是 `REJECTED`，行尾会跟着带 `[码]` 前缀的原因，对照最后一节修。

## 4. 启用：`gitrader plugins grant`

```
gitrader plugins grant skill.<你>.<名>
```

这一步需要你本人在场，会要 PIN（在脚本里可以把 PIN 从标准输入管进去）。成功时打印 `enabled skill.<你>.<名>`，之后 `plugins list` 那一行末尾变成 `enabled:yes`。示例是零权限插件，所以不用写权限名；命令只表示"我看过这个插件，同意启用它"，内核会写一条账本记录，重载后仍然有效。要授予具体权限的插件（比如声明了 `market.read`）把权限名写在后面：`gitrader plugins grant <id> market.read`，逐项授予；永远不可授予的九项（提现、转账、批准提案……）写进清单就会被拒装。服务在跑时请在工作台授权，或先停服务再执行。

没启用的插件，调它的工具会被内核拒绝（`MANDATE_LIMIT` 2004，提示 `is not enabled: grant it at least once`）。这保证目录里出现一个文件不会自动变成 Agent 能用的能力。

## 5. 调用：`gitrader plugins call`

```
gitrader plugins call skill.<你>.<名> position_size '{"equity":"10000","riskPct":"1","entry":"100","stop":"95"}'
```

Windows 上（cmd、Windows PowerShell 5.1、npm 生成的 `gitrader.cmd` 垫片）单引号里的双引号会被吃掉，改用文件传入参：把那段 JSON 存成 `args.json`，然后

```
gitrader plugins call skill.<你>.<名> position_size @args.json
```

（`-` 表示从标准输入读。）预期输出：

```
{"qty":"20.00000000"}
```

算法：`qty = equity × riskPct ÷ 100 ÷ |entry − stop|`，8 位小数向下取整。1 万权益、单笔风险 1%（100）、止损距离 5，数量 20。数量是示例计算的结果，不是建议。

故意传错看内核怎么拒绝（入参先过清单里 `tools[].input` 的 JSON Schema）：

```
gitrader plugins call skill.<你>.<名> position_size '{"equity":"10000","riskPct":"1","entry":"100"}'
```

```
-32602 INVALID_PARAMS: tool position_size: …（指出缺少 stop）
```

退出码 1。工具名写错（清单里没声明的）得到 `5008 PLUGIN_TOOL_UNKNOWN`；`entry` 等于 `stop` 时插件自己回 `-32602`，内核原样透传。插件 id 写错得到 `-32602 INVALID_PARAMS: no such plugin …`；改了 `index.mjs` 忘了重新 `pin` 再调，得到 `-32602 INVALID_PARAMS: plugin … failed validation: [HASH_MISMATCH] …`——照码修即可。**错误文案是内核或插件原样给出的，不会被改写。**

没开服务时，`call` 会临时起一个内核、拉起插件进程、调完退出；服务在跑就直接走服务。已启用但还没运行的插件，内核在第一次调用时自动拉起。插件进程是独立的 Node 子进程：不继承环境变量，只能读自己的目录，崩溃了内核会退避重启。

## 5½. 写自己的工具

加第二个工具只要三步：在清单 `tools[]` 里加一条（`name`、`desc`、`tags`、`input` schema，可选 `output` 与 `permissions`），在 `index.mjs` 的 `serve({ tools: { … } })` 里加同名处理函数，然后重新 `pin`。约定（完整版见 [`plugin-protocol.md` §6](plugin-protocol.md)）：

- 处理函数收到的就是调用方传的 `args`，已经按你声明的 `input` 校验过；返回一个能序列化成 JSON 的值，声明了 `output` 的话返回前会被校验。
- 参数合 schema 但业务上不能接受（例如入场价等于止损价），抛 `gsp.mjs` 提供的 `InvalidParams`（它会应答 JSON-RPC error `-32602`），调用方会原样收到这条 message，码是 `-32602 INVALID_PARAMS`；抛别的异常会应答 `-32603`，调用方看到 `4001 INTERNAL`。
- 清单里声明了但没实现的工具，`check` 查不出来，调用时 `gsp.mjs` 应答 `-32601`，调用方看到 `5002 CAPABILITY_UNSUPPORTED`；`provides.tools` 只是给目录看的摘要，以 `tools[]` 为准。
- 插件进程读不到环境变量、只能读自己的目录；想读行情、账户、账本要先声明权限并由用户授予（M1 的 Node 插件还没有这条数据通道，见「下一步」）。
- 入参不得索要私钥、助记词、密码、API 密钥，说明文字里也别出现这些字眼。键名 `seed` 仅在直接 schema 明确声明 `number` / `integer` 时放行；`required[]` 中的 `seed` 还须同级 `properties.seed` 有数值类型证据，`seed phrase` / `seed words` 仍拒。例外只放行键名，`title` / `description` 仍会扫描。

## 6. 在宿主里经 MCP 调用

接上 Claude Code、Codex、Hermes 或 UNIGIT 之后（接法见 `integrations/`），Agent 通过 MCP 的 `plugins` 工具用插件，动作有 `list` / `describe` / `call`：

```json
{ "action": "list" }
{ "action": "describe", "pluginId": "skill.<你>.<名>" }
{ "action": "call", "pluginId": "skill.<你>.<名>", "tool": "position_size", "args": { "equity": "10000", "riskPct": "1", "entry": "100", "stop": "95" } }
```

`call` 返回 `{ "qty": "20.00000000" }`。`describe` 会带出清单里的 `tools[]`、是否已启用和未解决的问题，Agent 可以先看再调。检查链路与命令行一致：已校验、已启用、工具已声明、工具需要的权限已授予、入参合 schema，缺一项就是明确的错误，不是静默失败。

## 常见拒绝码怎么修

下面是 `plugins check` / `plugins list` 里最常见的码，完整清单见 [`plugin-protocol.md` §9.1](plugin-protocol.md)。校验分两层：结构层（`SCHEMA`）没过时只报结构层，修完再跑一次才会看到语义层的码。

| 码 | 意思 | 怎么修 |
|---|---|---|
| `SCHEMA` | 清单结构不合格式（`路径` 列指到字段） | 看路径和说明，对照 `plugin-protocol.md` §3 改那个字段 |
| `PERMISSION_UNKNOWN` | `permissions` 里有不认识的权限名 | 提示里列出了 14 个合法名字，照抄一个 |
| `VENDOR_ID_MISMATCH` | `id` 第二段和 `vendor.id` 不一致 | 两处改成同一个字符串 |
| `ID_PREFIX_MISMATCH` | `id` 第一段和 `kind` 不一致（`decision-model` 的前缀是 `decision`） | 把 `id` 改成 `<kind>.<vendor>.<名>` |
| `HASH_MISMATCH` | 目录内容变了，和清单里的 `source.sha256` 对不上 | `gitrader plugins pin <目录>` 重新钉 |
| `UNSIGNED_NOT_ALLOWED` | 没签名，而且没开开发者模式 | 本机开发：`gitrader.json` 里 `plugins.developerMode` 设 `true`；分发：签名 |
| `PERMISSION_NEVER_GRANTABLE` | 申请了永远不可授予的权限（提现、转账等十项） | 从 `permissions` 里删掉；这些没有任何配置能打开 |
| `PERMISSION_KIND_MISMATCH` | 这个 `kind` 不能申请这项权限 | 对照 `plugin-protocol.md` §4.1 的矩阵，改 `kind` 或去掉该权限 |
| `TOOL_SCHEMA_INVALID` | 工具的 `input` / `output` 不是合法的 object schema，或 `pattern` 可能灾难性回溯（量词套在含量词或分支的分组上，如 `(a+)+`、`(foo\|bar)+`、`^[a-z]+(-[a-z]+)*$`），或用了 `$async` / 回溯引用 / 超长正则 | `type` 写成 `"object"`；正则改成不嵌套量词的写法（如 `^[a-z-]+$`）；这条规则宁可误杀，提示里给了改法 |
| `TOOL_SOLICITS_SECRET` | 工具入参或说明文字索要密钥，安装前拒装 | 删除该参数，或重写 `title` / `description`，避免提及密钥类内容 |
| `PROMISE_LANGUAGE` | `name` / `desc` / 工具说明里有承诺收益的说法 | 删掉该措辞，只描述它做什么；有数字就放进 `evidence` 并写明依据 |
| `COMPAT_GITRADER_UNSATISFIED` | 当前内核版本不在 `compat.gitrader` 范围内 | 把范围改成包含当前版本，如 `>=0.1.0 <0.2.0`；或换匹配版本的内核 |

另外两个运行时的码值得认得：`2004 MANDATE_LIMIT`（没启用，或工具需要的权限没授予，补一次 `grant`）和 `5009 PLUGIN_RESULT_INVALID`（插件返回的结果不符合工具声明的 `output`，改插件或改声明）。

## 下一步

- 要让插件读行情、读账户：在清单 `permissions` 里声明，在工具的 `permissions` 里标明它用哪项，然后 `grant` 时授予。注意：Node 插件目前还没有"插件调内核"的数据通道（见 `plugin-protocol.md` §4.4），权限现在只是声明与授予记录。
- 要附上业绩或回测数字：写进 `evidence`，每条声明带指标、数值、依据（回测 / 纸面 / 实盘）、时间窗口；回测必须写明假设（成本、滑点、数据来源与区间）。数字原样展示，不做二次加工。
- 要分发：签名、`source.repo` 与 `commit` 写真实值、`license` 如实填写，见 `plugins.md`。
