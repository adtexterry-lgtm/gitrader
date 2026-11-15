# REPORT · connector-htx-data（T2a）

## 改了什么

新建 16 文件（未改已有）：src 4 文件 1034 行、test 6+假服务器 944 行，另 5 个配套文件。HTX USDT-M 只读行情：目录、K 线、盘口、报价轮询、标记价+资金费；11 个交易账户方法抛 `CAPABILITY_UNSUPPORTED`。

## 跑了什么

vitest exit 0：6 files/42 tests 全过。tsc --noEmit exit 0。hygiene 5/6（红的是他标段 connector-htx-trade 缺 README；本包三项已单独核对）。check-public（临时 index，2081 文件）、audit-headers、deps-audit 全 exit 0。

## 没做什么

无 WS；夹具按官方示例手写、未抓真网；未接内核；未跑 git/装依赖；不支持官方未列的 6 个周期。

## 需要主会话决定

①markPrice 用 1min 标记价 K 线收盘 ②context 打两个端点 ③限频 800/s 还是读响应头 ④size 步长按 1 张。

## 自查表（SELF-CHECK 14 条）

| # | 结果 | 证据 |
|---|---|---|
| S1 | 过 | 参照独立：端点/字段/周期/分页均取自 HTX 官方 USDT-M v1 文档（huobiapi.github.io/docs/usdt_swap/v1/en，2026-10-21）；QD `live_trading/htx.py` 只作流程参照（Apache-2.0，未复制代码）；假服务器不 import 客户端 src（grep `from '` = 0 命中）。 |
| S2 | 过 | 6 个端点各有注释出处节名；错误码 1013/1030/1032/1033 出自官方 §Details of Each Error Code。 |
| S3 | 过 | 假服务器独立校验 period 取值、from 必须配 to、size∈[1,2000]，并回官方 1030/1033 信封；测试里有一条专门证明它「不是橡皮图章」。 |
| S4 | 不适用 | 只读、无交易/下单脚本，不碰钱。 |
| S5 | 不适用 | 未触发任何安全闸门，无绕过代码。 |
| S6 | 不适用 | 无沙箱/能力白名单。 |
| S7 | 不适用 | 无子进程；本轮 scratch 临时文件（index/文档转存）已删。 |
| S8 | 过 | 逐条回读注释与实现：`contract_size` 字段表写「USDT of one contract」但示例可验算为每张 0.001 BTC，注释按可验算口径并在 README 写明；README「CLI 写死 hyperliquid」旧说法已改。 |
| S9 | 过 | 临时 GIT_INDEX_FILE + `git add -A packages/connector-htx-data` 后跑 check-public（2081 文件）与 audit-headers（1288 文件），退出 0；跑完删 index。 |
| S10 | 过 | 待办/决定项前查了 `packages/cli/src/connectors.ts`（已是 `CONNECTOR_FACTORIES` 表，不再写死 hyperliquid），未把已了结项列为待办。 |
| S11 | 过 | 仅新增本包 16 文件；`git status` 里其余改动全属并行标段（kernel / 五个 ×-trade），本包未碰；未跑 git 写操作，临时 index 与 scratch 转存均已删。 |
| S12 | 过 | 四段式 + 数字为亲跑粘贴（见上）；借鉴 QD 流程已在 README/本表列明。 |
| S13 | 不适用 | 非修复任务，无审稿条目。 |
| S14 | 不适用 | 无撮合/状态机；数量换算统一走 `toBaseSize`（张×面值），无静默截断。 |
