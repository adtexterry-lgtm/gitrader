**改了什么** 新建 connector-binance-trade：HMAC 签名、7 类订单与 buildProtectionOrders、trading/account/market/parse、listenKey、budget、QD 错误码分类；README 首句「未经真网验证，不得接实盘」。

**跑了什么** 10 文件 160 例全过；tsc 干净；hygiene 6 例过；check-public 仅 26 条 marketing 既有。

**没做什么** 真网、真 WS、内核注册、twap、deadman、提现、symbol 全市场扫描。

**待定** ①amend 仅 LIMIT，协议无「部分支持」（声明 emulated）；②tpsl 交内核补挂；③userTrades 需 defaultSymbol；④withdrawCapable=false 指不用提现。
