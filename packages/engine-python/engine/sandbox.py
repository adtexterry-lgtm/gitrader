# SPDX-License-Identifier: CPAL-1.0
"""策略沙箱：模块白名单、受限 builtins、AST 静态校验。

这不是「安全执行来路不明代码」的沙箱：策略是用户自己的代码，这里的限制是护栏，挡住策略文件
意外（或被模型生成后）引入 IO / 网络 / 进程 / 随机数 / 墙钟。真正的隔离由进程边界负责（策略在
引擎进程里跑，引擎不持有任何密钥）。

出处（只抄清单与做法，代码按 Python 重写）：
- 禁用项照 packages/engine-core/src/strategy/ai-generation.ts:93-102（FORBIDDEN_NO_IO）与 :62-66（Forbidden 段）；
- 受限 builtins、模块白名单、safe import、dunder 后缀与帧 / 代码 / 闭包访问器拦截照 QuantDinger v5.6.5 (Apache-2.0):
  backend_api_python/app/utils/safe_exec.py:46-93、:206-243、:1023-1026；adapted（改为 AST 静态校验 +
  显式 profile；不做 timeout / 内存看门狗——那属于宿主进程的职责）。
"""

from __future__ import annotations

import ast
import builtins as _builtins
import types
from dataclasses import dataclass
from typing import Any, Iterable

# ───────────── 策略的两套口径 ─────────────

#: 策略文件：一个 import 都不允许（照 TS 硬规则「copy any helper into the file」）。
PROFILE_STRATEGY = "strategy"
#: 指标 / 研究脚本：只允许 ALLOWED_MODULES 里的模块。
PROFILE_SCRIPT = "script"

PROFILES = (PROFILE_STRATEGY, PROFILE_SCRIPT)

#: 白名单模块（标准库 only，用户机上零第三方依赖）。root 名即可，子模块随之放行。
ALLOWED_MODULES = frozenset({"math", "statistics", "decimal", "collections"})

#: 明确禁用、且要给出专用错误信息的模块 root（其余未在白名单里的模块一律同样拒绝）。
FORBIDDEN_MODULES = frozenset(
    {
        "os",
        "sys",
        "subprocess",
        "socket",
        "shutil",
        "pathlib",
        "importlib",
        "builtins",
        "ctypes",
        "pickle",
        "marshal",
        "multiprocessing",
        "threading",
        "asyncio",
        "http",
        "urllib",
        "ftplib",
        "smtplib",
        "tempfile",
        "io",
        "glob",
        "mmap",
        "signal",
        "resource",
        "gc",
        "inspect",
        "types",
        "code",
        "codeop",
        "runpy",
        "pty",
        "platform",
        "webbrowser",
        "random",
        "time",
        "datetime",
        "hashlib",
        "base64",
        "numpy",
        "pandas",
    }
)

#: 不许出现在策略代码里的名字（内置能力或逃逸入口）。照 ai-generation.ts 的 no-io 清单 + QD 的 builtins 白名单补集。
FORBIDDEN_NAMES = frozenset(
    {
        "open",
        "eval",
        "exec",
        "compile",
        "__import__",
        "input",
        "breakpoint",
        "globals",
        "locals",
        "vars",
        "getattr",
        "setattr",
        "delattr",
        "type",
        "object",
        "super",
        "dir",
        "id",
        "exit",
        "quit",
        "help",
        "__builtins__",
        "__loader__",
        "__spec__",
    }
)

#: dunder 属性后缀拦截（QD safe_exec.py:84-93 的名单，去重后按后缀匹配）。
FORBIDDEN_ATTR_SUFFIXES = (
    "__builtins__",
    "__import__",
    "__class__",
    "__bases__",
    "__subclasses__",
    "__mro__",
    "__globals__",
    "__code__",
    "__closure__",
    "__dict__",
    "__getattribute__",
    "__setattr__",
    "__delattr__",
    "__reduce__",
    "__getstate__",
    "__setstate__",
    "__loader__",
    "__spec__",
    "__file__",
    "__cached__",
    "__package__",
    "__path__",
    "__traceback__",
    "__defaults__",
    "__kwdefaults__",
)

