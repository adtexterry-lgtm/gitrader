<!-- SPDX-License-Identifier: Apache-2.0 -->
# GEP 一致性测试套件（契约 §2.11）

许可证 Apache-2.0，只需要 Node（>= 22.13）。扮演"宿主"：自带宿主仿真、确定性假场所和合成夹具（种子生成，不含任何录制的第三方行情）。

## 怎么跑

对一个已经在运行的引擎（ws / wss）：

```
GEP_ENDPOINT=ws://127.0.0.1:<端口>/gep GEP_TOKEN=<令牌> npx vitest run --config ../../vitest.config.ts --root . conformance --fileParallelism=false
```

让套件起一个子进程（任意语言，stdio / NDJSON，令牌经环境变量 `GITRADER_GEP_TOKEN` 传给子进程）：

```
GEP_LAUNCH='{"command":"<可执行文件>","args":["--gep","stdio"],"env":{},"cwd":"."}' GEP_TOKEN=<令牌> npx vitest run ... conformance --fileParallelism=false
```

两个都不设：对内存假引擎自测（`npm test -w packages/protocol` 就是这样）。

| 环境变量 | 含义 |
|---|---|
| `GEP_ENDPOINT` | ws:// 或 wss:// 地址 |
| `GEP_LAUNCH` | 引擎启动配置 JSON `{command, args, env, cwd}`，按 `EngineLaunch` 校验 |
| `GEP_TOKEN` | 令牌，默认 `conformance-token` |
| `GEP_EVENT_VOLUME` | T08 / T12 的事件量，默认 10000 |
| `GEP_REPORT_PATH` | 写 `gep-conformance-report.json` 的位置（套件版本、describe 摘要哈希、逐项结果、耗时、性能数字） |

对真引擎运行时必须关闭文件并行（它们共用同一个引擎）。等待时长按契约取值：心跳失联 15 s、背压 30 s、拆单观察 60 s，整套约数分钟。

## 文件

| 文件 | 内容 |
|---|---|
| `required.test.ts` | 必测 T01–T27（所有引擎） |
| `mode-a.test.ts` | 模式 A 必测 A1–A3 |
| `mode-b.test.ts` | 模式 B 必测 B1–B5：用例已登记为 todo（假场所的接入方式契约没规定） |
| `optional.test.ts` | 可选 O1–O8（按能力位） |
| `self.test.ts` | 套件自检：故障注入、stdio 传输 |
| `cases/` | 用例实现 |
| `fake-engine.ts` | 最小假引擎（内存）：让套件自己能跑通，也是写引擎时的最小参照 |
| `host-sim.ts` | 宿主仿真 + 假场所（可注入风控拒单 2001、精度 1002、结果未知 3006、限流 3002） |
| `transport.ts` | 内存 / WebSocket / stdio 传输 |

## GSP 迷你一致性套件

```sh
npm run conformance:gsp -w packages/protocol
node packages/protocol/examples/python-plugin/run-conformance.mjs
```

第一条默认对内存假插件跑 G01–G08；第二条从仓库根目录运行，
对纯标准库 Python 参考插件跑相同用例。无需新增依赖。

| 环境变量 | 含义 |
|---|---|
| `GSP_ENDPOINT` | 已运行插件的 ws/wss 入口，优先于 GSP_LAUNCH；ws 限 loopback |
| `GSP_LAUNCH` | JSON `{command,args?,env?,cwd?}`，套件起任意语言子进程 |
| `GSP_TOKEN` | 通道令牌；不设则随机生成，stdio 通过 GITRADER_GSP_TOKEN 注入 |
| `GSP_TOOL_CASE` | 可选 JSON `{tool,args,expected}`，默认 echo 往返一个对象 |
| `GSP_REPORT_PATH` | 可选 JSON 报告路径；仅记录传输类型、用例结果与耗时 |
| `GSP_PYTHON` | Python 一键脚本使用的已有解释器，默认 python |

stdio 的最小环境为 PATH / SystemRoot + 显式 env + GITRADER_GSP_TOKEN；
GSP_LAUNCH 的相对 cwd 从套件工作目录（protocol 包）解析。
目标 stderr 不进入套件报告。每个用例创建独立会话，结束后关闭；
stdio 清理只终止自己持有的子进程树。套件不下载、不启动外部服务。

| 用例 | 验收 |
|---|---|
| G01 | JSON-RPC 格式、stdio NDJSON、数组批量与 ID 对应 |
| G02 | 未 hello 先调用 5003；错令牌 5003 且 1 s 内断开；高版本、低版本、缺 gsp 字段 5001；0.1.x 协商 |
| G03 | describe 返回完整清单，通过现有插件 schema |
| G04 | health 返回成功状态 |
| G05 | 已声明工具往返、输入输出 schema、未知工具 -32601 |
| G06 | 未知方法与非法参数的 error.data 是 Problem |
| G07 | 嵌套秘密字段返回 5006，不回显参数值 |
| G08 | shutdown 5 s 内关闭，stdio 退出码 0 |

`gsp/{target,transport,cases,run,gsp.test}.ts` 分别负责目标选择、传输、
用例、结果收集、测试入口；常规 protocol 单测也包含内存 GSP 自测。
hello / describe / health 的参考形状见
[插件协议 §6.3](../../../docs/plugin-protocol.md#63-gsp-迷你套件)。
自定义工具时须用 GSP_TOOL_CASE 提供一个合法且可比较的样本。

ws 客户端复用 GEP 套件的 Node 全局 WebSocket，子协议为 `gep.v0`。
远端用 GSP_TOKEN 对应其通道凭据。独立套件仍可测试 GSP_ENDPOINT，
内核远程插件本轮在 inspect/start 返回 5002（remote plugins arrive with S3-C），
不连接、不写连接账本；`kernel/test/plugins-exec.test.ts` 验证该拒绝边界。
S3-C 须先完成整帧解析、帧大小与非 loopback 隐私授权检查；默认自测不代表真实远程验证。
客户端证书注入不在这套迷你套件能力范围内，wss + mTLS 未实测。

## 没测什么（如实）

- 模式 B 的 B1–B5：待契约规定假场所如何交给引擎。
- A3（引擎只用工作台连接）：从进程外无法检测，记"未测"。
- O5 回放、O8 大载荷：契约没有给出可判定的交付方式，记"未测"。
- 宿主侧 H1–H6（给宿主实现方，用回声引擎）：未做。
- 远程 wss 的 mTLS：只校验启动配置；套件的 WebSocket 客户端（Node 全局 WebSocket）不能带客户端证书。
- WebSocket 传输本身没有在套件自测里跑（Node 没有内置 WebSocket 服务端，且不引入 `ws` 依赖）：由 engine-core 的接入测试覆盖。
