// SPDX-License-Identifier: CPAL-1.0
// 离线假 fetch：按脚本返回状态码 / body 并记录每次调用；另有「只按 AbortSignal 拒绝」的版本用来测超时。
export interface FakeReply {
  status: number
  body: string
}

export interface FakeCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export interface ScriptedFetch {
  fetchImpl: typeof fetch
  calls: FakeCall[]
}

function toCall(input: string | URL | Request, init?: RequestInit): FakeCall {
  return {
    url: String(input),
    method: typeof init?.method === 'string' ? init.method : 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === 'string' ? init.body : '',
  }
}

/** 按顺序消费 replies；用尽后一律 200 'ok'。 */
export function scriptedFetch(replies: FakeReply[]): ScriptedFetch {
  const calls: FakeCall[] = []
  const queue = [...replies]
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(toCall(input, init))
    const reply = queue.shift() ?? { status: 200, body: 'ok' }
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async (): Promise<string> => reply.body } as unknown as Response
  }
  return { fetchImpl: impl as unknown as typeof fetch, calls }
}

/** 永不返回的 fetch：signal 一 abort 就以 AbortError 拒绝。 */
export function hangingFetch(): ScriptedFetch {
  const calls: FakeCall[] = []
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push(toCall(input, init))
    return new Promise<Response>((_resolve, reject) => {
      const fail = (): void => {
        const error = new Error('The operation was aborted.')
        error.name = 'AbortError'
        reject(error)
      }
      const signal = init?.signal
      if (!signal) return
      if (signal.aborted) {
        fail()
        return
      }
      signal.addEventListener('abort', fail, { once: true })
    })
  }
  return { fetchImpl: impl as unknown as typeof fetch, calls }
}
