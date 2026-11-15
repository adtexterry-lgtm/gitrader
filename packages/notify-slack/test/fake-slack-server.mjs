// SPDX-License-Identifier: CPAL-1.0
// 假 Slack Incoming Webhook 服务器（测试用，真听回环端口）。它按官方文档的规则**独立**校验请求，
// 不 import 客户端任何代码、也不复用客户端常量（上限 40000 与成功响应 `ok` 按官方文档抄写）：
//   - 方法必须是 POST，content-type 必须是 application/json；
//   - body 必须是 JSON 对象，且只有 `text` 一个键（webhook 的消息体形态）；
//   - `text` 必须是非空字符串、长度 ≤ 40000；
//   - 正文里 `&` `<` `>` 必须已经转义（`&amp;` / `&lt;` / `&gt;`），不允许出现裸 `<` `>`。
// 用途：让客户端走真实 socket，而不是把客户端自己的假 fetch 当"证据"。
import { createServer } from 'node:http'

/** 官方文档的 text 上限（字符）。故意与客户端各写一份，改一处不会两边同时"对"。 */
export const FAKE_MAX_TEXT = 40000
/** 失败记录里最多保留的正文片段，避免日志过长。 */
const SNIPPET = 200

/**
 * 启动假服务器。
 * @param {{ respond?: (index: number, body: unknown) => { status?: number, body?: string, headers?: Record<string,string> } }} [options]
 * @returns {Promise<{ url: string, port: number, requests: Array<object>, violations: string[], setRespond: Function, close: Function }>}
 */
export async function startFakeSlackServer(options = {}) {
  const requests = []
  const violations = []
  let respond = options.respond ?? (() => ({ status: 200, body: 'ok' }))

  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const path = req.url ?? ''
      const contentType = String(req.headers['content-type'] ?? '')
      if (req.method !== 'POST') violations.push(`method is ${req.method}, expected POST`)
      if (!contentType.toLowerCase().includes('application/json')) violations.push(`content-type is ${JSON.stringify(contentType)}, expected application/json`)
      if (!/^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(path)) violations.push(`path is ${JSON.stringify(path)}, expected /services/<team>/<channel>/<secret>`)

      let body
      try {
        body = JSON.parse(raw)
      } catch {
        violations.push('body is not valid JSON')
      }

      if (body !== undefined) {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          violations.push('body is not a JSON object')
        } else {
          const keys = Object.keys(body)
          if (keys.length !== 1 || keys[0] !== 'text') violations.push(`body keys are ${JSON.stringify(keys)}, expected ["text"]`)
          const text = body.text
          if (typeof text !== 'string') violations.push('text is not a string')
          else {
            if (text.length === 0) violations.push('text is empty')
            if (text.length > FAKE_MAX_TEXT) violations.push(`text is ${text.length} characters, over the ${FAKE_MAX_TEXT} limit`)
            if (/</.test(text)) violations.push('text contains a raw "<" (must be &lt;)')
            if (/>/.test(text)) violations.push('text contains a raw ">" (must be &gt;)')
            if (/&(?!(?:amp|lt|gt);)/.test(text)) violations.push('text contains a raw "&" (must be &amp;)')
          }
        }
      }

      requests.push({
        method: req.method,
        path,
        contentType,
        raw,
        body,
        text: body && typeof body === 'object' && typeof body.text === 'string' ? body.text : undefined,
      })

      const reply = respond(requests.length, body)
      const status = reply.status ?? 200
      const headers = reply.headers ?? { 'content-type': 'text/plain; charset=utf-8' }
      const payload = reply.body ?? ''
      res.writeHead(status, headers)
      res.end(payload)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const url = `http://127.0.0.1:${port}/services/T00000000/B00000000/fixture-secret-value`

  return {
    url,
    port,
    requests,
    violations,
    setRespond(fn) {
      respond = fn
    },
    /** 最近的违规记录，截断到便于断言的长度。 */
    violationSummary() {
      return violations.map((item) => (item.length > SNIPPET ? `${item.slice(0, SNIPPET)}...` : item))
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
