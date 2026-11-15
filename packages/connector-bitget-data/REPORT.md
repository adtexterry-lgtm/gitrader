# REPORT · bitget

## 改了什么
新建 14 文件（src 4、test 6+helper、配置 3）。未改已有。

## 跑了什么
vitest exit 0，6/36 passed；tsc exit 0。夹具取真网（2026-10-20）截短；offline 条目与错误信封手写。

## 没做什么
无 WS；11 方法抛 CAPABILITY_UNSUPPORTED 零请求；未接 CLI；未 git/装依赖。

## 需要主会话决定
①翻页统一 history-candles ②pageLimit 写 1000 实际上限 200 ③minNotional 取 minTradeUSDT ④nextUpdate 无协议字段 ⑤includeDelisted 拿不到停牌 ⑥2h/8h 按工单拒绝（上游认 2H）。
