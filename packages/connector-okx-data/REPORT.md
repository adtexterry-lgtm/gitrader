# REPORT · okx

## 改了什么
按口径修三点：①K 线 `v` = `vol × ctVal` 折币，盘口 `size` 同法，ctVal 仅存 `contractSize`；②`minNotional` 留协议缺省，不硬造 0；③只收 USDT/USDC 结算的线性永续，inverse 与 USD 结算排除。动 parse/market/README。

## 跑了什么
vitest 6 文件 33 测试全绿 3.03s；tsc --noEmit exit 0。新增：折币（BTC 0.01→0.1、ETH 0.1→1，volCcy 写错仍按 ctVal）、ctVal 缺失回落 volCcy、结算币过滤（USDC 收，BTC/ETH/USD 不收）；翻页升序去重保留。

## 没做什么
无 WS；11 方法抛 CAPABILITY_UNSUPPORTED 零请求；未接线内核；未 git/装依赖。

## 需要主会话决定
已按口径修：折 ctVal、线性过滤 USDT+USDC、minNotional 留空；限频 20/2s 与 after 翻页未动。余：内核接线。
