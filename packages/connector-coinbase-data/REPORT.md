# REPORT · coinbase

## 改了什么
本目录 16 文件（本轮改 src/parse.ts、src/market.ts、test/quotes.test.ts、README.md）。只读现货，venue coinbase，InstrumentId 保留 product_id。

## 跑了什么
vitest exit 0，6/38 passed 6.52s；tsc exit 0。夹具真网截短（2026-10-20，BTC-USD 产品/ticker/盘口/1m K 线）。

## 没做什么
无 WS；11 方法抛 CAPABILITY_UNSUPPORTED 零请求；未改目录外文件；未 git/装依赖。现货无标记价/资金费：context 的 markPrice 取缓存报价最新成交价（无则买 bid/ask 中价），无缓存先拉一次 ticker。

## 需要主会话决定
①是否注册内核与 CLI ②K 线翻页窗口 350 根/窗 ③book 深度上限 250。
