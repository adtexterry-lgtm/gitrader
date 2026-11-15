# REPORT · Q5 `packages/connector-dydx-trade`（dYdX v4 永续交易）

## 四段（≤400 字）

**做了什么**：新建 dYdX v4 交易连接器，9 文件 206 例全过、tsc 0。下单是真链上交易：MsgPlaceOrder/MsgCancelOrder → SignDoc → sha256 → secp256k1 → TxRaw → 广播。零第三方依赖，签名只用 node:crypto。

**怎么验**：假链节点独立解 TxRaw、复算 SignDoc、验签并校验整数倍；keccak/bech32 用公开向量；地址用「私钥 1 → 0x7E5F…Bdf」；价带、clientId 碰撞、3006 均有用例。

**没做到**：真网未验（端点 / gas / 手续费 / 触发口径）；逐仓、双向持仓、TWAP、trailing、附加止盈止损、改杠杆未接线；长单必须外部注入 fee。

**结论**：链上签名能只用 Node crypto 实现，不需 cosmjs / viem；本包未验真网，不得接实盘；注册内核由主会话定。

## 十二条教训自查

| # | 要求 | 落实 |
| --- | --- | --- |
| 1 | 端点以官方文档为准 | 字段号照 v4-chain `clob/order.proto`、`clob/tx.proto`、`subaccounts/subaccount.proto`、`cosmos/tx/v1beta1/tx.proto`；端点照 docs.dydx.xyz 并对主网 Indexer 实探（perpetualPositions / orders / fills 均 200）；`order_flags` 取值注释给出处 |
| 2 | 全撤 / 撤单方法照官方 | 撤单是链上消息 `MsgCancelOrder`（不是 DELETE）；假节点对非 POST 的广播回 405 并记账 |
| 3 | 非 GET 结果未知一律 3006 不可重试 | `client.ts`：POST 超时 / 断连 / 408 / 5xx → `outcomeUnknown`；`submit` 返回 `status:'unknown'` + 3006，不重发，提示按 clientOrderId 对账 |
| 4 | 市价必须带 maxSlippageBps，发价带限价 + IOC | `planOrder`：缺 bps → 1002/INVALID_PARAMS；按预言机价 `priceBand(bps)` → 限价 → TIF IOC → 短单 |
| 5 | 持仓用专用端点 | `startupSnapshot` 走 `/v4/perpetualPositions`，失败才退回子账户聚合字段 |
| 6 | 密钥用私有字段 / 闭包，导出与错误都不含 | `DydxSigner.#key`、`DydxHttp.#secrets`；测试覆盖 `JSON.stringify` / `util.inspect` / `String(err)`，错误文本脱敏 |
| 7 | 对账 / 数量 / 金额走 decimal | `precision.ts` 全部基于 `@gitrader/protocol/decimal` 的定点运算；quantums / subticks 用 bigint，无浮点 |
| 8 | 假服务器复算签名并校验必填 | `test/helpers/fake-dydx.ts` 独立 TLV 解码 + `crypto.verify` + 整数倍 / 到期 / metadata / TxExtension / chain_id 校验 |
| 9 | 能力老实 | market `emulated`、amend `none`、cancelAll `emulated`、trailing/twap `none`、tif 无 `fok`（proto 标 deprecated）、trigger 只 `mark`；对应方法回 1004 |
| 10 | 私有流归一保留成交号等 | 本包无私有 WS（Indexer 轮询）；成交保留 `venueFillId`（优先 `fill.id`）、`liquidity`、费用符号、`clientOrderId`；零仓位行跳过 |
| 11 | 限流 / 退避 | 每次请求 `budget.acquire(weight)`，权重 0 的链节点请求也 `acquire(0)`；429/418 → `penalize(Retry-After)` + 3003 可重试 |
| 12 | README 首行 + 不注册 CLI | README 第 1 行原文照抄；`package.json` 未加入 CLI / 内核，未改根 `package.json` / lock |

## Lighter 调研（只调研，未写码）

