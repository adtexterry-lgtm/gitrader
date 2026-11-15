// SPDX-License-Identifier: CPAL-1.0
//
// ============================================================================================
//  GITRADER STRATEGY TEMPLATE  ·  blank on purpose: no trading logic, no data, no opinions
//  空白策略模板：只有接口，没有任何交易逻辑。逻辑由你（或你的 Agent）填。
// ============================================================================================
//
//  FOR THE AGENT WRITING THIS FILE  (read this block first)
//
//  What a strategy is
//    A pure function of (candles, params). For every closed candle it returns a TARGET POSITION
//    between -1 and +1:   +1 = fully long,  0 = flat,  -1 = fully short,  0.5 = half long.
//    The engine turns changes of that target into order intents. You never place orders,
//    never size orders, never talk to a venue. You only say "what position do I want here, and why".
//
//  How to use this file
//    1. Copy it to  ~/.gitrader/engines/gitrader-core/strategies/<your-id>.ts   (the folder is watched; for your own engine it is engines/<engine-id>/strategies).
//    2. Change `id`, `name`, `version`, `desc`, `params`, and fill in `evaluate`.
//    3. The engine validates the file within about a second and hot-loads it. If something is wrong
//       you get readable errors: call the GEP method  x-gitrader.strategy.files  (or read the MCP
//       `engine` tool) to see them, fix, save again. No restart needed.
//    4. Backtest it:   backtest.run  with  subject.strategy = { id, version, params }
//       (the data comes from the kernel's recorder or from a CSV/JSON file you point at; the engine
//        ships no historical data). Read `assumptions` in the result: fees, slippage, fill model,
//        funding (NOT modelled), liquidation (NOT modelled). Read `biasChecks.lookahead`.
//    5. Paper-trade it:   strategy.start  on a PAPER account (mandate level L1). Watch it in the
//       Agent-activity block. Only a human can promote a strategy to a live account.
//
//  Rules (the validator enforces most of them, the rest are on you)
//    - target[i] may use candles[0..i] ONLY. Never candles[i+1], never a statistic of the whole
//      array (mean/max of all closes, normalising by the full range). The validator re-runs your
//      function on truncated histories and fails you if an earlier signal changes. ("lookahead")
//    - Deterministic: same (candles, params) -> same output. No Math.random(), no Date.now(),
//      no hidden state that survives between calls.
//    - Do not modify the arguments (candles are frozen during validation).
//    - No imports at run time (`import type` is fine and erased), no network, no files, no
//      process/env access, no eval. Copy any helper you need into this file.
//    - Every change of target needs a short human-readable reason in reasons[i]
//      ('' where the target did not change). The reason is stored with the signal and the order.
//    - Do not call a model or make a "judgement" at run time: evaluate() is plain arithmetic on the
//      candles. A language model writes the code once; it does not trade in real time.
//    - Never promise results in `desc`. Say what the rule does and when it tends to fail.
//    - Parameter names must not look like secrets (privateKey, secret, apiSecret, mnemonic, seed,
//      passphrase) and `size` is reserved (the engine-wide per-order size cap).
//
//  Output contract of evaluate(candles, params)  (n = candles.length)
//    target   : number[n]           each in [-1, 1], finite (use 0 during warm-up)
//    reasons  : string[n]           '' unless the target changed at that bar
//    overlays : { [name]: (number|null)[n] }   lines to draw on the price chart ({} is fine; <= 12)
//    warmup   : integer >= 0        index of the first bar with a valid signal (may exceed n while still warming up)
//    It must also cope with n = 0 and n < period (return empty / zero series, never throw), and
//    with every numeric parameter at its min or max.
//
//  Optional: anchor(candles, params) -> params
//    Called once when an instance (or a backtest) starts, with the most recent candles.
//    Use it to freeze a parameter that depends on "where we started" (e.g. a grid centre).
//    Return the completed params; return only keys that are declared in `params`.
// ============================================================================================

// ── Types (self-contained; erased at load time, only for your editor / tsc) ──
type Candle = { t: number; o: number; h: number; l: number; c: number; v: number } // t = open time in ms; closed candles
type ParamValue = number | boolean | string
type Params = Record<string, ParamValue>
type ParamDef = {
  key: string // camelCase, starts with a letter
  label: string // shown to humans
  type: 'number' | 'integer' | 'boolean' | 'select'
  default: ParamValue // must satisfy type / min / max / options
  min?: number
  max?: number
  step?: number
  options?: string[] // for type 'select'
  help?: string
  hidden?: boolean // internal parameter, not shown in forms
}
type SignalSeries = { target: number[]; reasons: string[]; overlays: Record<string, Array<number | null>>; warmup: number }
type StrategyDef = {
  id: string
  name: string
  nameZh?: string
  version: string
  desc: string
  tags: string[]
  params: ParamDef[]
  anchor?(candles: Candle[], params: Params): Params
  evaluate(candles: Candle[], params: Params): SignalSeries
}

const strategy: StrategyDef = {
  // Lowercase letters, digits, dashes; 2-40 chars; unique among the files in the folder.
  id: 'blank-template',
  name: 'Blank template (does nothing)',
  nameZh: '空白模板（什么都不做）',
  // Semantic version. Bump it whenever the logic changes: backtests record it.
  version: '0.1.0',
  // Plain words: what the rule does, when it works, when it fails. No performance claims.
  desc: 'Template with no trading logic: the target is always 0.',
  tags: ['template'],

  // Declare every tunable number here. Backtests and hot updates (strategy.update) use these
  // definitions: out-of-range or unknown values are rejected, never silently clamped.
  params: [
    { key: 'period', label: 'Look-back period (bars)', type: 'integer', default: 20, min: 2, max: 400, step: 1 },
    { key: 'allowShort', label: 'Allow short', type: 'boolean', default: true },
  ],

  // Optional hook, delete if unused. See the header.
  // anchor(candles, params) { return params },

  evaluate(candles, params) {
    const n = candles.length
    const period = params.period as number
    void period // TODO(agent): use your parameters
    void params.allowShort

    const target: number[] = new Array(n).fill(0) // TODO(agent): compute the target position per bar, using candles[0..i] only
    const reasons: string[] = new Array(n).fill('') // TODO(agent): explain every change of target, e.g. 'close 101.2 crossed above EMA20 99.8 -> long'
    const overlays: Record<string, Array<number | null>> = {} // TODO(agent): e.g. { EMA20: emaValues } (arrays of length n, null while warming up)
    const warmup = period - 1 // first bar with a valid signal

    return { target, reasons, overlays, warmup }
  },
}

export default strategy
