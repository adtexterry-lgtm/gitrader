> 许可证：CPAL-1.0。

# tools/testnet · 交易连接器的测试网 / 模拟盘旅程脚本

**这些脚本只在测试网 / 模拟盘上跑，不接实盘。** 本目录有 9 个场所的旅程脚本（`journey-binance.mjs`、`journey-okx.mjs`、
`journey-bybit.mjs`、`journey-bitget.mjs`、`journey-gateio.mjs`、`journey-alpaca.mjs`、`journey-ibkr.mjs`、`journey-dydx.mjs`、
`journey-htx.mjs`），其中 binance、okx、bybit、bitget、gateio、alpaca、ibkr 的交易连接器已注册进内核
（`packages/cli/src/connectors.ts`），dydx、htx 未注册。旅程脚本是给「真网小钱验证」之前那一步准备的：主会话或 维护者 自己在终端里导出测试网密钥、亲手跑一遍，
看每一笔单是不是按预期落地、撤回、留不下持仓。**没有密钥时脚本什么请求都不发（退出码 3）**；密钥只从环境变量读，
不打印、不落盘、不进 argv。

## 跑哪几个

下表列了 6 个所的 amend / 触发单细节（Hyperliquid 两列见包 README）；alpaca、ibkr、dydx、htx 的基址见下面「会访问哪些主机」。

| 场所 | 运行环境 | 基址 | amend | 触发单落点 |
|---|---|---|---|---|
| Binance USDⓈ-M 永续 | 测试网（demo） | `https://demo-fapi.binance.com` | emulated（仅 LIMIT） | `POST /fapi/v1/algoOrder` |
| OKX USDT 永续 | 模拟盘（请求头 `x-simulated-trading: 1`） | `https://www.okx.com`（同一主机） | native（仅普通 limit） | `POST /api/v5/trade/order-algo` |
| Bybit v5 线性永续 | 测试网 | `https://api-testnet.bybit.com` | emulated（仅 Limit 系） | `POST /v5/order/create`（带 `triggerPrice`） |
| Bitget USDT 本位永续 | 模拟盘（`PAPTRADING: 1`） | `https://api.bitget.com`（同一主机） | none（跳过改单一步） | `POST /api/v2/mix/order/place-plan-order` |
| Gate.io USDT 永续 | 测试网 | `https://api-testnet.gateapi.io` | none（跳过改单一步） | `POST /api/v4/futures/usdt/price_orders` |
| Hyperliquid | 测试网 | `https://api.hyperliquid-testnet.xyz` | 见包 README | 见包 README |

基址与开关都照各包 README 与 QuantDinger v5.6.5 的当前实现（出处写在 `lib/venues.mjs` 的 `baseUrlSource`）。
`environment` 在脚本里恒为 `testnet`：没有 `--environment` 这个参数，跑不到主网。OKX / Bitget 的模拟盘与生产是同一主机，
靠请求头 / `PAPTRADING` 字段区分（OKX 的签名请求全部带模拟盘头，有测试断言）。

## 密钥：只从这些环境变量读

| 场所 | 环境变量 |
|---|---|
| Binance | `BINANCE_TESTNET_API_KEY` · `BINANCE_TESTNET_API_SECRET` |
| OKX | `OKX_DEMO_API_KEY` · `OKX_DEMO_API_SECRET` · `OKX_DEMO_PASSPHRASE` |
| Bybit | `BYBIT_TESTNET_API_KEY` · `BYBIT_TESTNET_API_SECRET` |
| Bitget | `BITGET_DEMO_API_KEY` · `BITGET_DEMO_API_SECRET` · `BITGET_DEMO_PASSPHRASE` |
| Gate.io | `GATE_TESTNET_API_KEY` · `GATE_TESTNET_API_SECRET` |
| Hyperliquid | `HL_TESTNET_MAIN_ADDRESS`（主账户公开地址）· `HL_TESTNET_API_WALLET_KEY`（API 钱包私钥） |

