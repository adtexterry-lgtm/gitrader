# REPORT · connector-dydx-data

## 改了什么
新建 15 文件（src 4、test 7、README、package.json、tsconfig），未改已有文件。

## 跑了什么
vitest exit 0：6 files / 41 tests 全过。tsc --noEmit exit 0 无输出。夹具取自真网 indexer.dydx.trade（2026-10-20），已截短。

## 没做什么
无 WS；无账户交易（11 方法抛错、零请求）；未接 CLI、未跑 git、未装依赖、未改根配置。

## 需要主会话决定
①context 读缓存不发请求 ②quote 两次请求，trades 失败只丢 last ③非 ACTIVE 按 delisted ④无 minNotional、settle=USDC ⑤仅 7 个周期。
