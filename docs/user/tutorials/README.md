# 教程（照着敲的那种）

三篇端到端教程，每一条命令都可以直接跑。中英各一份，内容一一对应：

| # | 中文 | English | 你会得到 |
|---|---|---|---|
| 01 | [从 K 线到一个因子报告](01-数据到因子报告.md) | [From candles to a factor report](en/01-data-to-factor-report.md) | 规范 JSON + 体检 + 157 条因子的 Markdown / HTML 报告 |
| 02 | [写一个策略，回测它，出报告](02-写策略跑回测.md) | [Write a strategy, backtest it, export a report](en/02-strategy-and-backtest.md) | TS 与 Python 两版策略、两份结果 JSON、两份报告 |
| 03 | [纸面模式与通知](03-纸面模式与通知.md) | [Paper mode and notifications](en/03-paper-mode-and-notifications.md) | 起内核、装通道插件、授权、配通道、收到一条真通知 |

## 共同前提

- Node ≥ 22.18（`node --version` 看一眼；仓库的 `tools/` 目录靠 Node 自带的 TypeScript 类型擦除跑 `.ts`）。
- 命令都在**仓库根目录**执行，产物写到 `./tutorial-lab/`（教程自己的练习目录）。教程 03 用
  `./tutorial-lab/kernel` 作为内核主目录，**不碰你真实的 `~/.gitrader`**。
- 教程 02 的 Python 版需要 `python` ≥ 3.11 在 PATH 上（零第三方依赖）。
- 全程离线：不联网、不需要密钥、不下单。教程 03 的 webhook 指向 `127.0.0.1` 上的本地接收器。

> 全局装过 Gitrader 的机器，命令里的 `gitrader` 直接用。在源码树里没装全局包：先 `npm run build`，
> 然后把 `gitrader` 换成 `node packages/cli/dist/bin.js`。

## 教程目录里还有什么

| 文件 | 干什么 |
|---|---|
| `strategies/tutorial-sma-band.ts` / `.py` | 教程 02 的策略两版（教程正文里的代码就是这两份文件） |
| `backtest.mjs` | 教程 02 的回测入口：`--engine ts` 调 `@gitrader/engine-core`，`--engine py` 调 `packages/engine-python` |
| `backtest_py.py` | 上面 `--engine py` 的分身（也可以单独跑） |
| `report.mjs` | 调 `@gitrader/report` 的 `run()` 渲染 Markdown / HTML（`packages/report/src/cli.ts` 不自执行，所以要这一层） |
| `ts-register.mjs` | 让普通 `node` 能 import 本仓的 TS 工作区包（复用 `tools/data/lib/ts-shim.mjs` 的解析钩子） |
| `add-notify-channel.mjs` | 教程 03 的配置助手：往 `gitrader.json` 加一条 webhook 通道（写前用内核的校验跑一遍） |
| `notify-sink.mjs` | 教程 03 的本地通知接收器（只听 `127.0.0.1`） |

## 冒烟：教程里的命令是真跑过的

```bash
node --test docs/user/tutorials/test/tutorials.test.mjs
```

它把中英六篇里的**每一个 ```bash 块逐条执行**并断言退出码，另加三条结构检查（教程代码块与
`strategies/` 下的文件逐字一致、样例 CSV 体积 / 表头 / 来源许可、样例能被 `tools/data` 与
`tools/research` 读）。约定与例外都写在脚本开头：只有 `gitrader status` 在服务停掉后曾允许返回 1
（F1 契约后它退出 0，脚本里的容忍分支保留不动），PIN 由脚本自己给（相当于读者在终端里敲），常驻命令按后台起、
遇到文档里「按 Ctrl+C」那一步停掉。产物全部落在临时 `HOME` 下，跑完就删，不写仓库。

数据样例在 `assets/samples/`，来源与许可证见那里的 `README.md`。
