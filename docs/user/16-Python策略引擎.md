# Python 引擎：策略目录与沙箱

Gitrader 的引擎可以是任意语言的子进程。Python 引擎（`packages/engine-python/`）就是其中一个：**你把 `.py` 文件丢进策略目录，它就能列出来、起实例、跑回测**。这一页讲三件事：目录怎么放、策略文件长什么样、你的代码被什么限制着。

Python ≥ 3.11，**零第三方依赖**（没有 numpy / pandas），不联网、不读密钥文件、**没有任何下单路径**。

> **数据源限制**：Python 引擎的回测只支持 `spec.data.source = "host"`（K 线由内核提供）。`files` 源（自带 csv / json 文件）当前不可用——写 `files` 或 `engine` 会回 `4005 DATA_UNAVAILABLE`，不会编造结果。要拿自己的历史文件做回测，请用 TypeScript 引擎（`@gitrader/engine-core`，格式见 [04-回测与研究](04-回测与研究.md)）。

## 1. 装与注册

装好的包里 Python 引擎已经随包：默认配置里有一项 `python-engine`，`enabled` 是 false。最简单的启用写法，是把 `gitrader.json` 里的这一项改成下面这样，然后重启服务：

```json
{ "engines": [ { "id": "python-engine", "enabled": true, "builtin": true } ] }
```

`gitrader engines list` 里它变成 `ready` 就接上了。下面这种带 `launch` 的写法，是给「从源码目录跑自己改过的引擎」用的：

```json
{
  "engines": [
    { "id": "python-engine", "enabled": true,
      "launch": { "command": "python",
                  "args": ["engine/main.py"],
                  "env": {},
                  "cwd": "<指向 packages/engine-python 的实际路径>" } }
  ]
}
```

- `cwd` 必须是本包目录（`engine/main.py` 是相对 `cwd` 的路径）。
- `command` 是本机解释器；Windows 上 `python` 不在 PATH 时填绝对路径。
- **不要在 `env` 里写令牌**：内核给每个本地引擎注入一次性 `GITRADER_GEP_TOKEN`；缺令牌时进程往 stderr 打一行、以退出码 2 结束。
- 内核还会注入两个目录：策略目录 `GITRADER_STRATEGIES_DIR` 与产物目录 `GITRADER_ENGINE_ARTIFACT_DIR`；只有你在 `launch.env` 里显式给了，才用你的。
- 子进程**不继承**你的环境：只有 PATH / SystemRoot、上面两个目录变量、`env` 里的键和令牌。所以 `GITRADER_ENGINE_*` 这类限制参数要在内核拉起时生效，得写进 `launch.env`。

接上之后的自检顺序：

```sh
gitrader engines list                    # 状态 ready 才算接上
gitrader engines bind python-engine      # 绑纸面账户，要你本人输 PIN；绑定本身不给权限
node packages/engine-python/run-conformance.mjs   # 改过本包后先跑套件
```

`run-conformance.mjs` 用 `GEP_PYTHON`（缺省 `python`）找解释器，找不到退出码 3；套件跑完但 O1–O4 任一未过则退出码 4。

**当前实盘账户启动策略会被内核直接拒绝。**

## 2. 策略目录：文件即安装

- 只读目录**下一层**的 `*.py`，不进子目录。
- 文件名以 `_` 或 `.` 开头的跳过（`_helpers.py` 是草稿，不是策略）。
- 一个文件 = 一个策略：模块级 `STRATEGY` dict —— `id` / `name` / `version` / `desc` / `tags` / `params` / `evaluate`。
- `params` 每项是 `{key, label, type, default, min, max, step, options, help}`，与 TS 侧 `export default strategy` 同义。
- 两个文件声明同一个 `id`：按文件名字典序，后一个报 `duplicate-id`。
- 单次扫描最多 200 个文件，多出的**报错**，不悄悄丢掉。
- 装载结果按 `(mtime_ns, size)` 缓存：目录没变时 `strategy.list` 只做几次 `stat`，不再起子进程。

目录里的策略能列（`strategy.list`）、能描述（`strategy.params`）、能起实例（`strategy.start`）、能被回测（`backtest.run` 的 `subject.strategy.id` 填它的 id；求值在子进程里做，整段目标仓位一次算完再交给模拟器）。

