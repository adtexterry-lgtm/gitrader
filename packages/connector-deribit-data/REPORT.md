# REPORT · deribit

## 改了什么
新建 15 文件（src 4、test 7、配置 4）。venue deribit，instrumentKinds ['perp','future']。夹具真网 2026-10-20 截短。

## 跑了什么
vitest exit 0，6/34 passed；tsc exit 0。

## 没做什么
无 WS；11 方法抛 CAPABILITY_UNSUPPORTED 零请求；未接内核；未 git/装依赖。8h/3d/1w/1M 无 resolution→INVALID_PARAMS。简化：tick 缺→sigFigs 5；lot_size 缺→step 1。

## 需要主会话决定
①交割是否加到期字段 ②count 20/秒是否内核口径 ③是否按 venues 装配。