变量名一律带 `TESTNET` / `DEMO`：主网密钥惯用的 `BINANCE_API_KEY` 这类名字**不会被任何脚本读取**（有测试守这条）。
缺哪个脚本就报哪个的名字（只报名，不报值），退出码 3，且不构造连接器、不发请求。密钥不进日志、不进回执表、不进 JSON 输出；
错误文本经 `lib/journey.mjs` 的 `createRedactor`（原文 + base64 形态）替换成 `<redacted>`。

API key 的权限请只开「读取 + 交易」，**不要开提现**（这些连接器本来也不调用提现接口）。

## 怎么跑

```bash
# 1) 在当前终端导出该场所的测试网密钥（不要写进文件、不要提交）
export BINANCE_TESTNET_API_KEY=...        # Windows cmd: set BINANCE_TESTNET_API_KEY=...
export BINANCE_TESTNET_API_SECRET=...

# 2) 跑旅程
node tools/testnet/journey-binance.mjs
node tools/testnet/journey-okx.mjs --instrument okx:BTC-USDT-SWAP --size 0.002
node tools/testnet/journey-bybit.mjs --json
```

参数（缺省值见 `lib/venues.mjs`）：

| 参数 | 作用 |
|---|---|
| `--instrument <id>` | 协议标的 id，缺省各所的 `BTC` 永续（如 `binance:BTCUSDT`、`gateio:BTC_USDT`） |
| `--account <id>` | 协议账户标签（只是本地字符串，缺省 `acct_01TESTNET`） |
| `--size <decimal>` | 下单量（基础资产）；会被场所步长、最小量与最小名义额修正 |
| `--base-url <url>` | 只接受登记表 `venues-testnet.json` 里**本场所**的测试网 / 模拟盘主机，或本机回环地址（`127.0.0.1` / `localhost` / `[::1]`，给本地镜像 / 假服务器用）；表外主机（含各所生产基址）一律退出 2，不读密钥、不发请求 |
| `--json` | 用 JSON 打印步骤（回执表给机器读） |
| `--help` | 用法 |

退出码：`0` 全部步骤通过；`1` 任一步失败（打印脱敏 Problem）；`2` 参数错误；`3` 缺少密钥（不发任何请求）。

## 旅程做了什么（13 步，顺序固定）

1. `connect`：拉合约清单（`start()`），打印场所 / 环境 / `amend` 能力位
2. `account`：查账户快照（余额条数、持仓条数）
3. `precondition-flat`：目标标的必须**没有持仓**，否则直接失败（`PRECONDITION_POSITION_OPEN`）——旅程只该在干净的测试网账户上跑
4. `instrument`：合约元数据（tick / step / min / 状态）
5. `reference-price`：取报价（`refreshQuote`，没有报价才退回盘口），算一个远离盘口的买价（低于参考价 15%）并按 tick 向下贴齐；数量按 step / min / 最小名义额修正
6. `place-limit`：下极小限价买单（`gtc`，不成交）；立刻成交会当失败（说明价格不够远）
7. `query-order`：按 `clientOrderId` 查单，必须查得到
8. `amend`：改单，价格再远离 5%（`amend` 能力位是 `none` 的 Bitget / Gate 如实标 `skipped`）
9. `cancel`：撤单
10. `confirm-cancel`：再查一次，必须是 `cancel*` / `closed` / `expired` 或查不到；最多重试 3 次，仍挂着就报 `ORDER_STILL_LIVE`
11. `place-trigger`：下触发单（`stop_market`，缺省 `sell`、触发价低于参考价 40%；IBKR 用 `buy`、触发价高于参考价 40%；都永不触发）
12. `cancel-trigger`：撤触发单
13. `positions-flat`：再查持仓，目标标的必须为空

回执表每行是「序号 / 步骤 / 耗时 ms / 结果 / 回执」。`ms` 包含连接器自己的限流等待（例如 Bitget 的撤单桶）。

## 失败怎么读

```
Problem: {"code":3006,"name":"VENUE_OUTCOME_UNKNOWN","message":"venue error after the request was sent; query by clientOrderId before retrying","retryable":false,...}
```

