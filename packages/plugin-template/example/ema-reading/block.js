// ../blocks-sdk/src/client.ts
var KernelError = class extends Error {
  /** 本地交互取消；未处理的 1010 绝不等同取消。 */
  cancelled = false;
  code;
  /** 契约 §2.8 Problem 名（如 `RULE_DENIED`、`AUTH_FAILED`），没有则 undefined。 */
  problemName;
  /** 内核给的 Problem 原样保留（不改写上游文案）。 */
  problem;
  constructor(code, message, problem) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.problem = problem;
    const n = problem?.name;
    this.problemName = typeof n === "string" ? n : void 0;
  }
};

// ../blocks-sdk/src/bridge.ts
var BridgeError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "BridgeError";
  }
  code;
};

// ../blocks-sdk/src/iframe.ts
var reviveError = (e) => {
  if (e.kind === "bridge") return new BridgeError(e.code, e.message);
  if (e.kind === "kernel") return new KernelError(Number(e.code), e.message, e.problem);
  return new Error(e.message);
};
function createRemoteBridge(port, ids) {
  let nextId = 1;
  let nextSid = 1;
  const pending = /* @__PURE__ */ new Map();
  const handlers = /* @__PURE__ */ new Map();
  const linkCache = {};
  const linkFns = /* @__PURE__ */ new Map();
  let helloP = null;
  port.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.gr !== 1) return;
    if (m.t === "res" && m.id !== void 0) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(reviveError(m.error));
    } else if (m.t === "event" && m.sid !== void 0) {
      const h = handlers.get(m.sid);
      if (h) for (const e of m.events ?? []) {
        try {
          h(e);
        } catch {
        }
      }
    } else if (m.t === "link" && m.group) {
      linkCache[m.group] = m.value;
      for (const fn of linkFns.get(m.group) ?? []) {
        try {
          fn(m.value);
        } catch {
        }
      }
    }
  };
  port.start?.();
  const call = (body) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ gr: 1, t: "req", id, ...body });
  });
  return {
    blockId: ids.blockId,
    instanceId: ids.instanceId,
    hello() {
      helloP ??= call({ op: "hello" }).then(async (h) => {
        Object.assign(linkCache, h.links);
        const groups = Object.keys(h.links);
        if (groups.length) await call({ op: "link.watch", groups });
        return h;
      });
      return helloP;
    },
    subscribe(topic, handler, opts) {
      const sid = nextSid++;
      handlers.set(sid, handler);
      void call({ op: "subscribe", sid, topic, opts }).catch((e) => {
        handlers.delete(sid);
        console.error("[gitrader] \u8BA2\u9605\u88AB\u62D2\uFF1A", e.message);
      });
      return () => {
        handlers.delete(sid);
        void call({ op: "unsubscribe", sid }).catch(() => {
        });
      };
    },
    query: (method, params) => call({ op: "query", method, params }),
    command: (action, params) => call({ op: "command", action, params }),
    link: {
      get: (g) => linkCache[g],
      set(g, value) {
        linkCache[g] = value;
        void call({ op: "link.set", group: g, value }).catch((e) => console.error("[gitrader] \u8054\u52A8\u88AB\u62D2\uFF1A", e.message));
      },
      subscribe(g, fn) {
        let set = linkFns.get(g);
        if (!set) linkFns.set(g, set = /* @__PURE__ */ new Set());
        set.add(fn);
        return () => {
          set.delete(fn);
        };
      }
    }
  };
}
function connectHostBridge(opts = {}) {
  const g = globalThis;
  const target = opts.target ?? g.parent;
  const blockId = opts.blockId ?? g.__GITRADER_BLOCK__?.blockId;
  const instanceId = opts.instanceId ?? g.__GITRADER_BLOCK__?.instanceId;
  if (!blockId || !instanceId) return Promise.reject(new Error("\u7F3A\u5C11 blockId / instanceId\uFF08\u5BBF\u4E3B\u4F1A\u5728 window.__GITRADER_BLOCK__ \u91CC\u7ED9\u51FA\uFF09"));
  if (!target) return Promise.reject(new Error("\u6CA1\u6709\u53EF\u63E1\u624B\u7684\u5BBF\u4E3B\u7A97\u53E3"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      g.removeEventListener("message", onMsg);
      reject(new Error("\u5BBF\u4E3B\u6CA1\u6709\u54CD\u5E94\u5757\u6865\u63E1\u624B"));
    }, opts.timeoutMs ?? 8e3);
    const onMsg = (e) => {
      const ev = e;
      const d = ev.data;
      if (ev.source !== target || !d || d.gr !== "port" || !ev.ports[0]) return;
      clearTimeout(timer);
      g.removeEventListener("message", onMsg);
      resolve(createRemoteBridge(ev.ports[0], { blockId, instanceId }));
    };
    g.addEventListener("message", onMsg);
    target.postMessage({ gr: "ready" }, opts.targetOrigin ?? "*");
  });
}