#: 帧 / 代码 / 闭包访问器：不是 dunder，但能沿帧链拿到真 builtins / globals，逃出沙箱。
#: 照 QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/utils/safe_exec.py:167-175; adapted.
FORBIDDEN_FRAME_ATTRS = frozenset(
    {
        "gi_frame", "gi_code", "gi_yieldfrom",
        "cr_frame", "cr_code", "cr_await",
        "ag_frame", "ag_code", "ag_await",
        "f_globals", "f_locals", "f_back", "f_builtins", "f_code", "f_trace", "f_lasti", "f_lineno",
        "tb_frame", "tb_next", "tb_lasti", "tb_lineno",
        "func_globals", "func_code", "func_closure", "func_dict",
    }
)

#: 隐式属性遍历的方法名：格式字段（"{0.attr}"）会在运行时做 getattr，绕过源码层 dunder 检查。
#: 照 QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/utils/safe_exec.py:101-104; adapted.
FORBIDDEN_METHOD_NAMES = frozenset({"format", "format_map"})

#: 单个策略文件的源码上限（与 loader.ts 的 MAX_SOURCE_BYTES 一致）。
MAX_SOURCE_BYTES = 512 * 1024
#: AST 节点上限：挡住粘贴进来的巨型文件与生成的死循环表格，不限制正常策略（示例最大 ~400 节点）。
MAX_NODES = 20000

#: 原生 builtins 里允许保留的纯计算名字（QD _BUILTINS_WHITELIST 的交集；不含 chr / format / getattr / type）。
SAFE_BUILTIN_NAMES = frozenset(
    {
        "bool", "int", "float", "complex", "str", "bytes", "bytearray",
        "list", "tuple", "dict", "set", "frozenset", "range", "slice",
        "abs", "round", "pow", "divmod", "min", "max", "sum",
        "len", "enumerate", "zip", "map", "filter", "sorted", "reversed",
        "iter", "next", "all", "any",
        "repr", "ascii", "ord", "bin", "hex", "oct", "hash",
        "isinstance", "issubclass", "hasattr", "callable",
        # 没有 print：策略经 stdout 写文本会污染 GEP 的 NDJSON 协议流；调试用 overlays / reasons。
        "Exception", "ValueError", "TypeError", "KeyError", "IndexError",
        "AttributeError", "ZeroDivisionError", "StopIteration",
        "RuntimeError", "OverflowError", "ArithmeticError",
        "NotImplementedError", "NameError", "ImportError",
    }
)

#: 沙箱里**不存在**、但策略作者最常用到的名字。它们原本要等运行期抛 NameError（"内部错误"的样子），
#: 现在 AST 层就点名，规则名 ``unsupported-builtin``（审计 L4-05）。仍未放行：class 不构成逃逸，
#: 但策略是 (candles, params) 的纯函数，状态放 evaluate() 里即可，无需 class / 描述符。
UNSUPPORTED_BUILTIN_NAMES = frozenset(
    {
        "__build_class__", "staticmethod", "classmethod", "property",
        "chr", "format", "memoryview",
    }
)

#: 模块代理上不许读的属性（QD _BLOCKED_MODULE_ATTRS）。
_BLOCKED_MODULE_ATTRS = frozenset(
    {
        "__loader__", "__spec__", "__builtins__", "__dict__", "__class__",
        "__getattribute__", "__file__", "__cached__", "__package__",
    }
)
_SAFE_MODULE_DUNDERS = frozenset({"__name__", "__doc__", "__all__"})


# ───────────── 结果类型 ─────────────


@dataclass(frozen=True)
class SandboxIssue:
    """一条静态校验问题。rule 是机器可读的规则名，message 是给人看的一句话。"""

    rule: str
    message: str
    line: int | None = None

    def __str__(self) -> str:  # pragma: no cover - 只为便于调试输出
        where = f" (line {self.line})" if self.line is not None else ""
        return f"{self.rule}: {self.message}{where}"

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"rule": self.rule, "message": self.message}
        if self.line is not None:
            out["line"] = self.line
        return out


class SandboxError(Exception):
    """静态校验未通过。issues 里每一项都写明规则与行号。"""

    def __init__(self, issues: Iterable[SandboxIssue]):
        self.issues = list(issues)
        detail = "; ".join(str(i) for i in self.issues) or "sandbox rejected the source"
        super().__init__(detail)


# ───────────── 静态校验 ─────────────


