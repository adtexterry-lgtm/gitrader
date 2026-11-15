# REPORT · P1.2 策略 API + 沙箱 + 十个 TS 示例改 Python

## 改了什么
新建 13 文件。`engine/strategy_api.py`：策略钩子与 `ParamDef`（key/label/type/default/min/max/step/options/help/hidden）、
严格与夹取两档参数解析、`SignalSeries`、按协议 `signal.ts` 构造 `Signal`、结构校验（id/version/desc/tags/参数质量/承诺词）、
输出形状与动态校验（确定性、空/短序列、极端参数、前视偏差、anchor）、`load_strategy_source/file`。
`engine/sandbox.py`：白名单 math/statistics/decimal/collections、受限 builtins（无 open/eval/exec/compile/getattr）、
safe import + 模块代理、AST 静态校验（禁用模块/内置/dunder 逃逸、源码上限、节点上限）；策略档零 import。
`examples/` 下十个 TS 示例的 Python 版：同名、同参数、同语义。另加 `tests/test_strategy_api.py`。

## 跑了什么
`python -m unittest packages/engine-python/tests/test_strategy_api.py` → **13 文件 76 例全过**（0.31 s）。
另用 node 直接导入十个 `.ts` 示例，跑同一份 600 根合成 K 线：默认参数与 11 组非默认参数下 target 序列与 Python 版
逐根差 0（1e-9），覆盖 grid 等比、dca 预算取整、martingale 加倍。

## 没做什么
没写 `gep.py`/`main.py`/`backtest.py`/`indicators.py`（兄弟蜂文件）；没做回测循环与成交/权益一致性（P1.3）；
没移植指标库（P1.4）；没有运行期超时与内存看门狗（属宿主进程职责，已在模块文档写明）；未联网、未 git、未安装。

## 需要主会话决定
1) 策略文件是否零 import：现按 TS 硬规则实现零 import（grid 自带 `_ln`），白名单只对脚本档生效；要放宽请拍板。
2) `desc` 承诺词表沿用 ai-generation 的 7 词，是否与协议 `findPromiseLanguage` 合并成唯一词表。
3) 参数「越界报错」与「界面夹取」两档并存，界面侧请统一走 clamp。
