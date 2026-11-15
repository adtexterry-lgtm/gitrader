# SPDX-License-Identifier: CPAL-1.0
"""回测撮合与逐根推进（Python 版），语义逐条对齐 TS 模拟器。

对齐对象：``packages/engine-core/src/strategy/simulator.ts``（成交模型 next-bar-open、吃单费率、
不利滑点、资金费点、强平、单根成交量上限、保护规则、手数归一）与
``packages/engine-core/src/strategy/backtest.ts``（``resolveSimOptions`` 的缺省值、
``simulateSeries`` 的逐根信号门控 ``i > 0 && i - 1 >= series.warmup``），
字段口径见 ``reports/backtest-r1/BLUEPRINT.md`` §三。

约定（与 TS 完全一致，改动即破坏跨引擎一致性）：

* 信号出在第 i 根收盘，第 i+1 根**开盘价**成交；买卖各吃一次不利滑点
  ``px·(1 ± slippageBps/1e4)``，手续费 = 名义 · ``feeRate``（taker）。
* 现金只含已实现盈亏与手续费；权益 = 现金 + 持仓浮盈（按收盘 ``c`` 估值）。
* 每根 K 线的处理顺序：① 成交上一根的目标仓位；② 成交量上限；③ 强平；④ 资金费；⑤ 记权益点。
  保护规则先于策略：本根触发保护就平掉全部仓位，并忽略本根的目标仓位。
* 仓位大小 = 目标 × 成交时的权益 × 杠杆 / 含滑点的成交价，成交后不持续再平衡。
* 统计里的数值一律按 ``Number(x.toFixed(d))`` 的口径取整（一半远离 0，见 ``_round_to``）。

本模块只用标准库。没有下单路径：这里不产生任何对外副作用。
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP, localcontext
from typing import Any, Mapping, Sequence

try:  # 正常路径：engine 是命名空间包
    from . import strategy_api as sa
except ImportError:  # pragma: no cover - 被按文件路径单独加载时（没有包上下文）
    import strategy_api as sa

DAY_MS = 86_400_000
EPS = 1e-12
# JS 的 Number.EPSILON（= 2**-52），手数归一吸附容差用
JS_EPSILON = sys.float_info.epsilon

DEFAULT_INITIAL_CASH = 10_000.0
DEFAULT_LEVERAGE = 1.0
DEFAULT_FEE_RATE = 0.00045
DEFAULT_SLIPPAGE_BPS = 2.0

CANDLE_FIELDS = ("t", "o", "h", "l", "c", "v")


# ───────────── 数值口径 ─────────────


def _sign(x: float) -> float:
    """JS ``Math.sign``：0 → 0，其余 ±1。"""
    if x > 0:
        return 1
    if x < 0:
        return -1
    return 0


def _finite(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x))


def _round_to(x: float, digits: int) -> float:
    """``Number(x.toFixed(digits))`` 的等值实现（按二进制真值取整，一半远离 0）。

    统计里用的是这个口径，所以不能用 Python 的 ``round``（银行家舍入）。
    ``|x| >= 1e15`` 时 double 已没有小数位可舍（JS 的 toFixed 在这种量级返回指数形式），原值返回。
    """
    if not isinstance(x, float) or not math.isfinite(x):
        return float(x)
    if abs(x) >= 1e15:
        return x
    with localcontext() as ctx:
        ctx.prec = 120
        quantum = Decimal(1).scaleb(-digits)
        return float(Decimal(x).quantize(quantum, rounding=ROUND_HALF_UP))


def _precision15(x: float) -> float:
    """``Number(x.toPrecision(15))``：取 15 位有效数字后再还原成 double。"""
    return float("%.15g" % x)


def normalize_lot(qty: float, step: float, min_qty: float | None = None) -> float:
    """把数量按 step 向零取整到 step 的整数倍（``decimal.ts:29-47`` 的原样移植）。

    若 |qty| 与最近整数倍的差 ≤ 4 ulp 就吸附到该整数倍，免得 0.30000000000000004 这类
    二进制噪声把整手数量截掉一手；step ≤ 0 或非有限 → 原值；结果 < min_qty（给了的话）→ 0。

    Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/runtime.py:1233;
    via packages/engine-core/src/util/decimal.ts:29-47; adapted.
    """
    if not _finite(qty) or not _finite(step) or float(step) <= 0:
        return float(qty)
    qty = float(qty)
    step = float(step)
    ratio = abs(qty) / step
    nearest = float(math.floor(ratio + 0.5))
    tol = JS_EPSILON * abs(qty) * 4
    units = nearest if abs(abs(qty) - nearest * step) <= tol else float(math.floor(ratio))
    raw = units * step
    cleaned = _precision15(raw)
    magnitude = cleaned if abs(cleaned - raw) <= JS_EPSILON * abs(raw) * 4 else raw
    if magnitude == 0:
        return 0.0
    value = -magnitude if qty < 0 else magnitude
    if min_qty is not None and value < float(min_qty):
        return 0.0
    return value


# ───────────── 期权参数 ─────────────


@dataclass
class SimOptions:
    """``simulator.ts:15-37`` 的 ``SimOptions``（Python 版，字段名 snake_case）。"""

    initial_cash: float = DEFAULT_INITIAL_CASH
    leverage: float = DEFAULT_LEVERAGE
    fee_rate: float = DEFAULT_FEE_RATE
    slippage_bps: float = DEFAULT_SLIPPAGE_BPS
    # 资金费点（按 t 升序）；rate 为分数：多头在 rate > 0 时付钱
    funding: list[dict[str, float]] | None = None
    liquidation: bool = False
    maintenance_margin_ratio: float | None = None
    max_volume_share: float | None = None
    liquidation_penalty_ratio: float | None = None
    protection: dict[str, Any] | None = None
    lot_step: float | None = None
    min_lot: float | None = None

    def to_dict(self) -> dict[str, Any]:
        """回写用了哪些假设（缺省项如实写 false / None）。"""
        return {
            "initialCash": self.initial_cash,
            "leverage": self.leverage,
            "feeRate": self.fee_rate,
            "slippageBps": self.slippage_bps,
            "funding": bool(self.funding),
            "liquidation": bool(self.liquidation),
            "maintenanceMarginRatio": self.maintenance_margin_ratio,
            "maxVolumeShare": self.max_volume_share,
            "liquidationPenaltyRatio": self.liquidation_penalty_ratio,
            "protection": self.protection,
            "lotStep": self.lot_step,
            "minLot": self.min_lot,
        }


_OPTION_ALIASES = {
    "initial_cash": ("initial_cash", "initialCash", "initialBalance"),
    "leverage": ("leverage",),
    "fee_rate": ("fee_rate", "feeRate"),
    "slippage_bps": ("slippage_bps", "slippageBps"),
    "funding": ("funding",),
    "liquidation": ("liquidation",),
    "maintenance_margin_ratio": ("maintenance_margin_ratio", "maintenanceMarginRatio"),
    "max_volume_share": ("max_volume_share", "maxVolumeShare"),
    "liquidation_penalty_ratio": ("liquidation_penalty_ratio", "liquidationPenaltyRatio"),
    "protection": ("protection",),
    "lot_step": ("lot_step", "lotStep"),
    "min_lot": ("min_lot", "minLot"),
}


def sim_options_from(raw: Mapping[str, Any] | None = None) -> SimOptions:
    """宽松输入（camelCase / snake_case / 十进制字符串）→ SimOptions。未知键忽略。"""
    out = SimOptions()
    for name, keys in _OPTION_ALIASES.items():
        value = None
        for key in keys:
            if raw is not None and raw.get(key) is not None:
                value = raw[key]
                break
        if value is None:
            continue
        if name == "funding":
            if isinstance(value, bool):
                continue
            points = []
            for point in value or []:
                if isinstance(point, Mapping):
                    t, rate = point.get("t"), point.get("rate")
                else:
                    t, rate = point
                if _finite(t) and _finite(rate):
                    points.append({"t": float(t), "rate": float(rate)})
            points.sort(key=lambda p: p["t"])
            out.funding = points
        elif name in ("liquidation",):
            out.liquidation = bool(value)
        elif name == "protection":
            out.protection = normalize_protection(value) if isinstance(value, Mapping) else None
        else:
            if not _finite(value):
                raise ValueError("%s must be a finite number" % name)
            setattr(out, name, float(value))
    return out


def resolve_sim_options(opts: SimOptions | Mapping[str, Any] | None = None) -> SimOptions:
    """``backtest.ts:29-48`` 的 ``resolveSimOptions``：只在给了的时候透传可选假设。

    与 TS 的差异（有意补齐，不影响缺省行为）：TS 的 ``resolveSimOptions`` 漏传了
    ``protection`` / ``lotStep`` / ``minLot``（``runBacktest`` 因此用不上保护规则与手数归一），
    这里原样透传；缺省值是三处都一样的 10 000 / 1 / 0.00045 / 2 bps。
    """
    if isinstance(opts, SimOptions):
        raw = {name: getattr(opts, name) for name in _OPTION_ALIASES}
    else:
        raw = dict(opts or {})
    out = SimOptions()
    initial = raw.get("initial_cash", raw.get("initialCash"))
    out.initial_cash = float(initial) if _finite(initial) and float(initial) > 0 else DEFAULT_INITIAL_CASH
    leverage = raw.get("leverage")
    out.leverage = float(leverage) if _finite(leverage) and float(leverage) > 0 else DEFAULT_LEVERAGE
    fee = raw.get("fee_rate", raw.get("feeRate"))
    out.fee_rate = float(fee) if _finite(fee) and float(fee) >= 0 else DEFAULT_FEE_RATE
    slip = raw.get("slippage_bps", raw.get("slippageBps"))
    out.slippage_bps = float(slip) if _finite(slip) and float(slip) >= 0 else DEFAULT_SLIPPAGE_BPS

    funding = raw.get("funding")
    if isinstance(funding, (list, tuple)):
        points = []
        for point in funding:
            t = point.get("t") if isinstance(point, Mapping) else point[0]
            rate = point.get("rate") if isinstance(point, Mapping) else point[1]
            if _finite(t) and _finite(rate):
                points.append({"t": float(t), "rate": float(rate)})
        points.sort(key=lambda p: p["t"])
        out.funding = points

    for name in ("liquidation", "maintenance_margin_ratio", "max_volume_share", "liquidation_penalty_ratio",
                 "protection", "lot_step", "min_lot"):
        camel = {"maintenance_margin_ratio": "maintenanceMarginRatio",
                 "max_volume_share": "maxVolumeShare",
                 "liquidation_penalty_ratio": "liquidationPenaltyRatio",
                 "lot_step": "lotStep", "min_lot": "minLot"}.get(name, name)
        value = raw.get(name, raw.get(camel))
        if value is None:
            continue
        if name == "liquidation":
            out.liquidation = bool(value)
        elif name == "protection":
            out.protection = value if isinstance(value, Mapping) else None
        else:
            if not _finite(value):
                raise ValueError("%s must be a finite number" % name)
            setattr(out, name, float(value))
    return out


def infer_interval_ms(candles: Sequence[Mapping[str, float]]) -> int:
    """``simulator.ts:64-70``：前 50 根相邻间隔的中位数；不足两根或为 0 → 1 小时。"""
    if len(candles) < 2:
        return 3_600_000
    gaps = []
    for i in range(1, min(len(candles), 50)):
        gaps.append(candles[i]["t"] - candles[i - 1]["t"])
    gaps.sort()
    median = gaps[len(gaps) // 2]
    return int(median) if median else 3_600_000


# ───────────── 保护规则（protection.ts 的 Python 版）─────────────

EXIT_PRIORITY = {"stop_loss": 0, "trailing_stop": 1, "time_limit": 2, "take_profit": 3}


def _pick(raw: Mapping[str, Any], keys: Sequence[str]) -> Any:
    """空值（未提供）与 0 区分开：None / 空串都算未提供，0 是有效值。"""
    for key in keys:
        if key not in raw:
            continue
        value = raw[key]
        if value is None:
            continue
        if isinstance(value, str) and value.strip() == "":
            continue
        return value
    return None


def _ratio(value: Any, field_name: str, maximum: float) -> float:
    """百分数与小数统一成小数比例（≥ 1 按百分数，带 % 后缀按百分数）。"""
    explicit_percent = False
    number = math.nan
    if isinstance(value, bool):
        number = math.nan
    elif isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        text = value.strip()
        if text.endswith("%"):
            explicit_percent = True
            try:
                number = float(text[:-1])
            except ValueError:
                number = math.nan
        else:
            try:
                number = float(text)
            except ValueError:
                number = math.nan
    if not math.isfinite(number):
        raise ValueError("%s: not a finite number" % field_name)
    out = number / 100 if (explicit_percent or abs(number) >= 1) else number
    if out < 0 or out > maximum:
        raise ValueError("%s: out of range [0, %s]" % (field_name, maximum))
    return out


def _integer(value: Any, field_name: str) -> int:
    try:
        number = float(value) if not isinstance(value, bool) else math.nan
    except (TypeError, ValueError):
        number = math.nan
    if not math.isfinite(number):
        raise ValueError("%s: not a finite number" % field_name)
    if number < 0:
        raise ValueError("%s: must be >= 0" % field_name)
    return int(math.floor(number))


def normalize_protection(raw: Mapping[str, Any]) -> dict[str, Any]:
    """宽松输入 → ProtectionConfig（``protection.ts:73-104``）。

    Ported from QuantDinger v5.6.5 (Apache-2.0): backend_api_python/app/services/strategy_v2/protection.py:49;
    via packages/engine-core/src/strategy/protection.ts:73-104; adapted.
    """
    cfg: dict[str, Any] = {}
    stop_loss = _pick(raw, ("stopLossPct", "stop_loss_pct"))
    if stop_loss is not None:
        cfg["stopLossPct"] = _ratio(stop_loss, "stopLossPct", 1)
    take_profit = _pick(raw, ("takeProfitPct", "take_profit_pct"))
    if take_profit is not None:
        cfg["takeProfitPct"] = _ratio(take_profit, "takeProfitPct", 5)
    max_hold = _pick(raw, ("maxHoldBars", "max_hold_bars"))
    if max_hold is not None:
        cfg["maxHoldBars"] = _integer(max_hold, "maxHoldBars")
    nested = raw.get("trailing")
    trailing_raw = dict(nested) if isinstance(nested, Mapping) else None
    activation = _pick(raw, ("trailingActivationPct", "trailing_activation_pct"))
    if activation is None and trailing_raw is not None:
        activation = _pick(trailing_raw, ("activationPct", "activation_pct", "activation"))
    trail = _pick(raw, ("trailingTrailPct", "trailing_trail_pct", "trailingStopPct", "trailing_stop_pct"))
    if trail is None and trailing_raw is not None:
        trail = _pick(trailing_raw, ("trailPct", "trail_pct", "pct", "stopPct", "stop_pct"))
    if trail is not None:
        activation_pct = _ratio(activation, "trailingActivationPct", 5) if activation is not None else 0.0
        cfg["trailing"] = {"activationPct": activation_pct, "trailPct": _ratio(trail, "trailingTrailPct", 1)}
    elif activation is not None:
        raise ValueError("trailingTrailPct: trailing activation requires a trail distance")
    return cfg


def open_protection(side: str, entry_price: float, entry_bar: int) -> dict[str, Any]:
    """开仓即建立保护状态：最高 / 最低都从入场价起算，移动止损未激活（``protection.ts:108-117``）。"""
    return {
        "side": side,
        "entryPrice": entry_price,
        "entryBar": entry_bar,
        "highestSinceEntry": entry_price,
        "lowestSinceEntry": entry_price,
        "trailingArmed": False,
    }


def _arm_trailing(state: dict[str, Any], cfg: Mapping[str, Any]) -> None:
    trailing = cfg.get("trailing")
    if not trailing or trailing.get("trailPct", 0) <= 0 or state["trailingArmed"]:
        return
    if state["side"] == "long":
        if state["highestSinceEntry"] >= state["entryPrice"] * (1 + trailing["activationPct"]):
            state["trailingArmed"] = True
        return
    if state["lowestSinceEntry"] <= state["entryPrice"] * (1 - trailing["activationPct"]):
        state["trailingArmed"] = True


def _trailing_trigger(state: Mapping[str, Any], cfg: Mapping[str, Any]) -> float | None:
    trailing = cfg.get("trailing")
    if not trailing or trailing.get("trailPct", 0) <= 0 or not state["trailingArmed"]:
        return None
    if state["side"] == "long":
        return state["highestSinceEntry"] * (1 - trailing["trailPct"])
    return state["lowestSinceEntry"] * (1 + trailing["trailPct"])


def evaluate_protection(
    state: Mapping[str, Any], bar: Mapping[str, float], cfg: Mapping[str, Any]
) -> dict[str, Any]:
    """用一根 K 线检查保护条件（``protection.ts:170-224``）。

    返回 ``{"exit": {"reason", "price"} | None, "state": 新状态}``；同一根触发多个条件时
    按 stop_loss → trailing_stop → time_limit → take_profit 取一个。
    """
    nxt = dict(state)
    open_ = bar["o"]
    high = max(open_, bar["h"])
    low = min(open_, bar["l"])
    is_long = nxt["side"] == "long"
    candidates: list[dict[str, Any]] = []

    stop_loss_pct = cfg.get("stopLossPct")
    if stop_loss_pct is not None and stop_loss_pct > 0:
        trigger = nxt["entryPrice"] * (1 - stop_loss_pct if is_long else 1 + stop_loss_pct)
        touched = low <= trigger if is_long else high >= trigger
        if touched:
            gapped = open_ <= trigger if is_long else open_ >= trigger
            candidates.append({"reason": "stop_loss", "price": open_ if gapped else trigger})

    _arm_trailing(nxt, cfg)
    trail = _trailing_trigger(nxt, cfg)
    if trail is not None:
        touched = low <= trail if is_long else high >= trail
        if touched:
            gapped = open_ <= trail if is_long else open_ >= trail
            candidates.append({"reason": "trailing_stop", "price": open_ if gapped else trail})

    take_profit_pct = cfg.get("takeProfitPct")
    if take_profit_pct is not None and take_profit_pct > 0:
        trigger = nxt["entryPrice"] * (1 + take_profit_pct if is_long else 1 - take_profit_pct)
        touched = high >= trigger if is_long else low <= trigger
        if touched:
            gapped = open_ >= trigger if is_long else open_ <= trigger
            candidates.append({"reason": "take_profit", "price": open_ if gapped else trigger})

    max_hold = cfg.get("maxHoldBars")
    if max_hold is not None and max_hold > 0 and bar["index"] - nxt["entryBar"] >= max_hold:
        candidates.append({"reason": "time_limit", "price": bar["c"]})

    exit_ = None
    for candidate in candidates:
        if exit_ is None or EXIT_PRIORITY[candidate["reason"]] < EXIT_PRIORITY[exit_["reason"]]:
            exit_ = candidate
    if exit_ is not None:
        return {"exit": exit_, "state": nxt}

    nxt["highestSinceEntry"] = max(nxt["highestSinceEntry"], high)
    nxt["lowestSinceEntry"] = min(nxt["lowestSinceEntry"], low)
    _arm_trailing(nxt, cfg)
    return {"exit": None, "state": nxt}


# ───────────── 模拟器 ─────────────


@dataclass
class Simulator:
    """``simulator.ts:72-314`` 的 Python 版：逐根推进、逐笔记账、最后出统计。

    记账字段都可读（``trades`` / ``equity`` / ``funding`` / ``cash`` / ``pos`` / ``fees_paid`` …），
    测试与回放直接用它们对账。
    """

    opts: SimOptions
    cash: float = 0.0
    pos: float = 0.0
    entry: float = 0.0
    applied: float = 0.0
    trades: list[dict[str, Any]] = field(default_factory=list)
    equity: list[dict[str, float]] = field(default_factory=list)
    funding: list[dict[str, float]] = field(default_factory=list)
    funding_paid: float = 0.0
    fees_paid: float = 0.0
    liquidations: int = 0
    unfilled_notional: float = 0.0
    wanted_notional: float = 0.0
    bankrupt: bool = False
    protection_exits: int = 0
    prot: dict[str, Any] | None = None
    # stats() 把收益年化时溢出了（窗口短于一天）：引擎据此写 warning，值报 0
    annualized_unavailable: bool = False

    def __post_init__(self) -> None:
        if isinstance(self.opts, Mapping):  # 允许直接喂 dict
            self.opts = resolve_sim_options(self.opts)
        self.cash = float(self.opts.initial_cash)
        self.slip = float(self.opts.slippage_bps) / 1e4
        self.mmr = (float(self.opts.maintenance_margin_ratio)
                    if self.opts.maintenance_margin_ratio is not None
                    else (0.5 / float(self.opts.leverage) if self.opts.leverage else math.inf))
        self.trips: list[dict[str, float]] = []
        self.trip: dict[str, float] | None = None
        self.funding_idx = 0
        self.last_bar_t: float | None = None

    @property
    def protection_state(self) -> dict[str, Any] | None:
        return self.prot

    # ---- 成交 ----

    def fill(self, bar: int, t: float, delta: float, raw_px: float, reason: str) -> bool:
        """成交一笔；返回是否真的成交（手数归一后为 0 时不计成交，只记未成交名义）。"""
        pos = self.pos
        entry = self.entry
        signed = float(delta)
        lot_step = self.opts.lot_step
        if lot_step is not None:
            lot = abs(normalize_lot(abs(delta), float(lot_step), self.opts.min_lot))
            if lot == 0:
                self.unfilled_notional += abs(delta) * raw_px
                return False
            signed = _sign(delta) * lot
        side = "buy" if signed > 0 else "sell"
        price = raw_px * (1 + ((1 if signed > 0 else -1) * self.slip))
        size = abs(signed)
        fee = size * price * float(self.opts.fee_rate)
        realized = 0.0
        if abs(pos) > EPS and _sign(pos) != _sign(signed):
            closing = min(size, abs(pos))
            realized = (price - entry) * closing * _sign(pos)
        before = pos
        after = pos + signed
        # 往返统计：开仓 → 回到空仓或反手
        if abs(before) < EPS:
            self.trip = {"pnl": 0.0, "openBar": float(bar)}
        if self.trip is not None:
            self.trip["pnl"] += realized - fee
        if abs(before) > EPS and (abs(after) < EPS or _sign(after) != _sign(before)):
            if self.trip is not None:
                self.trips.append({"pnl": self.trip["pnl"], "bars": bar - self.trip["openBar"]})
            self.trip = None if abs(after) < EPS else {"pnl": 0.0, "openBar": float(bar)}
        # 持仓均价
        if abs(after) < EPS:
            self.pos = 0.0
            self.entry = 0.0
        elif abs(before) < EPS or _sign(before) != _sign(after):
            self.pos = after
            self.entry = price
        elif _sign(before) == _sign(signed):
            self.entry = (abs(before) * entry + size * price) / abs(after)
            self.pos = after
        else:
            self.pos = after
        self.cash += realized - fee
        self.fees_paid += fee
        self.trades.append({
            "t": t, "side": side, "price": price, "size": size,
            "pnl": realized - fee, "fee": fee, "reason": reason,
        })
        return True

    def sync_protection(self, bar: int) -> None:
        """保护状态跟随实际仓位：开仓 / 反手时按新持仓建立，回到空仓时清空。"""
        if self.opts.protection is None:
            return
        if abs(self.pos) <= EPS:
            self.prot = None
            return
        side = "long" if self.pos > 0 else "short"
        if self.prot is not None and self.prot["side"] == side:
            return
        self.prot = open_protection(side, self.entry, bar)

    # ---- 逐根推进 ----

    def on_bar(
        self, bar: int, candle: Mapping[str, float], want: float | None, reason: str = ""
    ) -> dict[str, Any] | None:
        """推进一根 K 线；``want`` 是上一根收盘出的目标仓位（None = 预热期没有信号）。

        返回本根产生的成交（0 或 1 笔），与 ``simulator.ts:164-238`` 同序。
        """
        before_count = len(self.trades)
        t = candle["t"]
        if not self.bankrupt:
            # ① 保护先于策略：本根触发保护就平掉全部仓位，并忽略本根的策略目标
            exited = False
            protection = self.opts.protection
            if protection is not None and self.prot is not None and abs(self.pos) > EPS:
                verdict = evaluate_protection(self.prot, {**candle, "index": bar}, protection)
                self.prot = verdict["state"]
                exit_ = verdict["exit"]
                if exit_ is not None and self.fill(bar, t, -self.pos, exit_["price"],
                                                   "protection:%s" % exit_["reason"]):
                    self.prot = None
                    self.protection_exits += 1
                    self.applied = 0.0
                    exited = True
            # ② 按上根信号在开盘价成交（含成交量上限）
            if not exited and want is not None and abs(want - self.applied) > EPS:
                eq_open = self.cash + self.pos * (candle["o"] - self.entry) * (1 if abs(self.pos) > EPS else 0)
                # 按含滑点的预计成交价定仓位，满仓 1× 时名义恰好等于权益
                size_px = candle["o"] * (1 + _sign(want) * self.slip)
                desired = (want * eq_open * float(self.opts.leverage)) / size_px if eq_open > 0 else 0.0
                delta = desired - self.pos
                if abs(delta) * candle["o"] > 1e-9:
                    share = self.opts.max_volume_share
                    if share is not None:
                        self.wanted_notional += abs(delta) * candle["o"]
                        cap = float(share) * candle["v"]
                        if abs(delta) > cap:
                            self.unfilled_notional += (abs(delta) - cap) * candle["o"]
                            delta = _sign(delta) * cap
                    if abs(delta) > EPS:
                        self.fill(bar, t, delta, candle["o"], reason)
                self.applied = float(want)
                self.sync_protection(bar)
            # ③ 强平：按本根最不利价对维持保证金判定，成交后扣罚金
            if self.opts.liquidation is True and abs(self.pos) > EPS:
                worst = candle["l"] if self.pos > 0 else candle["h"]
                eq_worst = self.cash + self.pos * (worst - self.entry)
                mm = abs(self.pos) * worst * self.mmr
                if eq_worst < mm:
                    self.fill(bar, t, -self.pos, worst, "liquidation")
                    self.cash -= (float(self.opts.liquidation_penalty_ratio)
                                  if self.opts.liquidation_penalty_ratio is not None else 0.0) * mm
                    self.liquidations += 1
                    self.applied = 0.0
                    self.prot = None
                    if self.cash <= 0:
                        self.cash = 0.0
                        self.bankrupt = True
            # ④ 资金费：只结算 (lastBarT, c.t] 内的点；第 0 根只推进指针
            points = self.opts.funding
            if points:
                prev_t = self.last_bar_t
                while self.funding_idx < len(points):
                    f = points[self.funding_idx]
                    if f["t"] > t:
                        break
                    self.funding_idx += 1
                    if prev_t is None or not (prev_t < f["t"]):
                        continue
                    if abs(self.pos) > EPS:
                        paid = self.pos * candle["c"] * f["rate"]
                        self.cash -= paid
                        self.funding_paid += paid
                        self.funding.append({
                            "t": f["t"], "rate": f["rate"],
                            "notional": abs(self.pos) * candle["c"], "paid": paid,
                        })
        # ⑤ 记权益点（用收盘价）
        if self.bankrupt:
            eq = self.cash
        else:
            eq = self.cash + (self.pos * (candle["c"] - self.entry) if abs(self.pos) > EPS else 0.0)
        self.equity.append({"t": t, "v": eq})
        self.last_bar_t = t
        return self.trades[-1] if len(self.trades) > before_count else None

    # ---- 统计 ----

    def open_position(self, last: Mapping[str, float] | None = None) -> dict[str, Any] | None:
        if last is None or abs(self.pos) <= EPS:
            return None
        return {
            "side": "long" if self.pos > 0 else "short",
            "size": abs(self.pos),
            "entryPrice": self.entry,
            "unrealizedPnl": self.pos * (last["c"] - self.entry),
        }

    def stats(self, candles: Sequence[Mapping[str, float]], step_ms: int) -> dict[str, Any]:
        """``simulator.ts:245-313``：收益 / 回撤 / 夏普 / 索提诺 / 胜率 / 盈亏比 + 费用与未成交。"""
        equity = self.equity
        trips = self.trips
        initial = float(self.opts.initial_cash)
        n = len(equity)
        final_equity = equity[-1]["v"] if n > 0 else initial
        span_days = (candles[n - 1]["t"] + step_ms - candles[0]["t"]) / DAY_MS if n > 0 else 0.0
        total_return = final_equity / initial - 1
        years = span_days / 365
        if years > 0 and final_equity > 0:
            try:
                annualized = math.pow(final_equity / initial, 1 / years) - 1
            except OverflowError:
                # 不到一天的窗口把收益年化会溢出（1.5^3700）；TS 那边得到 Infinity，
                # JSON 里只能变成 null。这里如实报 0 并由引擎在 warnings 里说明。
                annualized = 0.0
                non_finite_annualized = True
            else:
                non_finite_annualized = not math.isfinite(annualized)
                if non_finite_annualized:
                    annualized = 0.0
        elif years > 0:
            annualized = -1.0
            non_finite_annualized = False
        else:
            annualized = 0.0
            non_finite_annualized = False
        self.annualized_unavailable = non_finite_annualized

        peak = initial
        max_dd = 0.0
        prev = initial
        total = 0.0
        cnt = 0
        for point in equity:
            peak = max(peak, point["v"])
            if peak > 0:
                max_dd = max(max_dd, (peak - point["v"]) / peak)
            if prev > 0:
                total += point["v"] / prev - 1
                cnt += 1
            prev = point["v"]

        sharpe = 0.0
        sortino = 0.0
        if cnt > 2:
            mean = total / cnt
            var = 0.0
            down = 0.0
            prev = initial
            for point in equity:
                if prev > 0:
                    r = point["v"] / prev - 1
                    var += (r - mean) ** 2
                    if r < 0:
                        down += r * r
                prev = point["v"]
            sd = math.sqrt(var / (cnt - 1))
            ddev = math.sqrt(down / cnt)
            bars_per_year = (365 * DAY_MS) / step_ms
            if sd > 1e-12:
                sharpe = (mean / sd) * math.sqrt(bars_per_year)
            if ddev > 1e-12:
                sortino = (mean / ddev) * math.sqrt(bars_per_year)

        gross_win = 0.0
        gross_loss = 0.0
        wins = 0
        hold_bars = 0.0
        for trip in trips:
            pnl = trip["pnl"]
            if pnl > 0:
                wins += 1
                gross_win += pnl
            elif pnl < 0:
                gross_loss -= pnl
            hold_bars += trip["bars"]

        return {
            "totalReturnRatio": _round_to(total_return, 6),
            "annualizedRatio": _round_to(annualized, 6),
            "maxDrawdownRatio": _round_to(max_dd, 6),
            "sharpe": _round_to(sharpe, 3),
            "sortino": _round_to(sortino, 3),
            "winRatio": _round_to(wins / len(trips), 6) if trips else 0.0,
            "profitFactor": _round_to(gross_win / gross_loss, 3) if gross_loss > 0 else None,
            "trades": len(trips),
            "avgHoldBars": _round_to(hold_bars / len(trips), 2) if trips else 0.0,
            "fills": len(self.trades),
            "spanDays": _round_to(span_days, 3),
            "finalEquity": _round_to(final_equity, 2),
            "fundingPaid": _round_to(self.funding_paid, 6),
            "feesPaid": _round_to(self.fees_paid, 6),
            "liquidations": self.liquidations,
            "protectionExits": self.protection_exits,
            "unfilledShare": (_round_to(self.unfilled_notional / self.wanted_notional, 6)
                              if self.wanted_notional > 0 else 0.0),
        }


# ───────────── 回测入口 ─────────────


def _as_series(series: Any, n: int) -> sa.SignalSeries:
    if isinstance(series, sa.SignalSeries):
        return series
    return sa.SignalSeries.from_any(series, n)


def simulate_series(
    series: Any,
    candles: Sequence[Any],
    opts: SimOptions | Mapping[str, Any] | None = None,
    *,
    interval_ms: int | None = None,
) -> dict[str, Any]:
    """把一条已算好的信号序列按 next-bar-open 撮合（``backtest.ts:51-62``）。

    信号门控与 TS 一致：第 i 根用第 ``i-1`` 根的目标，且要求 ``i-1 >= warmup``；第 0 根永远不下单。
    """
    rows = sa.normalize_candles(candles)
    resolved = resolve_sim_options(opts)
    signals = _as_series(series, len(rows))
    step_ms = interval_ms if interval_ms and interval_ms > 0 else infer_interval_ms(rows)
    sim = Simulator(resolved)
    for i, candle in enumerate(rows):
        has_signal = i > 0 and i - 1 >= int(signals.warmup)
        if has_signal and i - 1 < len(signals.target):
            want: float | None = signals.target[i - 1]
            why = signals.reasons[i - 1] if i - 1 < len(signals.reasons) else ""
        else:
            want = None
            why = ""
        sim.on_bar(i, candle, want, why or "")
    return {
        "stats": sim.stats(rows, step_ms),
        "equity": sim.equity,
        "trades": sim.trades,
        "funding": sim.funding,
        "candlesUsed": len(rows),
        "openPosition": sim.open_position(rows[-1] if rows else None),
        "overlays": signals.overlays,
        "series": signals,
        "simulator": sim,
        "options": resolved,
    }


def run_backtest(
    strategy: Any,
    candles: Sequence[Any],
    params: Mapping[str, Any] | None = None,
    opts: SimOptions | Mapping[str, Any] | None = None,
    *,
    interval_ms: int | None = None,
) -> dict[str, Any]:
    """策略 → 信号序列 → 撮合（``backtest.ts:64-67``）。``strategy`` 是 ``strategy_api.Strategy``。"""
    series = strategy.evaluate_series(candles, params)
    out = simulate_series(series, candles, opts, interval_ms=interval_ms)
    out["params"] = dict(params or {})
    return out


__all__ = [
    "DAY_MS",
    "SimOptions",
    "Simulator",
    "infer_interval_ms",
    "normalize_lot",
    "normalize_protection",
    "open_protection",
    "evaluate_protection",
    "resolve_sim_options",
    "run_backtest",
    "sim_options_from",
    "simulate_series",
]
