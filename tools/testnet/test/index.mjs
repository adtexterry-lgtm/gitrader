// SPDX-License-Identifier: CPAL-1.0
// 让 `node --test tools/testnet/test/`（目录形式）也能跑：Node 22.23 把目录参数当模块解析，
// 于是这里的 package.json main 指向本文件，由它把各场所的用例与纯函数用例全部登记进来。
// glob 形式（`node --test "tools/testnet/test/*.test.mjs"`）不经过本文件，不会重复执行。
import './journey-lib.test.mjs'
import './venues-testnet.test.mjs'
import './journey-binance.test.mjs'
import './journey-okx.test.mjs'
import './journey-bybit.test.mjs'
import './journey-bitget.test.mjs'
import './journey-gateio.test.mjs'
import './journey-alpaca.test.mjs'
import './journey-ibkr.test.mjs'
import './journey-dydx.test.mjs'
import './journey-htx.test.mjs'
import './journey-hyperliquid.test.mjs'