- **签名方案**：Lighter 的 API key 是独立于 L1 以太坊地址的密钥对；交易签名用 **ECgFp5**（Goldilocks 五次扩域上的椭圆曲线）+ **Poseidon 哈希**，公钥 **40 字节**，私钥由 seed 派生（`lighter-go/signer` 的 `GetScalarFromSeed`、`PubKeyBytes() [40]byte`，底层 `elliottech/poseidon_crypto`）。属于 zk 友好曲线，不是 secp256k1 / NIST 曲线。
- **官方实现形态**：签名逻辑只有 Go 实现，以 **Go 二进制 / C 共享库（.so/.dylib/.dll）/ WASM** 分发；Python、Rust、Java、React Native 都是包这层 FFI/WASM。`SignerClient` 调本地二进制；WASM 版在 Node 里也无法自己发 HTTP。
- **能否零依赖实现**：**不能（用 Node 内置 crypto）**。`node:crypto`/OpenSSL 没有 ECgFp5 与 Poseidon，无法复用；要零依赖只能自己实现 Goldilocks 扩域算术、ECgFp5 点运算、Poseidon 置换与签名编码（纯 bigint 可行但没有常数时间保证，且需与官方逐字节对齐测试向量）。**结论**：本批次不写 Lighter 交易连接器；若要做，先决定「自带 WASM/二进制（引入第三方产物）」还是「自写 ECgFp5+Poseidon（大工程量 + 侧信道风险）」。

## 停机原因

未停机。链上签名用 Node 内置 crypto 可以做到；没有为此引入任何第三方依赖。

## 需要主会话决定（只列事实）

1. 真网核对清单：主网 / 测试网节点基址（缺省用 publicnode，未核实可用性）、长单 gas 与手续费金额（`uusdc` 金额未定）、短单空手续费是否被接受、条件单按预言机价触发的实际表现。
2. API key（authenticator）模式未接：本包只支持直接用账户私钥签名。若内核的签名器句柄只能给「派生 key」，需要补 `TxExtension.selected_authenticators` 流程（编码已支持，缺的是取授权器 id 的查询）。
3. 逐仓 / 双向持仓 / `MsgUpdateLeverage` / TWAP 未实现；如果需要，按 `order.proto` 的 `twap_parameters` 与 `MsgUpdateLeverage` 补。
4. Indexer 私有 fills 无单笔已实现盈亏、子账户视图杠杆字段不稳定——若要精确对账，需要另读 `/v4/historicalPnl` 或链上 `subaccounts` 查询（本包未接）。
5. `packages/connector-dydx-data` 的 `DydxDataConnector` 未与本包联调（只按结构类型对接）；接线与 `node_modules/@gitrader/connector-dydx-trade` 软链登记等主会话统一 `npm install`。

## 验收实跑（仓库根，2026-10-21 实跑）

| 命令 | 结果 |
| --- | --- |
| `vitest --config ../../vitest.config.ts --root .`（包目录，等价于 `vitest --root packages/connector-dydx-trade`） | **9 文件 206 例全过**，2.3 s |
| `tsc -p packages/connector-dydx-trade --noEmit` | 退出 0，无错误 |
| `packages/protocol` `test/hygiene.test.ts` | **6/6 过** |
| `node scripts/check-public.mjs` | 退出 0（扫描 1960 文件，非营销失败 0） |
| `node tools/release/audit-headers.mjs` | 退出 0（1193 源文件，21 条历史例外未变） |
| `node tools/release/deps-audit.mjs` | 退出 0（第三方 12 个名字全在白名单；本包只依赖 `@gitrader/protocol`） |

两条需要说明的事实：

1. **README 首行**：工单要求首行「未经真网验证，不得接实盘；注册进内核由主会话另行决定。」，而 `protocol/test/hygiene.test.ts` 要求每个包 README 首行含 `CPAL-1.0`。两者冲突，本包把两句放在同一行：
   `未经真网验证，不得接实盘；注册进内核由主会话另行决定。（许可证：CPAL-1.0）`——工单那句话逐字在行首，hygiene 也过。若主会话要求首行只有那一句，就得改 hygiene 的规则（本包无权改）。
2. `check-public` 与 `audit-headers` 的文件清单取 `git ls-files`，本包**未提交**（工单禁 git 写操作），所以这两个脚本扫到的 1960 / 1193 个文件里不含本包新文件。本包已自查：25 个 `.ts` 文件首行全部是 `// SPDX-License-Identifier: CPAL-1.0`，`LICENSE` 与 `packages/connector-gateio-trade/LICENSE` 逐字节相同（`cmp` 通过），导入只有 `node:crypto` / `node:util`（仅测试）/ `vitest`（仅测试）/ `@gitrader/protocol`。
