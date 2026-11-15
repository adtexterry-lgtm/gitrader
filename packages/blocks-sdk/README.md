> 许可证：Apache-2.0 开源。本包 Apache-2.0，可自由嵌入，无署名要求。

# @gitrader/blocks-sdk

块 SDK：块清单 `gitrader-block/1`（校验）、块定义 API（`defineBlock` / `BlockRegistry`）、块桥（`createHostBridge`：清单约束 + 权限 + 用户激活 + 一方专属命令 + 按帧批量投递）、内核 WS 客户端（`KernelClient`：JSON-RPC、订阅 / 查询 / 命令、断线重连与重订阅、`ATTESTATION_REQUIRED` → PIN 重发）、联动组（`LinkHub`）、iframe / 弹出窗桥（`serveBridge` / `createRemoteBridge` / `attachWindowBridge` / `connectHostBridge`，postMessage + MessageChannel，同一套桥语义）、夹具 harness（`createFixtureBridge`：块不连内核也能渲染）。子路径：`/preact`（`useTopic` / `useSubscribe` / `useQuery` / `useLink` / `useCommand`）、`/testing`（假内核，仅 Node 测试用）。

写一个块：

```ts
import { defineBlock } from '@gitrader/blocks-sdk'
import { useTopic } from '@gitrader/blocks-sdk/preact'
export default defineBlock({
  manifest: { schema: 'gitrader-block/1', id: 'block.acme.hello', name: '示例', version: '0.1.0', vendor: 'acme', license: 'Apache-2.0',
    entry: { module: './hello.js', element: 'acme-hello' }, isolation: 'inline', size: { minW: 6, minH: 5, defaultW: 9, defaultH: 8 },
    inputs: { events: [{ topic: 'market.quote', maxHz: 5 }] }, permissions: ['market.read'], fixtures: './fixtures/hello.json' },
  component: () => { const q = useTopic<{ mid: string }>('market.quote'); return <div>{q?.mid ?? '—'}</div> },
})
```

类型以 `@gitrader/protocol` 为准；protocol 的块 / 工作区 / 来源类型落地前，本包 `manifest.ts` / `workspace.ts` 里的临时定义标了 `TODO(protocol)`。WS 线格式（壳 ↔ 内核）的约定写在 `src/client.ts` 头部，等 B 的 api/ 对齐。测试：`npm test -w @gitrader/blocks-sdk`。
