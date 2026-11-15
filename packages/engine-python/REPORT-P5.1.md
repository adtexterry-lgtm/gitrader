# REPORT-P5.1 · Python 引擎二阶段①：策略装载 + 执行限制

**做了什么**（只动 `packages/engine-python/`）：新增 `engine/limits.py`（钩子 2 s、整次回测 900 s、内存 256 MiB，均可经
`GITRADER_ENGINE_*` 配；子进程监督、进程树 RSS、`kill_tree`）、`engine/strategy_child.py`（`load` / `evaluate` 作业）、
`engine/strategy_loader.py`（目录发现、装载、`params` 解析与 schema、加载报告、钩子探测）、`tests/test_strategy_loader.py`。
`gep.py` 只加不删：`strategy.list` 列内置 + 目录策略，`strategy.params` 按 `strategyId` 答，`strategy.start` / `update`
用该策略自己的参数声明且启动前跑一次钩子（超限回 4002，引擎不死），新增扩展方法 `x-gitrader.strategy.files`
（能力位 `x-gitrader.strategy-folder`，methods.ts:371），`backtest.run` 加协作式整次预算（超时作业 failed、`result` 回 4002）。
方法名以 methods.ts 为准：协议里**没有** `strategy.describe` / `strategy.load`，故不新造——「描述」由 `strategy.params` 承担，
「装载报告」由上述扩展方法承担。

**验收（亲跑）**：`test_strategy_loader.py` 57 例全过（14.3 s）；全包 307 例全过（15.4 s，250 旧例全在，无回归）；
conformance pass 18 / skip 19 / fail 0，O1–O4 全 pass（未退步）；真进程冒烟：`GITRADER_STRATEGIES_DIR=examples` →
`strategy.list` 11 项、`strategy.params(ema-cross)` 正确、`x-gitrader.strategy.files` 10/10 loaded（1.4 s）、`engine.health` 正常；
`node scripts/check-public.mjs` 退出 0，新文件无本机路径 / 禁词 / 邮箱，SPDX 首行齐全。

**取舍（Windows 内存上限）**：`resource.setrlimit` 不可用，故用「子进程 + 父进程轮询 RSS」——Windows 走
`GetProcessMemoryInfo`（ctypes，无 psutil），POSIX 走 `/proc/<pid>/statm`。采样对象是**整棵进程树**：venv / uv 的
`python.exe` 只是启动器（本机实测启动器 5.9 MB、真正跑代码的子进程 228 MB），只看 `Popen` 的 pid，上限形同虚设。
零页分配不进工作集，故子进程另报 `tracemalloc` 峰值，两者取大。这是护栏不是内核配额（硬隔离要 Job 对象 / cgroup）；
回测上限是协作式的（每根 K 线问一次），能硬杀的只有钩子那条子进程路径。超限= 杀子进程，不抛异常到引擎。

**需要主会话决定**：① 协议无超时 / 资源码，超限统一回 `STRATEGY_ERROR 4002`（message 写阈值），是否加新码；
② `test_gep.py` 改了两行（原测试把能力位名单写死成协议键，现放行 `x-` 前缀，schema 本就允许），请核这两行；
③ 启动后首次 `strategy.list` / `engine.describe` 会为每个文件起两个短命子进程（10 个示例约 1.4 s，之后按 mtime 缓存，
命中时零子进程），接内核前是否改成后台扫描；④ 目录里的策略能起实例，`backtest.run` 仍只跑内置（P5.2 接模拟器）。
