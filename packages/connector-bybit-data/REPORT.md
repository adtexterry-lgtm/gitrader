# REPORT · bybit

## 改了什么
新建 14 文件。合约按 nextPageCursor 翻页只收 Trading+Linear；K 线倒序翻升序；tickers 供 quote+context；11 方法同步拒绝。

## 跑了什么
vitest exit 0，6/34 passed 2.18s；tsc exit 0。夹具 BTCUSDT/ETHUSDT/0GUSDT 真网截短（2026-10-20），翻页/盘口/缺字段手写。

## 没做什么
无 WS；11 方法抛 CAPABILITY_UNSUPPORTED 零请求；未接 CLI；未 git/装依赖。

## 需要主会话决定
①非 Trading/Linear 即丢弃 ②数量按标的币 ③区间翻页用 start/end ④8h/3d 拒绝是否接受 ⑤fundingInterval 缺失回落 8h。