def _module_root(name: str) -> str:
    return str(name or "").split(".")[0]


def _line_of(node: ast.AST) -> int | None:
    return getattr(node, "lineno", None)


def check_source(source: Any, *, profile: str = PROFILE_STRATEGY) -> list[SandboxIssue]:
    """静态校验一段策略 / 脚本源码。不执行、不联网、不落地。

    profile = PROFILE_STRATEGY：任何 import 都报 no-import（策略文件自包含）；
    profile = PROFILE_SCRIPT：只放行 ALLOWED_MODULES。两种 profile 都禁 os / sys /
    subprocess / socket / open / eval / exec / __import__ 与 dunder 逃逸。
    """
    issues: list[SandboxIssue] = []
    if profile not in PROFILES:
        raise ValueError(f"unknown sandbox profile {profile!r}; expected one of {PROFILES}")
    if not isinstance(source, str):
        return [SandboxIssue("source", "source must be a string")]
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return [SandboxIssue("size", f"source is larger than {MAX_SOURCE_BYTES} bytes")]

    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [SandboxIssue("syntax", f"could not parse the source: {exc.msg}", exc.lineno)]

    nodes = list(ast.walk(tree))
    if len(nodes) > MAX_NODES:
        issues.append(
            SandboxIssue("complexity", f"the file has {len(nodes)} syntax nodes; the limit is {MAX_NODES}")
        )

    def add(issue: "SandboxIssue | None") -> None:
        if issue is not None:
            issues.append(issue)

    for node in nodes:
        if isinstance(node, ast.Import):
            for alias in node.names:
                add(_import_issue(alias.name, profile, _line_of(node), star=False))
        elif isinstance(node, ast.ImportFrom):
            root = _module_root(node.module or "")
            star = any(alias.name == "*" for alias in node.names)
            if node.level:
                issues.append(
                    SandboxIssue("no-import", "relative imports are not allowed: copy the helper into the file", _line_of(node))
                )
            else:
                add(_import_issue(root, profile, _line_of(node), star=star))
        elif isinstance(node, ast.ClassDef):
            # class 在沙箱里必失败（受限 builtins 没有 __build_class__）。以前是运行期
            # NameError，看不出是规则；现在静态点名（审计 L4-05）。
            issues.append(
                SandboxIssue(
                    "class",
                    f"`class {node.name}` 不可用：策略是 (candles, params) 的纯函数，把状态放进 evaluate()",
                    _line_of(node),
                )
            )
        elif isinstance(node, ast.Name):
            if node.id in FORBIDDEN_NAMES or node.id in FORBIDDEN_FRAME_ATTRS:
                issues.append(
                    SandboxIssue(
                        "forbidden-name",
                        f"`{node.id}` is not available in the sandbox: a strategy is a pure function of (candles, params)",
                        _line_of(node),
                    )
                )
            elif node.id in UNSUPPORTED_BUILTIN_NAMES:
                issues.append(
                    SandboxIssue(
                        "unsupported-builtin",
                        f"`{node.id}` 不在沙箱 builtins 里：策略是 (candles, params) 的纯函数，用不到它",
                        _line_of(node),
                    )
                )
        elif isinstance(node, ast.Attribute):
            attr = node.attr
            if (attr in FORBIDDEN_NAMES or attr in _BLOCKED_MODULE_ATTRS
                    or attr in FORBIDDEN_FRAME_ATTRS or attr in FORBIDDEN_METHOD_NAMES):
                issues.append(
                    SandboxIssue("forbidden-attr", f"attribute `{attr}` is not available in the sandbox", _line_of(node))
                )
            elif attr.startswith("__") and attr.endswith("__"):
                # 任何 dunder 属性都是逃逸入口（__class__ / __subclasses__ / __globals__ …），策略用不到。
                issues.append(
                    SandboxIssue("dunder", f"attribute `{attr}` is not available in the sandbox", _line_of(node))
                )
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            hit = next((name for name in FORBIDDEN_ATTR_SUFFIXES if name in node.value), None)
            if hit is not None:
                issues.append(
                    SandboxIssue(
                        "dunder-string",
                        "string literal names a sandbox-escape attribute (%s)" % hit,
                        _line_of(node),
                    )
                )
        elif isinstance(node, ast.Global) or isinstance(node, ast.Nonlocal):
            issues.append(
                SandboxIssue("scope", "`global` / `nonlocal` are not allowed: keep the state inside evaluate()", _line_of(node))
            )
    return issues


