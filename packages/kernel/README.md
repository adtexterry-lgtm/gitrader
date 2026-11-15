> 许可证：CPAL-1.0（界面须显示 Powered by Gitrader，见根 `LICENSE`）。

# @gitrader/kernel

内核：存储、账本、配置、鉴权、密钥、风控闸、钥匙与授权书、提案、连接器总线、事件总线、插件宿主、HTTP+WS API。


## 场所级看门狗（死人开关）

内核进程死亡时，场所要替我们撤掉挂单（持仓不动）。做法：只要某个实盘账户“有实盘挂单”或“有开启了实盘的授权书（L2+ 且覆盖该账户）”，内核每 10 分钟把 `scheduleCancel` 的到点时间推到 20 分钟之后（连接器声明了 `deadman` 能力、钱包已解锁才生效）。Hyperliquid 的每日 10 次上限计的是“真的触发了”，**续期不算触发**。杀开关与 HALTED 时立即 trip（最短延迟 + 2 s）。没有挂单也没有实盘授权书就不续期，并清除已设的时间。见 `src/takeover.ts` 的 `VenueDeadman`。

## 模块

`kernel.ts` 负责生命周期、纸面状态持久化、启动对账与 HALT 监视；`trading.ts` / `orders.ts` 管理提案、订单、成交及来源账；`risk.ts` / `risk-gate/` 管理签名策略、确定性闸门和票据；`takeover.ts` 负责接管与死人开关；`connector.ts` 负责连接器路由；`gep/` 与引擎管理负责宿主接线；`ops.ts` / `api/` / `http/` 提供人面、Agent 与事件接口；`ledger.ts`、`db.ts`、鉴权与密钥模块保留本机存储和审计边界。
