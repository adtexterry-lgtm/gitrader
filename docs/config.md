# gitrader.json 参考

位置：`~/.gitrader/gitrader.json`（`GITRADER_HOME` 或 `--home DIR` 可改主目录）。`gitrader init` 生成默认文件，可重复运行，不会覆盖已有内容（只补缺失的目录和账户 id）。

主目录下的 `lab/` 保存本机实验产物，由 `gitrader init` 创建。

以代码为准：类型、默认值、校验规则都来自 `packages/kernel/src/config.ts`。校验不过的文件会让内核拒绝启动并列出所有问题，不做静默修正。

**通用规则**

- 内核**启动时读一次**这个文件。表里"改了要重启"一栏，目前全部是"要重启 `gitrader serve`"（M1 没有热重载配置）。
- "谁能改"：文件在你自己的用户目录里，你随时可以手改。例外一项：`risk` 段只能**收紧**——写得比已签名的风控策略更宽，会被忽略并在启动告警里说明，放宽要在工作台里输 PIN。内核会记住上次应用的 `risk` 段摘要；摘要没变时启动不再合并，所以工作台里放宽过的策略会保留。工作台里切换网络（主网 / 测试网）会改写这个文件的 `venues[].environment` 和 `accounts[].environment`，并提示需要重启。
- **文件里不放任何密钥**：只放钥匙库里的名字（`signerRef`）和公开地址。
- 十进制数值（名义额、比例）一律写成**字符串**，如 `"2000"`、`"0.03"`；计数、秒数、倍数写数字。

## 顶层字段

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `schema` | 字符串 | `"gitrader-config/1"` | 必须原样是这个值 |
| `supportDeveloper` | 布尔 | `false` | "支持开发者"开关。打开后 Hyperliquid 订单才带 1 bp 的 Builder 费（还需要你用主钱包另外授权）；关着照常交易。`init` 不会问你 |
| `venues` | 数组 | 见下 | 场所 |
| `accounts` | 数组 | 见下 | 账户 |
| `engines` | 数组 | 见下 | 引擎 |
| `risk` | 对象 | 见下 | 风控种子 |
| `keys` | 对象 | 见下 | 钥匙默认值 |
| `layout` | 对象 | `{"workspace":"ws_default"}` | 工作区 |
| `server` | 对象 | `{"port":null}` | 本地服务端口 |
| `plugins` | 对象 | `{"developerMode":false,"trustRoots":[]}` | 插件 |

## venues[]：场所