- 上游 Problem 原样保留码与名字（协议 §2.8），文本已脱敏；`venue` 里是场所自己的码与原话。
- 旅程自己的码：`4001 PRECONDITION_POSITION_OPEN`（账户不干净）、`4002 STEP_FAILED`（步骤约束不满足）、`4003 ORDER_STILL_LIVE`（撤了还挂着）。
- **3006 不要盲目重跑**：先按回执表里的 `clientOrderId` 在场所后台 / 客户端查那张单，确认它没在场上，再决定重跑。
- 失败后脚本不会自动补撤单；如果停在 `place-limit` / `place-trigger` 之后，请到测试网手动确认没有残留挂单。

## 离线测试（不联网、不要密钥）

```bash
node --test tools/testnet/test/
# 等价写法（Node 22.23 对目录参数的行为不同，两种都支持）：
node --test "tools/testnet/test/*.test.mjs"
```

53 例：`test/journey-lib.test.mjs` 测纯函数（定点定价 / 脱敏 / Problem 归并 / 回执表 / 场所参数表 / CLI 用法 / 实盘基址阻断），
`test/venues-testnet.test.mjs` 8 例测主机登记表（结构合法 / 表外主机被拒 / HTX 无测试网 / 缺省基址不许漂移 / 实盘主机不进表 / 篡改即红），
`test/journey-<venue>.test.mjs` 每所三例——假服务器上的完整旅程、没有密钥退出 3 且零请求、下单端点失败退出 1 且不回显密钥；
Alpaca / IBKR 另各加实盘配置（`AK` 密钥 / 实盘端口 / 实盘账户号）构造期被拒的用例（IBKR 的假 TWS 是真 socket，只监听 `127.0.0.1` 随机端口）。
`test/index.mjs` + `test/package.json` 只是让「目录形式」也能跑（Node 22.23 把目录参数当模块解析）。

测试用的是**各包已有的假服务器**（`packages/connector-<venue>-trade/test/helpers/`），进程内 `fetch`，不开端口、不读密钥。
假服务器本身是无状态夹具，`test/support/harness.mjs` 只补「下单 → 查单 → 撤单」这条时间线（否则固定夹具永远是 partially_filled，
确认撤销这一步永远过不去）。

## 为什么脚本里要 esbuild

连接器源码用了 TS 参数属性（`constructor(private readonly d: ...)`），Node 22 的 strip-only 类型擦除不支持，
直接 `import` `.ts` 会在加载阶段报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。所以 `lib/load-connector.mjs` 用仓库里已有的
esbuild 把连接器打成**临时 ESM**（`os.tmpdir()`，进程退出即删），再实例化。不写仓库内文件、不联网、不新增依赖。

## 会访问哪些主机（只有真跑时）

主机白名单的唯一出处是 **`venues-testnet.json`**（读数与校验在 `lib/venues-testnet.mjs`）：每条 `{venue, host, kind, officialUrl, officialMention, verifiedAt, note}`，
`officialUrl` 必须是官方文档页并亲测可达。当前登记：

| 场所 | 主机 | kind | 官方出处 |
|---|---|---|---|
| binance | `demo-fapi.binance.com` | 测试网 | developers.binance.com（USDⓈ-M General Info） |
| okx | `www.okx.com` | 模拟盘 | okx.com/docs-v5（模拟盘与实盘同主机，靠 `x-simulated-trading: 1`） |
| bybit | `api-testnet.bybit.com` | 测试网 | bybit-exchange.github.io/docs/v5/guide |
| bitget | `api.bitget.com` | 模拟盘 | bitget.com/api-doc（同主机 + `paptrading: 1`） |
| gateio | `api-testnet.gateapi.io` | 测试网 | gate.com/docs/developers/apiv4/en |
| alpaca | `paper-api.alpaca.markets` | 模拟盘 | docs.alpaca.markets/docs/paper-trading |
| ibkr | `127.0.0.1`（TWS 7497 / Gateway 4002） | 模拟盘 | interactivebrokers.github.io/tws-api |
| dydx | `indexer.v4testnet.dydx.exchange` · `dydx-testnet-rest.publicnode.com`（第三方节点） | 测试网 | docs.dydx.xyz/interaction/endpoints |
| **htx** | **无** | **无测试网** | HTX 官方 API 文档只列实盘 `api.hbdm.com` / `api.hbdm.vn` |

