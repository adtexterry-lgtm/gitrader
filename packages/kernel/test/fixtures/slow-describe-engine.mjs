// SPDX-License-Identifier: CPAL-1.0
import process from 'node:process'

let buffer = ''
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === 'gep.hello') send(message.id, { version: '0.1', sessionId: 'slow-session', resumed: false, engine: { id: 'slow-describe', version: '0.1.0' } })
    else if (message.method === 'engine.describe') {
      setTimeout(() => send(message.id, {
        engine: { id: 'slow-describe', name: 'slow-describe', version: '0.1.0', vendor: { id: 'test', name: 'test', kind: 'self', verified: false }, license: 'Apache-2.0', runtime: 'node' },
        protocol: { version: '0.1', transports: ['stdio'] }, capabilities: {}, venues: [],
      }), Number(process.env.DESCRIBE_DELAY_MS))
    } else if (message.method === 'events.subscribe') send(message.id, { subscriptionId: 'slow-sub', fromSeq: 0 })
  }
})
