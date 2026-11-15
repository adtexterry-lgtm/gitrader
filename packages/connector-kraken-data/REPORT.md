# REPORT · kraken

## 改了什么
新建 13 文件（src 4、test 7、配置 3）。REST 只读，venue kraken，只收 PF_ 永续。

## 跑了什么
vitest exit 0，6/33 passed 2.49s；tsc exit 0。夹具取真网 2026-10-20 截短，真网冒烟通过。

## 没做什么
无 WS；11 方法抛 CAPABILITY_UNSUPPORTED 零请求；未接 CLI；未 git/装依赖。

## 需要主会话决定
①fundingRate 取绝对值（relative 另字段）②计价币全 USD→inverse ③数量按张 ④orderbook 无 depth 本地截 500 ⑤charts 靠 more_candles 翻页。
