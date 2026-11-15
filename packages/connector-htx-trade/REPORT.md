# REPORT · packages/connector-htx-trade（T2b）

**改了什么**：新建 26 文件：`src/`（rest 签名与端点表、orders 建单体、parse 双信封解析、account、trading、market、capabilities、errors、venue-errors、budget、precision、time、limit-safety、connector、index）+ `test/`（4 个测试文件 + 独立复算签名的假服务器与装配）。HTX 永续两代 API（v5 联合保证金 / v1 交叉保证金）都实现，`family` 选；市价意图发价带限价 + IOC；按张下单；触发单与 amend 老实回 1004；1499/1500 只重发一次并翻 `position_side`；3006 不重发。

**跑了什么**（仓库根，真实输出）：`vitest --root packages/connector-htx-trade` → **179 例全过**（4 文件）；`tsc -p packages/connector-htx-trade --noEmit` → 0 错；`hygiene.test.ts` → **5/6**，唯一失败是 `packages/symbol-search/README.md` 不存在（T3b 在建，非本包，未碰）；`check-public.mjs`（`GIT_INDEX_FILE` 临时索引，含本包 26 文件，2091 文件）→ ok；`audit-headers.mjs` → ok（1298 文件）；`deps-audit.mjs` → ok（本包零第三方）。

**没做什么**：没联网核官方文档（禁网），端点按 QD 实现 + 官方章节名标注，文档 URL 未实查；没做触发单（计划委托端点无参照，不编）；没做 WebSocket / 私有流；没注册 CLI / 内核；没 git 提交。

**需要主会话决定**：①`client_order_id` 是 int64，内核字符串 id 只能确定性单向映射，恢复靠同一函数重算；②`fills()` 必须带合约（HTX 成交端点要求 `contract_code`）；③`cancelAll` 走 v1 端点，v5 账户上退化为逐张撤；④是否把本包并进内核与 `connector-htx-data`（T2a）共用行情。

## 十二条自查

| # | 教训 | 落实 | 证据 |
|---|---|---|---|
| 1 | 端点以参照实现为准 | QD htx.py/htx_v5.py/native_protection.py 逐端点对照，`ENDPOINTS` 表带 family 与官方章节名 | `src/rest.ts` |
| 2 | 撤单 HTTP 方法照官方 | 撤单/全撤/建单全 POST，查询 GET；假服务器按 `METHOD + path` 路由，方法错回 404 | `rest.ts ENDPOINTS`、`test/helpers/fake-htx.ts` |
| 3 | 结果未知 → 3006 不重发 | 非 GET 408/5xx、1002/1003 → 3006；ack `status:'unknown'`；GET 同类 → 3003 | `errors.ts`、`trading.ts problemAck`、测试「5xx → 3006 / GET 5xx → 3003」 |
| 4 | 市价带 maxSlippageBps | 缺则 INVALID_PARAMS；实际发价带限价 + IOC | `orders.ts`、测试「市价意图缺 maxSlippageBps」 |
| 5 | 持仓从专用端点取 | v5 position/opens → 失败回退 position_all；v1 cross_position_info | `account.ts rawPositions`、回退测试 |
| 6 | 密钥不泄漏 | `#apiSecret` 私有字段；redact 覆盖原文与 base64；JSON/inspect 测试 | `errors.ts`、测试「密钥不出现在 JSON.stringify / inspect」 |
| 7 | 数量金额走定点 | 张换算与价格贴 tick 全 bigint（`precision.ts`），无浮点加减 | `precision.ts` |
| 8 | 假服务器复算签名 + 校验必填 | 假服务器独立用 `node:crypto` 重算四行待签串；缺参回官方文案错误；签名错回 401 | `test/helpers/fake-htx.ts`、签名错误 → 3005 测试 |
| 9 | capabilities 老实 | market=emulated、触发单/trailing/twap=none、amend=none、cancelAll=emulated、deadman 不声明 | `capabilities.ts` + 能力测试 8 例 |
| 10 | 成交归一保留去重键/类型/平仓行 | 去重键 `htx|<trade_id>`；fee 取反；offset=close 与 profit 都算平仓 | `parse.ts` + 测试 |
| 11 | 权重 0 也走 acquire(0)、429/418 同 HL | `signed(order:true)` 权重 0 仍 acquire 并记下单桶；429/418/403+too frequent → 3002 | `rest.ts spend`、`budget.ts`、测试 |
| 12 | README 首句红线、不注册 CLI | README 第二段原文照抄；无 CLI 注册 | `README.md`、无 cli 改动 |

## SELF-CHECK 14 条

| # | 判定 | 证据 |
|---|---|---|
| S1 独立参照 | 过 | QD（Apache-2.0，`file:line` 注释）+ HTX 官方文档章节名；测试期望值在测试内用 node:crypto 重算 |
| S2 端点/码以官方为准 | 部分 | 每端点带官方章节名；**未联网实查文档 URL**（禁网），码表只收 QD 点名的 1499/1500，其余靠官方文案分类 |
| S3 假服务器独立 | 过 | `fake-htx.ts` 不 import 任何 `src/`；自己重写待签串与 HMAC；`signatureFailures` 断言真验签 |
| S4 碰钱脚本护栏 | 不适用 | 无测试网脚本、无实盘路径；连接器不联网（测试全离线），README 红线句 |
| S5 不绕安全闸门 | 过 | 持仓模式不匹配只重发一次并翻参数，第二次失败交回上游原文；不切账户资产模式 |
| S6 沙箱逃逸 | 不适用 | 本包无沙箱 / 无动态求值 |
| S7 子进程治理 | 不适用 | 不起子进程；收工无后台进程 |
| S8 注释与实现一致 | 过 | 逐条核对：amend 无实现故声明 none；tpsl 仓位级；market 发 IOC 限价；无「声称校验却 void」 |
| S9 扫描覆盖新文件 | 过 | `GIT_INDEX_FILE` 临时索引把本包 26 文件纳入 `git ls-files`，check-public 扫 2091 文件后 ok |
| S10 待办核现状 | 过 | 未把 T2a / CLI 注册等他人事项当自己的待办；`symbol-search` 失败已标明非本包 |
| S11 无临时文件 | 过 | 已删 `node_modules/.vite` 缓存与临时索引；`git status` 仅本包目录新增 |
| S12 REPORT 四段 + 数字真实 | 过 | 数字全部来自本次真实命令输出；借鉴第三方列出 QD 文件与行号 |
| S13 修复单对照 | 不适用 | 非修复任务 |
| S14 状态机边界穷举 | 过 | 市价/限价/IOC/FOK/postOnly、单向/双向、开/平、1499/1500、不足一张、超杠杆、订单已撤、全撤退路均有用例 |
