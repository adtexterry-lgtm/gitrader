# REPORT · connector-binance-data

## 改了什么
新建 14 文件（未改已有）：src/parse+market+connector+index 共 791 行；test 6 文件+助手 596 行；README、package.json、tsconfig。

## 跑了什么
vitest → exit 0，6 files / 28 tests passed，2.15s。tsc --noEmit → exit 0，无输出。

## 没做什么
无 WS（订阅轮询 bookTicker）；无交易账户（11 方法抛 CAPABILITY_UNSUPPORTED 不联网）；未接内核（CLI 写死 hyperliquid）；未跑 git、未装依赖、未改根配置。

## 需要主会话决定
①是否注册进内核与 CLI ②预算 take 权重优先、缺失回退 acquire 是否统一 ③资金间隔固定 8h、深度向上取整是否对齐内核。


## 主会话答复（2026-10-20）
①注册：要，改为 CLI 按配置 venues[] 装配连接器（hyperliquid 照旧、binance 只读、不认识的跳过）——由主会话另行施工，本包不改。
②预算：待审稿核实 KernelRateBudget 实际方法后按内核为准统一，本包实现不动。
③已知简化（接受）：资金间隔固定 8h、深度向上取整；对协议字段无影响。