def _import_issue(name: str, profile: str, line: int | None, *, star: bool) -> SandboxIssue | None:
    """生成本条 import 的问题；白名单内的正常 import 返回 None（调用方跳过）。"""
    root = _module_root(name)
    if profile == PROFILE_STRATEGY:
        return SandboxIssue(
            "no-import",
            f"strategy files import nothing (`{name}`); copy the helper into the file "
            "(the sandbox allows math/statistics/decimal/collections for indicator scripts only)",
            line,
        )
    if root not in ALLOWED_MODULES:
        what = "forbidden module" if root in FORBIDDEN_MODULES else "module outside the allow-list"
        return SandboxIssue(
            "forbidden-module",
            f"{what} `{name}`: allowed roots are {', '.join(sorted(ALLOWED_MODULES))}",
            line,
        )
    if star:
        return SandboxIssue("star-import", f"`from {name} import *` is not allowed; import the names you use", line)
    return None


# ───────────── 运行期限制 ─────────────


class SafeModuleProxy(types.ModuleType):
    """白名单模块的只读视图：隐藏 loader / spec / 子模块逃逸属性。照 QD _SafeModuleProxy（safe_exec.py:143-163）。"""

    def __getattribute__(self, name: str) -> Any:
        if name in _BLOCKED_MODULE_ATTRS or (
            name.startswith("__") and name.endswith("__") and name not in _SAFE_MODULE_DUNDERS
        ):
            raise AttributeError(f"module attribute is not available: {name}")
        value = super().__getattribute__(name)
        if isinstance(value, types.ModuleType):
            if _module_root(getattr(value, "__name__", "")) not in ALLOWED_MODULES:
                raise AttributeError(f"module attribute is not available: {name}")
            return _wrap_module(value)
        return value


def _wrap_module(module: Any) -> Any:
    if not isinstance(module, types.ModuleType) or isinstance(module, SafeModuleProxy):
        return module
    proxy = SafeModuleProxy(getattr(module, "__name__", "safe_module"))
    for name, value in module.__dict__.items():
        if name in _BLOCKED_MODULE_ATTRS:
            continue
        if name.startswith("__") and name.endswith("__") and name not in _SAFE_MODULE_DUNDERS:
            continue
        setattr(proxy, name, value)
    return proxy


def safe_import(name: str, globals: Any = None, locals: Any = None, fromlist: Any = (), level: int = 0) -> Any:
    """受限 __import__：只放行 ALLOWED_MODULES 的 root，其余抛 ImportError。"""
    if level:
        raise ImportError("relative imports are not allowed in the sandbox")
    root = _module_root(name)
    if root not in ALLOWED_MODULES:
        raise ImportError(f"Import not allowed: {name}")
    return _wrap_module(_builtins.__import__(name, globals, locals, fromlist, level))


def build_safe_builtins() -> dict[str, Any]:
    """受限 builtins dict：纯计算名字 + 受限 __import__；没有 open / eval / exec / compile / getattr / type。"""
    safe: dict[str, Any] = {}
    for name in sorted(SAFE_BUILTIN_NAMES):
        value = getattr(_builtins, name, None)
        if value is not None:
            safe[name] = value
    safe["__import__"] = safe_import
    safe["True"] = True
    safe["False"] = False
    safe["None"] = None
    return safe


def run(
    source: str,
    *,
    profile: str = PROFILE_STRATEGY,
    filename: str = "<strategy>",
    extra_globals: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """静态校验后在一个受限命名空间里执行源码，返回该命名空间。校验不过抛 SandboxError。"""
    issues = check_source(source, profile=profile)
    if issues:
        raise SandboxError(issues)
    namespace: dict[str, Any] = {"__name__": "gitrader_sandbox", "__doc__": None, "__builtins__": build_safe_builtins()}
    if extra_globals:
        for key, value in extra_globals.items():
            if key == "__builtins__":
                continue
            namespace[key] = value
    code = compile(source, filename, "exec", dont_inherit=True)
    exec(code, namespace, namespace)  # noqa: S102 - 这就是沙箱入口；清单已在上面校验
    return namespace
