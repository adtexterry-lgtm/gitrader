# REPORT · kucoin

## 改了什么
新建 14 文件（src 4、test 6+helper、配置 3）。夹具取真网 2026-10-20 截短（合约 5、盘口 3 档/边、K 线 5 根），depth100 合成。

## 跑了什么
vitest exit 0，6/34 passed 2.25s；tsc exit 0。

## 没做什么
无 WS；11 方法抛 CAPABILITY_UNSUPPORTED 零请求；未接 CLI；未 git/装依赖。

## 需要主会话决定
①盘口 size 按 multiplier 折币数、venueSizeUnit 仍 contract ②无 minNotional ③nextFundingRateTime 无协议字段未下发 ④纳秒时间戳按量级归一 ⑤3m/3d/1M 按工单拒绝（上游认 3）。