// src/ema.ts
function ema(closes, period) {
  const s = emaSeries(closes, period);
  return s.length ? s[s.length - 1] ?? null : null;
}
function emaSeries(closes, period) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError("period \u5FC5\u987B\u662F\u6B63\u6574\u6570");
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  let sum = 0;
  closes.forEach((c, i) => {
    if (!Number.isFinite(c)) {
      out.push(prev);
      return;
    }
    if (i < period - 1) {
      sum += c;
      out.push(null);
      return;
    }
    if (i === period - 1) {
      prev = (sum + c) / period;
      out.push(prev);
      return;
    }
    prev = prev + k * (c - prev);
    out.push(prev);
  });
  return out;
}
var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
function asCandle(v) {
  if (typeof v !== "object" || v === null) return null;
  const r = v;
  const t = num(r.t);
  const c = num(r.c);
  if (t === null || c === null) return null;
  return { t, o: num(r.o) ?? c, h: num(r.h) ?? c, l: num(r.l) ?? c, c, v: num(r.v) ?? 0 };
}
function candlesOf(data) {
  if (Array.isArray(data)) return data.map(asCandle).filter((x) => x !== null);
  if (typeof data !== "object" || data === null) return [];
  const r = data;
  if (Array.isArray(r.candles)) return candlesOf(r.candles);
  const one = asCandle(r.candle ?? r);
  return one ? [one] : [];
}
var CloseBuffer = class {
  constructor(max = 500) {
    this.max = max;
  }
  max;
  bars = [];
  push(cs) {
    for (const c of cs) {
      const i = this.bars.findIndex((b) => b.t === c.t);
      if (i >= 0) this.bars[i] = c;
      else this.bars.push(c);
    }
    this.bars.sort((a, b) => a.t - b.t);
    if (this.bars.length > this.max) this.bars.splice(0, this.bars.length - this.max);
  }
  clear() {
    this.bars = [];
  }
  get closes() {
    return this.bars.map((b) => b.c);
  }
  get size() {
    return this.bars.length;
  }
};
function reading(closes, period) {
  const e = ema(closes, period);
  const last = closes.length ? closes[closes.length - 1] ?? null : null;
  const diffPct = e !== null && last !== null && e !== 0 ? (last - e) / e * 100 : null;
  const trend = diffPct === null ? null : Math.abs(diffPct) < 5e-3 ? "flat" : diffPct > 0 ? "up" : "down";
  return { period, ema: e, last, diffPct, trend, bars: closes.length };
}

// src/block.ts
var PERIODS = [9, 21, 55];
var INTERVAL = "15m";
var STYLE = `
.ema{box-sizing:border-box;height:100%;display:flex;flex-direction:column;justify-content:center;gap:8px;padding:12px 14px}
.ema__top{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.7}
.ema__top button{font:inherit;color:inherit;background:none;border:0;border-radius:6px;padding:2px 8px;cursor:pointer;opacity:.7}
.ema__top button[aria-pressed="true"]{opacity:1;background:color-mix(in srgb, currentColor 16%, transparent)}
.ema__v{font-size:28px;line-height:1.1;font-variant-numeric:tabular-nums}
.ema__sub{display:flex;gap:12px;font-size:13px;font-variant-numeric:tabular-nums;opacity:.8}
.ema__wait{font-size:13px;opacity:.6}
`;
var nf = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
var sign = (n) => n > 0 ? "+" : n < 0 ? "\u2212" : "";
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== void 0) e.textContent = text;
  return e;
}
function draw(root, r, onPeriod) {
  const wrap = el("div", "ema");
  const top = el("div", "ema__top");
  top.append(el("span", void 0, `EMA ${r.period}`));
  for (const p of PERIODS) {
    const b = el("button", void 0, String(p));
    b.type = "button";
    b.setAttribute("aria-pressed", String(p === r.period));
    b.addEventListener("click", () => onPeriod(p));
    top.append(b);
  }
  wrap.append(top);
  if (r.ema === null) wrap.append(el("div", "ema__wait", r.bars === 0 ? "\u7B49\u884C\u60C5" : `\u8FD8\u5DEE ${r.period - r.bars} \u6839 K \u7EBF`));
  else {
    wrap.append(el("div", "ema__v", nf.format(r.ema)));
    const sub = el("div", "ema__sub");
    sub.append(el("span", void 0, `\u6536\u76D8 ${r.last === null ? "\u2014" : nf.format(r.last)}`));
    if (r.diffPct !== null) sub.append(el("span", void 0, `${r.trend === "up" ? "\u25B2" : r.trend === "down" ? "\u25BC" : "\u2013"} ${sign(r.diffPct)}${Math.abs(r.diffPct).toFixed(2)}%`));
    wrap.append(sub);
  }
  root.replaceChildren(wrap);
}
async function start(root, bridge) {
  const style = el("style", void 0, STYLE);
  document.head.append(style);
  const buf = new CloseBuffer(500);
  let period = 21;
  let symbol = (await bridge.hello()).links.symbol;
  let off = null;
  const paint = () => draw(root, reading(buf.closes, period), (p) => {
    period = p;
    paint();
  });
  const attach = async () => {
    off?.();
    buf.clear();
    paint();
    const filter = symbol ? { instrumentId: symbol } : void 0;
    try {
      buf.push(candlesOf(await bridge.query("market.candles", { instrumentId: symbol, interval: INTERVAL, limit: 200 })));
    } catch {
    }
    off = bridge.subscribe("market.candles", (e) => {
      buf.push(candlesOf(e.data));
      paint();
    }, { ...filter ? { filter } : {}, maxHz: 1 });
    paint();
  };
  const offLink = bridge.link.subscribe("symbol", (v) => {
    symbol = typeof v === "string" ? v : void 0;
    void attach();
  });
  await attach();
  return () => {
    off?.();
    offLink();
    style.remove();
  };
}
if (typeof window !== "undefined" && window.__GITRADER_BLOCK__) {
  const root = document.getElementById("root") ?? document.body;
  void connectHostBridge().then((b) => start(root, b)).catch((e) => {
    root.textContent = e.message;
  });
}
export {
  draw,
  start
};
