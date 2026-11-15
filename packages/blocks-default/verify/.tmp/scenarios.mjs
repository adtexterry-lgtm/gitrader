// fixtures/scenarios.ts
var PIN = "246810";
var NOW = Number(process.env.GITRADER_FIXTURE_NOW) || Date.now();
var hex = (n, len) => n.toString(16).padStart(len, "0");
var id = (p, n) => `${p}_01JB${hex(n, 22).toUpperCase().replace(/[ILOU]/g, "0")}`;
var ACCT_LIVE = id("acct", 1);
var ACCT_PAPER = id("acct", 2);
var KEY_CLAUDE = id("ak", 11);
var KEY_HERMES = id("ak", 12);
var MDT_CLAUDE = id("mdt", 21);
var MDT_HERMES = id("mdt", 22);
var origin = (actor, tool, via, actorType, n) => ({
  actor,
  actorType,
  tool,
  requestId: `00000000-0000-4000-8000-${hex(n, 12)}`,
  via,
  ...actorType === "llm-agent" ? { onBehalfOf: "user:usr_local" } : {}
});
var O_CLAUDE = origin(`agent:${KEY_CLAUDE}`, "propose", "mcp", "llm-agent", 1);
var O_HERMES = origin(`agent:${KEY_HERMES}`, "order", "mcp", "llm-agent", 2);
var O_ENGINE = origin("strategy:ema-trend", "strategy:ema-trend", "gep", "engine", 3);
var O_HUMAN = origin("user:usr_local", "ui:proposal.approve", "ui", "human", 4);
var O_SYSTEM = origin("system:protector", "protector:stoploss_guard", "internal", "system", 5);
var sha = (n) => `sha256:${hex(n, 64)}`;
function entry(seq, type, o, subject, payload, ts, extra = {}) {
  return {
    schema: "gitrader-ledger/1",
    seq,
    id: id("led", seq),
    ts,
    recordedAt: ts + 3,
    type,
    origin: o,
    subject,
    payload,
    payloadHash: sha(seq),
    attestation: "kernel-observed",
    prevHash: sha(seq - 1),
    hash: sha(seq),
    ...extra
  };
}
var accounts = [
  { accountId: ACCT_LIVE, alias: "\u6D4B\u8BD5\u7F51\u4E3B\u8D26\u6237", orgId: id("org", 1), groupIds: [], venue: "hyperliquid", environment: "testnet", mode: "live", owner: { address: "0x00000000000000000000000000000000000000a1" }, accountModel: "unified", signer: { type: "api-wallet", credentialRef: "wlt_demo", permissions: { trade: true, withdraw: false } }, status: "active" },
  { accountId: ACCT_PAPER, alias: "\u7EB8\u9762\u8D26\u6237", orgId: id("org", 1), groupIds: [], venue: "kernel-sim", environment: "testnet", mode: "paper", owner: {}, accountModel: "sim", signer: { type: "none", credentialRef: "none", permissions: { trade: true, withdraw: false } }, paper: { initialBalance: "10000", ccy: "USDC" }, status: "active" }
];
var pos = (accountId, instrumentId, side, size, entry2, mark, upnl, liq, lev, estimated = false) => ({
  accountId,
  instrumentId,
  side,
  size,
  entryPrice: entry2,
  markPrice: mark,
  notional: String(Math.round(Number(size) * Number(mark) * 100) / 100),
  unrealizedPnl: upnl,
  realizedPnl: "0",
  leverage: lev,
  marginMode: "cross",
  liquidationPrice: liq,
  ...estimated ? { estimated } : {},
  fundingSinceOpen: "-1.24",
  openedAt: NOW - 3 * 36e5,
  updatedAt: NOW - 2e3
});
var positions = {
  [ACCT_LIVE]: [
    pos(ACCT_LIVE, "hyperliquid:BTC", "long", "0.08", "64210.5", "64880.2", "53.58", "52110", 4),
    pos(ACCT_LIVE, "hyperliquid:ETH", "short", "1.2", "3185.2", "3170.8", "17.28", "3890.5", 3),
    pos(ACCT_LIVE, "hyperliquid:xyz:TSLA", "long", "5", "241.8", "241.8", "0", "188.2", 2)
  ],
  [ACCT_PAPER]: [pos(ACCT_PAPER, "hyperliquid:SOL", "long", "30", "148.3", "146.9", "-42", "121.4", 3, true)]
};
var summaries = {
  [ACCT_LIVE]: { accountId: ACCT_LIVE, equity: "12480.2", available: "8120.4", dayStartEquity: "12351.8", ts: NOW },
  [ACCT_PAPER]: { accountId: ACCT_PAPER, equity: "9987.5", available: "7210", dayStartEquity: "10000", ts: NOW }
};
var fill = (n, accountId, instrumentId, side, price, size, realized, ts) => ({
  fillId: id("fill", n),
  orderId: id("ord", n),
  clientOrderId: hex(n, 32),
  venueFillId: `v${n}`,
  accountId,
  instrumentId,
  side,
  price,
  size,
  fee: "0.9",
  feeCcy: "USDC",
  liquidity: "taker",
  realizedPnl: realized,
  ts
});
var fills = {
  [ACCT_LIVE]: [fill(1, ACCT_LIVE, "hyperliquid:BTC", "buy", "64210.5", "0.25", "0", NOW - 3 * 36e5), fill(2, ACCT_LIVE, "hyperliquid:ETH", "sell", "3185.2", "3", "0", NOW - 2 * 36e5), fill(3, ACCT_LIVE, "hyperliquid:SOL", "sell", "150.2", "20", "18.4", NOW - 6e5)],
  [ACCT_PAPER]: [fill(4, ACCT_PAPER, "hyperliquid:SOL", "buy", "148.3", "120", "0", NOW - 5 * 36e5)]
};
var order = (n, accountId, instrumentId, side, o, ts) => ({
  orderId: id("ord", n),
  clientOrderId: hex(n, 32),
  accountId,
  instrumentId,
  side,
  type: "limit",
  tif: "gtc",
  size: "1",
  filledSize: "1",
  status: "filled",
  fee: "0",
  origin: o,
  createdAt: ts,
  updatedAt: ts
});
var orders = {
  [ACCT_LIVE]: [order(1, ACCT_LIVE, "hyperliquid:BTC", "buy", O_CLAUDE, NOW - 3 * 36e5), order(2, ACCT_LIVE, "hyperliquid:ETH", "sell", O_ENGINE, NOW - 2 * 36e5), order(5, ACCT_LIVE, "hyperliquid:xyz:TSLA", "buy", O_HUMAN, NOW - 4 * 36e5)],
  [ACCT_PAPER]: [order(4, ACCT_PAPER, "hyperliquid:SOL", "buy", O_HERMES, NOW - 5 * 36e5)]
};
var hit = (code, ruleId, limit, actual, unit, action = "deny") => ({ ruleId, code, limit, actual, unit, action, scope: "org" });
var intent = (instrumentId, side, size, price, reason) => ({ accountId: ACCT_LIVE, instrumentId, side, type: "limit", size, price, tif: "gtc", reason });
function proposal(n, ticket, status, expiresIn, o, legs, reason, hits = [], est = { notional: "32105", marginRequired: "6421", liquidationPrice: "52110", slippageBps: 6 }) {
  return {
    proposalId: id("prop", n),
    ticket,
    kind: "order",
    status,
    accountId: ACCT_LIVE,
    intents: legs,
    intentsDigest: sha(900 + n),
    reason,
    precheck: { precheckId: id("pck", n), verdict: "review", policyVersion: 3, ruleHits: hits, estimates: est, expiresAt: NOW + expiresIn },
    priceBounds: { referencePrice: "64210", maxDriftBps: 30 },
    mandateId: MDT_CLAUDE,
    expiresAt: NOW + expiresIn,
    decision: null,
    execution: null,
    origin: o
  };
}
var mandate = (mandateId, keyId, level) => ({
  mandateId,
  version: 2,
  subject: { type: "agentKey", id: keyId },
  level,
  accounts: [ACCT_LIVE, ACCT_PAPER],
  venueAllowlist: ["hyperliquid", "kernel-sim"],
  instrumentAllowlist: ["hyperliquid:BTC", "hyperliquid:ETH", "hyperliquid:SOL"],
  limits: { maxOrderNotional: "5000", maxDailyNotional: "20000" },
  notBefore: NOW - 864e5,
  notAfter: NOW + 29 * 864e5,
  status: "active",
  issuedBy: "user:usr_local",
  attestation: { method: "pin", by: "usr_local", at: NOW - 864e5, digest: sha(77), sig: "c2ln" }
});
var executed = {
  ...proposal(6, "T-20261010-0006", "executed", -38 * 6e4, O_CLAUDE, [intent("hyperliquid:BTC", "buy", "0.03", "64300", "\u4E0A\u4E00\u5355\u88AB\u62E6\u540E\u6539\u8D70\u63D0\u6848\uFF1A\u540C\u4E00\u6807\u7684\u5C0F\u4ED3\u4F4D\uFF0C\u6B62\u635F\u5DF2\u8BBE")], "\u4E0A\u4E00\u5355\u88AB\u62E6\u540E\u6539\u8D70\u63D0\u6848\uFF1A\u540C\u4E00\u6807\u7684\u5C0F\u4ED3\u4F4D\uFF0C\u6B62\u635F\u5DF2\u8BBE", [hit("NEEDS_APPROVAL", "mdt_01JB#autoMaxOrderNotional", "2000", "9600", "USDC", "review")]),
  decision: { by: "user:usr_local", at: NOW - 38 * 6e4 },
  execution: { orderIds: [id("ord", 6)], at: NOW - 38 * 6e4 + 900, result: "filled" }
};
var keys = [
  { keyId: KEY_CLAUDE, name: "Claude Code", host: "claude-code", mandateId: MDT_CLAUDE, status: "active", createdAt: NOW - 5 * 864e5, expiresAt: NOW + 85 * 864e5, lastSeenAt: NOW - 2e4, createdBy: "user:usr_local" },
  { keyId: KEY_HERMES, name: "Hermes", host: "hermes", mandateId: MDT_HERMES, status: "active", createdAt: NOW - 2 * 864e5, expiresAt: NOW + 88 * 864e5, lastSeenAt: NOW - 36e5, createdBy: "user:usr_local" }
];
var ledger = () => [
  entry(101, "order.intent", O_CLAUDE, { accountId: ACCT_LIVE, instrumentId: "hyperliquid:BTC" }, { intent: intent("hyperliquid:BTC", "buy", "0.25", "64210", "\u7A81\u7834\u524D\u9AD8\u540E\u56DE\u8E29\u786E\u8BA4\uFF0C\u6309\u8BA1\u5212\u52A0\u4ED3") }, NOW - 3 * 36e5, { precheck: { precheckId: id("pck", 1), verdict: "allow", policyVersion: 3, estimates: {} } }),
  entry(102, "fill", { ...O_CLAUDE, actor: "agent:" + KEY_CLAUDE }, { accountId: ACCT_LIVE, instrumentId: "hyperliquid:BTC" }, { price: "64210.5", size: "0.25", side: "buy", fee: "0.9", realizedPnl: "0" }, NOW - 3 * 36e5 + 800),
  entry(103, "order.intent", O_ENGINE, { accountId: ACCT_LIVE, instrumentId: "hyperliquid:ETH" }, { intent: intent("hyperliquid:ETH", "sell", "3", "3185", "\u5FEB\u7EBF\u4E0B\u7A7F\u6162\u7EBF") }, NOW - 2 * 36e5, { precheck: { precheckId: id("pck", 2), verdict: "allow", policyVersion: 3, estimates: {} } }),
  entry(104, "fill", O_ENGINE, { accountId: ACCT_LIVE, instrumentId: "hyperliquid:ETH" }, { price: "3185.2", size: "3", side: "sell", fee: "1.1", realizedPnl: "0" }, NOW - 2 * 36e5 + 600),
  entry(105, "order.intent", O_HERMES, { accountId: ACCT_LIVE, instrumentId: "hyperliquid:SOL" }, { intent: intent("hyperliquid:SOL", "buy", "40", "150", "\u60C5\u7EEA\u9762\u8F6C\u591A\uFF0C\u8BD5\u63A2\u6027\u5EFA\u4ED3") }, NOW - 50 * 6e4, {
    precheck: { precheckId: id("pck", 3), verdict: "deny", policyVersion: 3, estimates: {} },
    ruleHits: [hit("LLM_LIVE_ENTRY", "pol_01JB#denyLlmLiveEntries", "0", "1", "entries")]
  }),
  entry(106, "risk.denied", O_HERMES, { accountId: ACCT_LIVE, precheckId: id("pck", 3) }, { problem: { code: 2001, name: "RULE_DENIED", message: "live entries originating from an LLM agent are denied by policy" } }, NOW - 50 * 6e4 + 5, {
    precheck: { precheckId: id("pck", 3), verdict: "deny", policyVersion: 3, estimates: {} },
    ruleHits: [hit("LLM_LIVE_ENTRY", "pol_01JB#denyLlmLiveEntries", "0", "1", "entries")]
  }),
  entry(107, "proposal.created", O_CLAUDE, { proposalId: id("prop", 6), ticket: "T-20261010-0006", accountId: ACCT_LIVE }, { status: "pending", reason: "\u4E0A\u4E00\u5355\u88AB\u62E6\u540E\u6539\u8D70\u63D0\u6848\uFF1A\u540C\u4E00\u6807\u7684\u5C0F\u4ED3\u4F4D\uFF0C\u6B62\u635F\u5DF2\u8BBE" }, NOW - 40 * 6e4, { precheck: { precheckId: id("pck", 7), verdict: "review", policyVersion: 3, estimates: {} }, ruleHits: [hit("NEEDS_APPROVAL", "mdt_01JB#autoMaxOrderNotional", "2000", "9600", "USDC", "review")] }),
  entry(108, "proposal.decided", O_HUMAN, { proposalId: id("prop", 6), ticket: "T-20261010-0006" }, { decision: "approved" }, NOW - 38 * 6e4),
  entry(109, "proposal.executed", O_SYSTEM, { proposalId: id("prop", 6), ticket: "T-20261010-0006" }, {}, NOW - 38 * 6e4 + 900),
  entry(110, "order.intent", O_ENGINE, { accountId: ACCT_LIVE, instrumentId: "hyperliquid:BTC" }, { intent: { ...intent("hyperliquid:BTC", "buy", "2", "64300", "\u6760\u6746\u8FC7\u9AD8\u7684\u8BD5\u5355") } }, NOW - 25 * 6e4, {
    precheck: { precheckId: id("pck", 10), verdict: "deny", policyVersion: 3, estimates: {} },
    ruleHits: [hit("ORDER_NOTIONAL", "pol_01JB#maxOrderNotional", "5000", "128600", "USDC"), hit("LEVERAGE", "pol_01JB#maxLeverage", "5", "12", "\xD7")]
  }),
  entry(111, "protector.triggered", O_SYSTEM, { accountId: ACCT_LIVE }, { protector: "stoploss_guard", scope: { type: "account", id: ACCT_LIVE }, pauseMin: 30 }, NOW - 20 * 6e4, { ruleHits: [hit("PROTECTOR", "prot_stoploss", "2", "2", "\u6B21")] }),
  entry(112, "fill", O_SYSTEM, { accountId: ACCT_LIVE, instrumentId: "hyperliquid:SOL" }, { price: "150.2", size: "20", side: "sell", fee: "0.4", realizedPnl: "18.4" }, NOW - 10 * 6e4),
  entry(113, "note", O_CLAUDE, { accountId: ACCT_LIVE }, { text: "\u4ECA\u5929\u5148\u89C2\u5BDF\uFF0C\u4E0D\u518D\u5F00\u65B0\u4ED3\uFF0C\u7B49\u8D44\u91D1\u8D39\u7387\u56DE\u843D" }, NOW - 5 * 6e4)
];
var risk = (state, deny) => ({
  tradingState: state,
  reasons: state === "ACTIVE" ? [] : [{ scope: { type: "org" }, state, reason: "takeover flatten_all: \u4EBA\u5728\u68C0\u9605\u9762\u89E6\u53D1" }],
  policy: {
    version: 3,
    denyLlmLiveEntries: deny,
    dailyResetAt: "00:00Z",
    valuationCcy: "USDC",
    protectors: [{ kind: "cooldown", afterOpenSec: 5 }, { kind: "stoploss_guard", windowMin: 60, maxStoplosses: 2, pauseMin: 30, scope: "account" }, { kind: "drawdown_pause", windowHours: 24, maxDrawdownRatio: "0.04", pauseMin: 120 }]
  },
  limits: { maxLeverage: 5, maxOrderNotional: "5000", maxTotalNotionalRatio: "1", maxDailyLossRatio: "0.05", maxSlippageBps: 30, maxOrdersPerMinute: 30, maxOrdersPerDay: 50 },
  integrity: { ok: true },
  denyLlmLiveEntries: deny,
  usage: { orderNotional: 3210, ordersToday: 7 }
});
var venues = [
  { id: "hyperliquid", venue: "hyperliquid", environment: "testnet", ts: NOW, wsState: "connected", latencyMs: { p50: 42, p95: 88 }, rateBudget: { used: 312, limit: 1200, windowMs: 6e4, ratio: 0.26 } },
  { id: "kernel-sim", venue: "kernel-sim", environment: "testnet", ts: NOW, wsState: "connected", latencyMs: { p50: 1, p95: 2 } }
];
function scenario(name) {
  const base = {
    name,
    accounts: structuredClone(accounts),
    positions: structuredClone(positions),
    summaries: structuredClone(summaries),
    fills: structuredClone(fills),
    orders: structuredClone(orders),
    ledger: ledger(),
    proposals: [executed],
    keys: structuredClone(keys),
    mandates: [mandate(MDT_CLAUDE, KEY_CLAUDE, "L2"), mandate(MDT_HERMES, KEY_HERMES, "L1")],
    risk: risk("ACTIVE", true),
    venues: structuredClone(venues),
    failing: false
  };
  switch (name) {
    case "empty":
      return { ...base, accounts: [structuredClone(accounts[1])], positions: { [ACCT_PAPER]: [] }, summaries: { [ACCT_PAPER]: { accountId: ACCT_PAPER, equity: "10000", available: "10000", dayStartEquity: "10000", ts: NOW } }, fills: { [ACCT_PAPER]: [] }, orders: { [ACCT_PAPER]: [] }, ledger: [], proposals: [], keys: [], mandates: [], venues: [structuredClone(venues[1])] };
    case "pending":
      return {
        ...base,
        proposals: [
          proposal(7, "T-20261010-0007", "pending", 9 * 6e4 + 42e3, O_CLAUDE, [intent("hyperliquid:BTC", "buy", "0.5", "64210", "\u7A81\u7834\u540E\u56DE\u8E29\u786E\u8BA4\uFF0C\u8BA1\u5212\u5206\u4E24\u7B14\u5EFA\u4ED3")], "\u7A81\u7834\u524D\u9AD8\u540E\u56DE\u8E29\u786E\u8BA4\uFF0C\u6210\u4EA4\u91CF\u653E\u5927\uFF0C\u6B62\u635F\u653E\u5728\u524D\u4F4E\u4E0B\u65B9", [hit("NEEDS_APPROVAL", "mdt_01JB#autoMaxOrderNotional", "2000", "32105", "USDC", "review")]),
          proposal(8, "T-20261010-0008", "pending", 3 * 6e4 + 5e3, O_CLAUDE, [intent("hyperliquid:ETH", "sell", "2", "3190", "\u5BF9\u51B2\u591A\u5934\u655E\u53E3")], "\u5BF9\u51B2 BTC \u591A\u5934\u7684\u76F8\u5173\u98CE\u9669\uFF0C\u51CF\u5C0F\u51C0\u655E\u53E3", [], { notional: "6380", marginRequired: "2127", liquidationPrice: "3890.5", slippageBps: 4 }),
          ...base.proposals
        ]
      };
    case "halted":
      return { ...base, risk: risk("HALTED", true) };
    case "error":
      return { ...base, failing: true };
    default:
      return base;
  }
}
export {
  ACCT_LIVE,
  ACCT_PAPER,
  KEY_CLAUDE,
  KEY_HERMES,
  MDT_CLAUDE,
  MDT_HERMES,
  NOW,
  O_CLAUDE,
  O_ENGINE,
  O_HERMES,
  O_HUMAN,
  O_SYSTEM,
  PIN,
  entry,
  proposal,
  scenario
};
