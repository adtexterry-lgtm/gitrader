# 标段 A · Go 参考引擎旁车（GEP stdio 单二进制）

## 改了什么
新建 `packages/protocol/examples/go-engine/` 五文件：`go.mod`（module gitrader.local/examples/go-engine、go 1.22、零依赖）、`main.go`（令牌取 `GITRADER_GEP_TOKEN`，缺则退出 2；NDJSON 帧与数组批量；读写各自 goroutine + channel；panic 转 JSON-RPC 错；`describe` 用 id `go-reference`，不声明可选能力组、不下单、不发事件流）、`main_test.go`、`run-conformance.mjs`、`README.md`（29 行）。另新建仓库根 `go.work`（一行 use）：仓库根没有 go.mod，命令①按 module 模式解析不了该 pattern。protocol 既有文件未改。

## 跑了什么
`go version go1.27.1 windows/amd64`。
① `go test ./packages/protocol/examples/go-engine/...` → ok，6 例全过（帧解析、0.1 过与 9.9→5001、错令牌 5003 且退出码 1、秘密字段 5006 不回显、describe 能力诚实、批量 id 一一对应）。
② `node …/run-conformance.mjs` → 退出 0；必测 T01–T26 = 10 passed / 16 skipped / 0 failed，整目录 19/60/5 全 0 failed，与 python-engine 逐项相同。
③ `hygiene.test.ts` → 6 passed，退出 0（其间曾因并行标段的插件包缺 README 失败过 1 项，其补齐后转绿）。

## 没做什么
未改 protocol 其它文件；未 git、未 install；未联网、未下单、未发事件流；未声明 strategy/backtest/replay/market.own（故 16 例按设计跳过）。

## 需要主会话决定
根 `go.work` 超出「只新建 go-engine」边界，是为让命令①在仓库根成立；要守边界就删掉它，改在目录内跑 `go test ./...` 或加 `GO111MODULE=auto`。hygiene 的 SPDX 扫描只覆盖 .ts/.mjs/.py，`main.go` 首行仍按 Apache-2.0 写了，是否扩到 .go 由主会话定。