本地试跑（不起内核）：

```sh
GITRADER_STRATEGIES_DIR=packages/engine-python/examples GITRADER_GEP_TOKEN=<token> python engine/main.py
```

## 3. 沙箱：你的代码跑在子进程里，被四条线卡着

策略文件**永远不在引擎进程内执行**：装载与求值都在独立子进程（`engine/strategy_child.py`）。

| 限制 | 缺省 | 环境变量 | 超限时 |
|---|---|---|---|
| 单个钩子（装载一次 / 一次 `evaluate`）墙钟上限 | 2 s | `GITRADER_ENGINE_HOOK_TIMEOUT_S` | 杀子进程，`strategy.start` 回 `4002 STRATEGY_ERROR`，加载报告写 `limit: "hook_timeout"` |
| 回测里一次「整段信号」调用 | `max(2 s, 15 × 钩子上限)`（缺省 30 s），再被整次回测上限截断 | 同上 + `GITRADER_ENGINE_BACKTEST_TIMEOUT_S` | 杀子进程，作业 `failed`，`backtest.result` 回 `4002` |
| 整次回测墙钟上限 | 900 s | `GITRADER_ENGINE_BACKTEST_TIMEOUT_S` | 回测循环协作退出，作业 `failed`（不编造结果） |
| 内存上限（整个子进程，含解释器） | 256 MiB | `GITRADER_ENGINE_MEMORY_MB` | 父进程轮询到就杀，报告写 `limit: "memory"` |
| RSS 采样间隔 | 20 ms | `GITRADER_ENGINE_POLL_INTERVAL_S` | — |

**静态校验**（`engine/sandbox.py`）在子进程里先跑一遍：禁止任何 `import`（白名单 `math` / `statistics` / `decimal`；`collections` 只给脚本档）、禁止 `os` / `sys` / `subprocess` / `socket` / `open` / `eval` / `exec` / `__import__` 与 dunder、帧与闭包访问器、`str.format` / `format_map`，以及写着逃逸用 dunder 名字的字符串字面量；受限 builtins 里**没有 `print`**（策略不能往 GEP 的 stdout 协议流写东西）。批 10 新增三条拒绝规则（规则名就是报错里给的那个）：`class`（策略文件不支持 class 定义，状态放进 `evaluate()`）、`unsupported-builtin`（`staticmethod` / `classmethod` / `property` / `chr` / `format` / `memoryview` 不在沙箱 builtins 里）、`encoding`（策略文件必须是 UTF-8）。

超限不是崩溃：子进程被杀，引擎继续答 `engine.health` / `engine.describe`，同一次会话可以继续起别的策略。

## 4. 这些限制里有真有假，照实说

- **Windows 上没有 `resource.setrlimit`**：内存上限不是内核配额，而是「子进程 + 父进程轮询」。采样是**观察不是拦截**，两次采样之间分配又释放的峰值可能漏掉；所以子进程另报 `tracemalloc` 的 Python 堆峰值，两者取大。采样对象是**整棵进程树**（venv / uv 的 `python.exe` 常常只是启动器）。
- **回测上限是协作式的**：「最多跑这么久」，不是「一定在这么久内返回」；能硬杀的只有钩子那条子进程路径。
- 真要硬隔离得靠操作系统（Job 对象 / cgroup），不在这个包的范围。

所以：**别把沙箱当安全边界来跑陌生人的代码**。它是「防止误伤协议流和引擎」的护栏，不是容器。

## 5. 它不做什么

- 不下单、不接场所、不跑纸面 / 实盘：`order.*` 与 `market.*` 一律回 5002。
- 不实现 `events.resume`；宿主用 `engine.snapshot` 对齐。
- 不读 CSV / parquet：回测数据只从宿主取（`spec.data.source = "host"`），`engine` / `files` 两种来源回 4005 `DATA_UNAVAILABLE`，结果不伪造。
- 回测只做单标的、单策略，不做工作流回测；强平只在单根 K 线判定，没有跨根保证金路径、不做部分强平。
- `indicators.py` 的指标还没接到引擎面（策略里能自己 `import math` 手算，但库里的指标目前不经协议暴露）。
