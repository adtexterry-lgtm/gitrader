# REPORT · data-files

## 改了什么
新建 13 文件：src 7、test 6 组 23 例、配置 4。零第三方依赖。

## 跑了什么
vitest exit 0，6/23 passed；tsc exit 0；hygiene 1/6 passed。

## 没做什么
解析口径与 engine-core/data.ts 同规则（表头、坏行跳过、按 t 升序去重保留先出现）；interval 取相邻 t 差众数对齐 CANDLE_INTERVALS；缺口上限 50；normalize 只做 K 线。

## 需要主会话决定
①CLI 的 bin 接线（工单暂不加，run(argv) 可导入）②缺口 from/to 推断口径是否够用。
