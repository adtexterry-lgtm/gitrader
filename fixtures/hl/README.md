# fixtures/hl · Hyperliquid 离线夹具

所有单测、基准、回放都读这里，不联网。

## 哪些是真的，哪些是派生的

| 文件 | 性质 |
|---|---|
| `allMids.json`、`metaAndAssetCtxs.json`、`l2Book-BTC.json`、`candleSnapshot-BTC-1m.json` | **真实**：Demo 在 2026-10-09 从主网录制的原始响应（搬自 早期 Demo 原型 `fixtures/`，未改动一个字节）。 |
| `perpDexs.json`、`metaAndAssetCtxs-{xyz,io,para,mkts}.json`、`allMids-{xyz,io,para,mkts}.json`、`l2Book-xyz_TSLA.json`、`candleSnapshot-xyz_TSLA-1h.json` | **派生**：用 Demo 的整理后快照（`app/ui/fixtures/snapshot.json`，数值来自真实行情）倒推成 HL 原始响应形状，数值真实、少量字段补齐。xyz 里另加了 2 个**合成**的已下架条目。 |
| `metaAndAssetCtxs-flx.json` | **合成**：全部 `isDelisted` 的 dex，模拟 Felix 在 2026-06 的关停；用来测动态发现的剔除逻辑。 |
| `replay/btc-1m.json` | **派生**：真实 BTC 1m 收盘价驱动，盘口形状取自真实 `l2Book-BTC.json`（整档平移到每根收盘价），资金费取当时真实值。给 venue-paper 的回放模式用。 |

重新派生：`node fixtures/derive-from-demo.mjs`（读 Demo 快照，离线）。重新录制：`fixtures/record.mjs`（联网，带权重上限，产物写到 `recorded-<env>/` 不覆盖上面的文件，**施工期间不要对主网跑**）。

时间基准：这些文件的时间戳都在 2026-10-09 前后（`1791483435048` ≈ 2026-10-08 UTC）；测试用注入的时钟，不用真实时间。