默认：`[{ "id": "hyperliquid", "environment": "testnet", "enabled": true }]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | 字符串 | 小写字母、数字、短横线，如 `hyperliquid`。M1 随包的场所连接器只有 `hyperliquid` |
| `environment` | `"mainnet"` \| `"testnet"` | 网络 |
| `enabled` | 布尔 | 是否启用 |

主网默认关着：工作台里切到主网之前，必须先导入或生成一只主网 API 钱包。

## accounts[]：账户

默认一个纸面账户。别名 `alias` 不许重复。`accountId` 由 `init` 自动补，不用手写。

```json
{
  "accounts": [
    { "alias": "paper", "venue": "hyperliquid", "environment": "testnet", "mode": "paper",
      "paper": { "initialBalance": "10000", "ccy": "USDC" } },

    { "alias": "main-live", "venue": "hyperliquid", "environment": "mainnet", "mode": "live",
      "signerRef": "my-api-wallet",
      "owner": { "address": "0x0000000000000000000000000000000000000000" } }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `alias` | 字符串 | 是 | 账户别名，命令行和 Agent 都可以用它指代账户 |
| `venue` | 字符串 | 是 | 对应 `venues[].id` |
| `environment` | `"mainnet"` \| `"testnet"` | 是 | |
| `mode` | `"paper"` \| `"live"` \| `"shadow"` | 是 | 纸面（吃真实行情的模拟撮合）/ 实盘 / 影子（当前与纸面走同一模拟撮合路径；独立影子语义待 S2） |
| `paper` | `{ initialBalance, ccy }` | `mode=paper` 时必填 | `initialBalance` 是十进制字符串 |
| `signerRef` | 字符串 | `mode=live` 时必填 | 钥匙库里 API 钱包的名字（`gitrader keys list` 能看到），**不是私钥** |
| `owner.address` | 字符串 | 实盘强烈建议 | 你的**主账户地址**（公开地址）。Hyperliquid 里 API 钱包替主账户下单，余额、持仓、成交都按主账户地址查；不写，内核启动时告警，该账户的余额 / 持仓 / 成交无法跟踪 |
| `accountId` | 字符串 | 自动 | `acct_…`，不要改 |

本地 `risk.maxDriftBps` 默认 30，限定预览及提案批准后的价格偏离。配置只能收紧；放宽用人面 PIN 或 `gitrader risk relax`。参数由内核签名存储，不扩展协议限额字段。

## engines[]：引擎

默认：`[{ "id": "gitrader-core", "enabled": true, "builtin": true }]`

每项：`id`（小写字母、数字、`.`、`_`、`-`，不许重复）、`enabled`（布尔），再加下面三种形态之一（`builtin` 和 `launch` 至少有一个）：

```json
{
  "engines": [
    { "id": "gitrader-core", "enabled": true, "builtin": true },

    { "id": "my-rust-engine", "enabled": true,
      "launch": { "command": "C:/engines/my-engine.exe", "args": ["--gep", "stdio"],
                  "env": { "MY_MODE": "paper" }, "cwd": "C:/engines" } },

    { "id": "partner-engine", "enabled": false,
      "launch": { "url": "wss://engine.example.com/gep",
                  "auth": { "method": "token", "tokenRef": "env:PARTNER_ENGINE_TOKEN" } } }
  ]
}
```

1. **随包参考引擎** `{ "builtin": true }`：内核把打包好的 `engine-core` 当 stdio 子进程拉起（找不到打包产物就只登记不启动；可用环境变量 `GITRADER_ENGINE_CORE_BUNDLE` 指定位置）。策略文件夹固定是 `~/.gitrader/engines/<id>/strategies/`。
2. **本地任意语言子进程** `launch: { command, args?, env?, cwd? }`：内核拉起、做健康检查，崩溃后退避重启（1 秒到 60 秒；10 分钟内崩 5 次判 failed）。子进程**不继承**你的环境变量，只拿到 `env` 里显式写的、`GITRADER_GEP_TOKEN`（一次性令牌）和最小系统变量。
3. **已在运行的本地 ws / 远程 wss** `launch: { url, auth }`：`url` 必须是 `ws://` 或 `wss://`；非本机地址必须 `wss://`；**不许把令牌写进 URL**；`auth` 必填：`{ method: "token", tokenRef }` 或 `{ method: "mtls", clientCertRef, caCertRef? }`，里面是**句柄**，不是令牌 / 证书本身。M1 的 `gitrader serve` 认 `env:<变量名>` 句柄：令牌放在启动 serve 的环境变量里，配置文件里只有变量名。

> M1 现状：形态 3 用 `env:<变量名>` 句柄可用（`scripts/verify/remote-engine.mjs` 在本机 loopback ws 上验过：握手、策略列表、日志不含令牌）；其他形式的句柄（钥匙库条目）尚未实现，会显示 failed（"cannot resolve tokenRef"）。mTLS 未验。

引擎协议见 `docs/engine-protocol.md`。引擎绑定到账户要你本人输 PIN：`gitrader engines bind <id>`。

## risk：风控种子

默认：

```json
{
  "risk": {
    "preset": "p-lev3-o2000-d3",
    "limits": { "maxSlippageBps": 50, "maxOrdersPerMinute": 30, "maxCancelsPerMinute": 60, "duplicateIntentWindowSec": 10 },
    "protectors": [],
    "failClosed": { "stalePriceMs": 5000, "onMissingPrice": "deny" },
    "dailyResetAt": "00:00Z",
    "valuationCcy": "USDC"
  }
}
```

**这一段只是"种子"**：第一次启动时内核据此生成一份**签名的风控策略**存进数据库，之后以签名策略为准。内核同时把这次 `risk` 段的摘要存为“已应用”；之后每次启动先比对摘要：

- 摘要没变 → 不再合并，保留当前签名策略（包括你在工作台用 PIN 放宽过的值）。
- 摘要变了 → 逐字段处理：**比当前策略更严**的字段生效并入账，更宽的字段忽略、启动告警里写明；每个生效的收紧字段都会有一行「配置文件把 <字段> 由 <旧值> 收紧为 <新值>」的提示。
- 老主目录第一次升级（还没有摘要记录）→ 只记下当前配置摘要，不合并，避免冲掉已有的放宽。

放宽始终走工作台 + PIN。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `preset` | 字符串 | `p-lev3-o2000-d3` | 数字预设，三选一，id 里就是数字，没有风格标签 |
| `limits` | 对象 | 见上 | 覆盖预设里的同名字段 |
| `protectors` | 数组 | `[]` | 保护器；留空则用预设自带的（见下） |
| `failClosed` | `{ stalePriceMs, onMissingPrice }` | `{5000, "deny"}` | 行情陈旧超过 `stalePriceMs` 毫秒、或拿不到价格，一律拒单 |
| `denyLlmLiveEntries` | 布尔 | **`true`** | 大模型来源的 Agent 不得发起实盘开仓，只能提案等你批。写 `false` 是放宽，**在文件里写了会被忽略**，要在工作台里输 PIN 关闭 |
| `dailyResetAt` | 字符串 | `"00:00Z"` | 当日盈亏的基线时点 |
| `valuationCcy` | 字符串 | `"USDC"` | 估值币种 |

**预设**（`preset`）：

| id | 杠杆 | 单笔名义 | 单标的占权益 | 总敞口占权益 | 持仓个数 | 日亏 | 冷却 |
|---|---|---|---|---|---|---|---|
| `p-lev3-o2000-d3`（默认） | ≤3× | ≤2,000 | 0.3 | 0.6 | 3 | 3% | 5 秒 |
| `p-lev5-o5000-d5` | ≤5× | ≤5,000 | 0.5 | 1 | 5 | 5% | 2 秒 |
| `p-lev10-o20000-d10` | ≤10× | ≤20,000 | 1 | 2 | 10 | 10% | 0 |

**`limits` 可用字段**（都可选，除 `maxSlippageBps` 必须有值，缺省补 50）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `maxLeverage` | 数字 ≥0 | 杠杆上限 |
| `maxOrderNotional` | 十进制字符串 | 单笔名义额上限 |
| `maxPositionNotionalRatio` | 十进制字符串 | 单标的持仓名义 / 权益 |
| `maxTotalNotionalRatio` | 十进制字符串 | 全部持仓名义 / 权益 |
| `maxOpenPositions` | 数字 ≥0 | 持仓个数 |
| `maxDailyLossRatio` | 十进制字符串 | 当日权益回撤比例 |
| `maxDailyNotional` | 十进制字符串 | 单日名义额合计 |
| `maxSlippageBps` | 数字 ≥0 | 市价类滑点上限（bp） |
| `maxOrdersPerMinute` / `maxDailyOrders` / `maxCancelsPerMinute` | 数字 ≥0 | 下单 / 撤单频率，防刷单与场所限流 |
| `duplicateIntentWindowSec` | 数字 ≥0 | 窗口内同账户同标的同方向同价同量的重复意图直接拒绝；`0` 关闭（属放宽） |
| `instrumentAllowlist` / `venueAllowlist` | 字符串数组 | 白名单；空数组 = 不限 |

**`protectors` 可用种类**（可叠加，只会拒绝或收紧）：`cooldown{afterOpenSec}`、`stoploss_guard{windowMin,maxStoplosses,pauseMin,scope}`、`drawdown_pause{windowHours,maxDrawdownRatio,pauseMin}`、`low_profit_lock{windowHours,minProfitRatio,lockMin}`、`max_consecutive_failures{count,pauseMin}`、`plugin{pluginId,params?}`。

## keys：钥匙默认值

默认：`{ "agentKeyExpiryDays": 90, "defaultTier": "paper", "walletExpiryWarnDays": 14 }`

| 字段 | 类型 | 说明 |
|---|---|---|
| `agentKeyExpiryDays` | 数字 >0 | 新建 Agent 钥匙的有效天数 |
| `defaultTier` | `"read_only"` \| `"paper"` \| `"confirm"` | 新钥匙的默认档位。**不许写 `auto_limited`**（限额自动不能当默认）。M1 里命令行建钥匙要显式给 `--tier`，这个字段目前只做校验 |
| `walletExpiryWarnDays` | 数字 | API 钱包到期前多少天开始提醒轮换 |

## layout / server / plugins

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `layout.workspace` | 字符串 | `"ws_default"` | 默认工作区名。M1 内核目前只校验、不读取 |
| `server.port` | 整数（1–65535）或 `null` | `null` | 本地服务端口。`null` = 从 47900 起自动找空闲端口，并避开 8765 / 8188 / 9872 / 9222 / 8080 / 5198 / 4184 / 14609 / 47831。命令行 `--port` 优先。服务永远只绑 `127.0.0.1` |
| `plugins.developerMode` | 布尔 | `false` | 打开才允许加载**未签名**的插件（本地开发用）。未签名插件不能申请 `trade.live` / `venue.credentials` |
| `plugins.trustRoots` | `[{ keyId, publicKey }]` | `[]` | 你手动信任的插件签名公钥。内置信任根 M1 为空 |

插件细节见 `docs/plugins.md`。
