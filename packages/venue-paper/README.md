> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/venue-paper

模拟场所 `kernel-sim`（契约 §1.5.3）：吃真实 L2 盘口做纸面撮合，实现与真连接器同一个 `VenueConnector` 接口，多账户，带回放模式。风控不在这里（风控闸在内核）；这里只做撮合与记账。

```ts
import { PaperVenue } from '@gitrader/venue-paper'

const paper = new PaperVenue({ market: hlConnector /* 或 ReplayMarket */, clock: () => Date.now() })
paper.createAccount({ accountId: 'acct_…', initialBalance: '10000' })
await paper.submit({ account: { accountId: 'acct_…', address }, signer }, [intent]) // 纸面从不签名
paper.start(1000)                       // 每秒 tick：资金费 → 强平 → 触发单 → 挂单；回放时不开，由回放循环调用 tick()
paper.onEvent((e) => { /* order / fill / position / funding / liquidation */ })
const saved = paper.exportState()       // 包含账户、挂单、持仓及全局订单/成交序号
```

内核在纸面事件、周期快照及正常停止时原子保存 `paper-state.json`；启动先导入，再通过统一对账校准订单、成交、权益及持仓。崩溃重启也复用保存的序号。显式重置用 `gitrader paper reset --account <alias>`（服务运行中、人面 PIN）；重置入账且不回退序号，未重置不清零。

## 能力声明

镜像被模拟场所的能力（`describe()` = 行情源的能力，去掉死人开关与签名者，加 `x-kernelSim`）。支持订单类型 限价 / 市价 / IOC / ALO / 止损 / 止盈 / TP-SL 父子单；改单、撤单、全撤、按标的设杠杆；`scheduleCancel` 不支持（`5002`）。账户模式固定 `standard`，单向持仓，全仓。

## 撮合假设

**见 [ASSUMPTIONS.md](./ASSUMPTIONS.md)**（对外声明 `kernel-sim` 的逐条解释，测试保证与契约声明一致）。一句话：逐档吃 L2、盘口不够末档 ±0.1%、无盘口 mid ±5 bp、挂单碰价按限价整笔成交且不排队、没有延迟、资金费按小时连续计提、强平按标记价账户级近似——**纸面成绩偏乐观**，必须与回测、实盘分开标注。

## 回放

`ReplayMarket` + `runReplay()` 按时间戳重放 `fixtures/hl/replay/*.json`，时钟由回放驱动；同一夹具同一串指令（含客户端订单号）结果逐位一致。夹具里的盘口是把真实盘口形状平移到每根收盘价合成的，用来验证撮合与账务，不用来评估策略盈利。

## 限速口径

模拟场所本身不发请求：行情来自注入的行情源（HL 连接器的 60% 权重预算见 `connector-hyperliquid` README）。**盘口读连接器用 WS `l2Book` 订阅维护的本地快照**（`bookSnapshot()`，带 `asOf` / `stale`），每笔纸面单零 REST；只有快照缺失 / stale 时才走有界、限频的 `refreshBook()` 兜底，拿不到就拒单并给可读错误，不阻塞。基准 `bench/connector`：连发 500 笔纸面单，快照模式 REST 盘口请求 1 次（首单等流启动那一次，权重 2），旧的逐单 REST 要 500 次 / 权重 1000，并被限速拖住（虚拟时间约 157 s）。

## 测试

`npm test`：吃单穿档 / 末档补足 / 无盘口、滑点上限、挂单碰价、穿价限价、IOC / ALO、reduceOnly、父子单、触发单、资金费（多空方向）、强平与强平价估算、多账户隔离、状态导出导入、回放确定性、声明与契约一致。
