**改了什么** connector-okx-trade：base64 HMAC 签名四头、7 类订单含 conditional/oco/move_order_stop、张↔币按 ctVal、settleCcy 只收 USDT/USDC（复用 okx-data）、13 类错误码、计次预算；README 首句「未经真网验证，不得接实盘」。

**跑了什么** 10 文件 203 例全过；tsc 干净；hygiene 6 例；check-public 仅 26 条 marketing。

**没做什么** 真网、真 WS、内核注册、twap、提现、批量下单、全账户 fills 扫描。

**待定** ①amend 仅 limit（native）；②tpsl 内核补挂，两腿合 OCO；③cancelAll 无单端点→emulated；④deadman cancelAfter 1–120s。