**HTX 没有测试网**：`api.hbdm.vip` 没有任何官方出处（批 8 差点连实盘），所以表里给它记的是「无测试网」。
`journey-htx.mjs` 因此一律退出 2 不给跑（离线假服务器仍可用 `--base-url http://<名字>.test`）。
护栏分三层：CLI 的 `assertTestnetBaseUrl()`（`lib/cli.mjs`，7 个走 `runCli` 的场所）、
`journey-dydx.mjs` 的双基址检查、`journey-htx.mjs` 的 `assertTestnetTarget()`；三者都查同一张表，表外主机一律拒。
离线测试不访问任何主机。

## 已知限制（如实）

- **没有接过真网**：本目录的旅程只在各包假服务器上跑过；真实测试网的字段 / 错误码差异要等 维护者 真跑时逐条核对。
- OKX 的公共行情（合约 / 报价）走数据包，不带 `x-simulated-trading` 头；签名请求都带。
- Bitget / Gate 不支持改单（连接器能力位 `none`），旅程第 8 步标 `skipped`，不会假装改过。
- 最小名义额不足时脚本会按 2 倍递增把数量抬到够（Binance 的 `MIN_NOTIONAL` 是 5 USDT），所以「极小单」是相对该所门槛而言。
- 回执表里的 `clientOrderId` 是 32 位十六进制（与内核同口径）；Gate 会把它编码进 `text`，回执仍然显示原号。
- 本目录不改任何包，也不在 CLI / 内核里加注册项（各连接器的注册在 `packages/cli/src/connectors.ts`）。
- **两个美股脚本（`journey-alpaca.mjs` / `journey-ibkr.mjs`）只在模拟盘跑**：Alpaca 只打 `paper-api.alpaca.markets` / `data.alpaca.markets`，实盘前缀 `AK` 的密钥在构造期被拒；IBKR 只连回环地址，实盘端口 7496 / 4001 在构造期被拒，账户号必须是模拟盘账户（`D` 开头，如 `DU…`），实盘账户号即使配自定义端口也在构造期被拒。IBKR 的触发单固定走 `buy` 形状（买入止损，场所参数 `triggerShape: 'buy'`）：IB 股票没有原生 reduce-only，平仓账户上发卖出触发单 = 开空，会被包的合规校验按持仓前置拒单；买入止损是开多方向，被接受且不会成交。
- **只有 维护者 持密钥时才真跑**：Alpaca 要 `ALPACA_PAPER_API_KEY` / `ALPACA_PAPER_API_SECRET`，并在常规交易时段、干净的模拟盘账户上跑；IBKR 要 `IBKR_PAPER_PORT` / `IBKR_ACCOUNT`，且本机 TWS / IB Gateway 已启动并登录（socket API 没有 API key，凭据就是那个登录会话）。两者目前只在本包假服务器 / 假 TWS 上跑过（离线 9 例：Alpaca 4、IBKR 5）。
- 远离盘口 15% / 40% 的价格在离线假服务器上可行；真测试网若有价格带限制（例如限价单偏离标记价的上限），第 6 / 11 步会如实失败退出 1，届时按场所规则调价再跑。

## 测试网账户准备

账户准备的步骤见 [`docs/user/20-测试网账户准备.md`](../../docs/user/20-测试网账户准备.md)。
下面这些事项仓库里目前没有、也未经真网核对，需要 维护者 自己核对官方页：

- Hyperliquid：测试网官方页面名——待 维护者 核对官方页
- Hyperliquid：测试资金领取——待 维护者 核对官方页
- Hyperliquid：测试网 `approveAgent` 的具体操作——待 维护者 核对官方页
- Hyperliquid：是否需要主账户派生——待 维护者 核对官方页
- Binance：测试网注册步骤——待 维护者 核对官方页
- Binance：测试资金领取——待 维护者 核对官方页
- Binance：测试网能否绑 IP——待 维护者 核对官方页

