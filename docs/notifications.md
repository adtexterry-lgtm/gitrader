<!-- SPDX-License-Identifier: CPAL-1.0 -->
# 通知出口

通知由内核事件触发，经已安装、已启用的通道插件发送。插件需在清单声明 `notify_send` 工具。
这是内核主动调用插件工具，不开放插件反向订阅事件。通知只报告事实，不给出交易建议。

## 配置

在现有配置中加入以下段落；插件 ID 和 params 按实际通道说明填写，修改后重启。
```json
{
  "plugins": {
    "developerMode": false,
    "trustRoots": [],
    "secrets": { "connector.example.notify": { "DELIVERY_TOKEN": "env:NOTIFY_CHANNEL_CREDENTIAL" } }
  },
  "notify": {
    "channels": [
      { "id": "main", "plugin": "connector.example.notify", "minLevel": "warn", "params": { "target": "target-01" } }
    ],
    "rules": [
      { "match": "takeover.*", "level": "critical", "channels": ["main"] }
    ],
    "rateLimit": { "perChannelPerMinute": 20, "dedupeWindowSec": 300 }
  }
}
```

保留原 plugins 设置；示例 ID 为占位。未签名插件需要开发者模式，并由用户显式启用与授予清单所需权限。
未配置 notify 或 channels 为空时不发送。规则按顺序取首个匹配，支持精确主题、`prefix.*` 和 `*`。
规则设置级别与目标通道，再按 minLevel 过滤；无匹配规则时全部通道按 minLevel 过滤。发送遵循 channels 的配置顺序。
账户、标的、规则与数值保持原始事实；承诺类文字被替换为 `[redacted wording]` 并计数。

## 三条硬规则

**一、自由文本不进通知正文。** 模板只按字段白名单取事实（id / accountId / instrumentId / orderId /
proposalId / precheckId / mandateId / takeoverId / experimentId / pluginId / engineId / ruleId / rule / code / type /
state / status / gep / phase / from / to / level / actual / observed / value / limit / threshold /
quantity / price / notional / remaining / version / until / sent / failed），且只下钻 scope、hit、
ruleHits、protector、precheck、intent、decision、execution、error、problem 这几个分组。
字符串值不符合事实词形（1–64 个 `A-Za-z0-9_.:/-`）时写成 `[text omitted]`，其余键一律不序列化。
所以提案理由、接管理由、备注、策略说明、下单留言都不会出现在通知里；要留档去账本里查，别指望通知。

**二、同一接管只发一条。** 通知 key 按 takeoverId 归并：requested / applied / completed 以及随后同 scope
的 `trading_state.changed` 共用同一个 key，同一通道在去重窗口内只受理一次（默认 300 秒，
见 `notify.rateLimit.dedupeWindowSec`）。failed 与 alert 是另一条 key，级别固定 critical，不会被前一条吞掉。
窗口内投递失败也占位。把 `dedupeWindowSec` 设成 0 等于关闭去重，同一接管每个阶段各发一条——默认值是有意的。

**三、短密钥值不参与回显扫描。** 清单 `secrets` 声明的值短于 8 个字符时，内核不拿它比对插件帧回显，
启动日志只告警 `short secret excluded from frame scan: <NAME>`；这类值既挡不住回显，也容易被 `ref` 里的
普通数字误命中。密钥请用 ≥8 个字符的随机串，且各通道互不复用。

## 密钥与通道契约

params 原样传入插件，只放非密钥参数。秘密值放在启动环境中，配置仅存 `env:VAR` 句柄。
清单 secrets 声明的每个名称都必须配置且能够解析；缺失时启动失败，仅报告名称。
未声明的配置项被忽略并告警。解析值仅加入对应子进程环境，不放入 JSON-RPC；响应回显这些值会被拒收（短于 8 字符的值不参与该比对，见「三条硬规则」三）。
工具输入为 `{ notice: { key, level, title, lines, ts, topic }, params }`；ts 为整数毫秒，level 为 info / warn / critical。
工具输出为 `{ ok: true, ref?: string }` 或 `{ ok: false, reason: string, retryable: boolean }`，清单 output 必须声明相应 schema。
沿用工具 RPC 的 10 秒超时；可重试失败最多再试一次，retryable=false 不重试。通道必须自行脱敏 reason；出口日志不打印 params 或原始错误。

## 工具契约（清单的 `tools[]` 以本节为唯一真源）

通道插件必须在清单 `tools[]` 里声明工具 `notify_send`（协议的工具名正则不允许点号，只有这一个名字；`notify.send`
只是 B0 契约里的写法，由内核侧映射）。`input` / `output` 的形状以本节 schema 为唯一真源：`tools/release/plugin-audit.mjs`
直接读这段 JSON 逐项核对清单，**任何一项对不上即判失败**——`required`、`notice.required`、`notice` 的允许字段集、
`level` 的枚举、`params` 必填、`output.required` 必须含 `ok`。

```json
{
  "input": {
    "type": "object",
    "additionalProperties": false,
    "required": ["notice", "params"],
    "properties": {
      "notice": {
        "type": "object",
        "additionalProperties": false,
        "required": ["key", "level", "title", "lines"],
        "properties": {
          "key": { "type": "string" },
          "level": { "type": "string", "enum": ["info", "warn", "critical"] },
          "title": { "type": "string" },
          "lines": { "type": "array" },
          "ts": { "type": "number" },
          "topic": { "type": "string" }
        }
      },
      "params": { "type": "object" }
    }
  },
  "output": {
    "type": "object",
    "required": ["ok"]
  }
}
```

`notice.key` / `level` / `title` / `lines` 必填，`ts` 与 `topic` 可选（内核总会给齐六个字段）。`params` 必填、可以是空对象，
它的内部形状由各通道自己的清单声明（本 schema 只管「必填且是对象」）。

**为什么 `notify_send` 要写进清单，Agent 却调不到它。** Agent 与通用 `plugin.call` 不能调用通知发送：
内核在插件调用入口按调用者身份拦截（`packages/kernel/src/plugins.ts` 只放行通知出口与人面的 `notify.test`）。
但工具仍然必须写进清单 `tools[]`——内核只按清单声明的名字找通道，不声明等于没装。
「谁能调」是内核侧的调用者闸门，「有没有这个能力」是清单侧的事实声明，二者不是一回事：清单照写 `notify_send`，
别名 `notify.send` 不写。

## 去重、限流与测试

同一通道的同一 key 在默认 300 秒内受理一次；失败也占去重窗口。dedupeWindowSec=0 可关闭去重。
每通道从首条受理通知开始计 60 秒窗口，默认放行 20 条；超额合并，窗口末尾发送一条“N 条通知被合并”摘要。
摘要额外发送，不再消耗该窗口额度。待处理队列上限 1000，溢出丢最旧；停机取消排队项与定时器，队列不持久化。
执行 `gitrader notify test main`：通过人面 `notify.test({ channelId })` 发送固定 info 测试消息，绕过去重、限流和 minLevel。
CLI 支持离线本地内核或已运行服务，输出各通道结果；成功退出 0，失败退出 1。Agent 与通用 plugin.call 不能调用通知发送（见「工具契约」）。
鉴权后的 `/api/metrics` 提供 notify_sent_total{channel,level}、notify_failed_total{channel,reason}、notify_dropped_total，
以及 notify_deduplicated_total、notify_merged_total、notify_redacted_total、notify_retried_total；failed 按最终失败的一次投递计数。
通知不写入账本；当前内核事件中的通知订阅范围不等同于全部账本类型。
