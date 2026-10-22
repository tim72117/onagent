import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from './client'

// The SSE transport (transport: "sse" | "auto"): SSE down, POST up. These
// check it behaves like the WebSocket path from the caller's side — hello
// on connect, queue until ack, tool calls answered, reconnect with a fresh
// hello — and the parts specific to it: the session event, POST ordering,
// resending a prompt whose POST failed, and "auto" falling back.

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  private listeners: Record<string, ((ev: any) => void)[]> = {}

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (ev: any) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }

  close(): void {
    this.closed = true
  }

  /** Test-side: the stream's first event. */
  session(id: string): void {
    this.emit('session', { data: JSON.stringify({ sessionId: id }) })
  }

  /** Test-side: one server→client envelope. */
  envelope(env: object): void {
    this.emit('message', { data: JSON.stringify(env) })
  }

  /** Test-side: the stream broke. */
  fail(): void {
    this.emit('error', {})
  }

  private emit(type: string, ev: any): void {
    if (this.closed) return
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
}

/** Never opens — what a proxy that refuses the Upgrade looks like. */
class DeadWebSocket {
  static readonly OPEN = 1
  static instances: DeadWebSocket[] = []
  readyState = 0
  private listeners: Record<string, ((ev: any) => void)[]> = {}
  constructor(readonly url: string) {
    DeadWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  send(): void {}
  close(): void {}
  refuse(): void {
    this.readyState = 3
    for (const fn of this.listeners.close ?? []) fn({})
  }
}

/** A WebSocket whose close() fires its close event later, as a real
 * browser's does — so a test can let a new connection come up first. */
class AsyncCloseWebSocket {
  static readonly OPEN = 1
  static instances: AsyncCloseWebSocket[] = []
  readyState = 0
  sent: string[] = []
  private listeners: Record<string, ((ev: any) => void)[]> = {}
  constructor(readonly url: string) {
    AsyncCloseWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: (ev: any) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 2 // CLOSING; the close event comes later
  }
  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }
  ack(): void {
    this.emit('message', { data: JSON.stringify({ type: 'ack', payload: { sessionId: 's', toolNames: [] } }) })
  }
  /** Test-side: the deferred close event finally arrives. */
  finishClosing(): void {
    this.readyState = 3
    this.emit('close', {})
  }
  private emit(type: string, ev: any): void {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
}

type Posted = { url: string; body: any; contentType: string }
let posted: Posted[] = []
/** Status the next POSTs answer with; tests flip it to simulate a lost session. */
let postStatus = 202
/** When set, every POST rejects as a network error instead of answering. */
let postNetworkError = false
/** When set, the next POST waits until the test releases it — lets a test
 * arrange things to happen while a POST is in flight. */
let holdNextPost: { release: (status: number) => void } | null = null
let holdRequested = false

let bridges: AgentBridge[] = []

function newBridge(opts: Partial<ConstructorParameters<typeof AgentBridge>[0]> = {}) {
  const bridge = new AgentBridge({
    url: 'wss://example.test/ws',
    appId: 'test-app',
    apiKey: 'key123',
    transport: 'sse',
    tools: {},
    ...opts,
  })
  bridges.push(bridge)
  return bridge
}

function latest(): FakeEventSource {
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  if (!es) throw new Error('no EventSource was constructed')
  return es
}

/** Lets the bridge's chained fetch() promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function ack(es: FakeEventSource): void {
  es.envelope({ type: 'ack', payload: { sessionId: 's', toolNames: [] } })
}

beforeEach(() => {
  FakeEventSource.instances = []
  DeadWebSocket.instances = []
  AsyncCloseWebSocket.instances = []
  posted = []
  postStatus = 202
  postNetworkError = false
  holdNextPost = null
  holdRequested = false
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      posted.push({
        url,
        body: JSON.parse(String(init.body)),
        contentType: String((init.headers as Record<string, string>)['Content-Type']),
      })
      if (postNetworkError) throw new TypeError('Failed to fetch')
      let status = postStatus
      if (holdRequested) {
        holdRequested = false
        status = await new Promise<number>((resolve, reject) => {
          holdNextPost = { release: resolve }
          // Like a real fetch: an abort rejects the pending request.
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      return { ok: status < 400, status }
    })
  )
  vi.useFakeTimers()
})

afterEach(() => {
  for (const bridge of bridges) bridge.close()
  bridges = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('sse transport', () => {
  it('opens the stream at the derived URL with the api key', () => {
    newBridge()
    expect(latest().url).toBe('https://example.test/sse?token=key123')
  })

  it('honours an explicit sseUrl', () => {
    newBridge({ sseUrl: 'https://other.test/custom/sse' })
    expect(latest().url).toBe('https://other.test/custom/sse?token=key123')
  })

  it('rejects a url it cannot derive an SSE endpoint from', () => {
    expect(() => newBridge({ url: 'wss://example.test/socket' })).toThrow(/sseUrl/)
  })

  it('says hello to the session the stream announced', async () => {
    newBridge()
    latest().session('abc')
    await settle()

    expect(posted).toHaveLength(1)
    expect(posted[0].url).toBe('https://example.test/sse/abc')
    expect(posted[0].body.type).toBe('hello')
    expect(posted[0].body.payload.appId).toBe('test-app')
  })

  it('queues a prompt until ack, then posts it after hello, in order', async () => {
    const bridge = newBridge()
    bridge.prompt('first')
    bridge.prompt('second')
    latest().session('abc')
    await settle()
    expect(posted.map((p) => p.body.type)).toEqual(['hello'])

    ack(latest())
    await settle()
    expect(posted.map((p) => p.body.type)).toEqual(['hello', 'prompt', 'prompt'])
    expect(posted.slice(1).map((p) => p.body.payload.text)).toEqual(['first', 'second'])
  })

  it('answers a tool_query from the stream with a tool_result POST', async () => {
    newBridge({ tools: { get_title: () => 'Hello' } })
    latest().session('abc')
    ack(latest())
    latest().envelope({ type: 'tool_query', requestId: 'q1', payload: { toolName: 'get_title', args: {} } })
    await settle()

    const result = posted.find((p) => p.body.type === 'tool_result')
    expect(result?.body).toMatchObject({
      requestId: 'q1',
      payload: { toolName: 'get_title', ok: true, result: 'Hello' },
    })
  })

  it('delivers assistant messages from the stream', () => {
    const onAssistantMessage = vi.fn()
    newBridge({ onAssistantMessage })
    latest().session('abc')
    latest().envelope({ type: 'assistant_message', payload: { text: 'hi there' } })

    expect(onAssistantMessage).toHaveBeenCalledWith('hi there')
  })

  it('reconnects with a new stream and a fresh hello when the stream breaks', async () => {
    newBridge()
    const first = latest()
    first.session('abc')
    await settle()

    first.fail()
    expect(first.closed).toBe(true)
    vi.runOnlyPendingTimers()
    expect(FakeEventSource.instances).toHaveLength(2)

    latest().session('def')
    await settle()
    expect(posted[posted.length - 1]).toMatchObject({
      url: 'https://example.test/sse/def',
      body: { type: 'hello' },
    })
  })

  it('resends a prompt whose POST was lost, on the next session', async () => {
    const bridge = newBridge()
    latest().session('abc')
    ack(latest())
    await settle()

    postStatus = 404 // the session is gone server-side
    bridge.prompt('important')
    await settle()
    vi.runOnlyPendingTimers()
    expect(FakeEventSource.instances).toHaveLength(2)

    postStatus = 202
    latest().session('def')
    ack(latest())
    await settle()
    const resent = posted.filter((p) => p.url.endsWith('/def') && p.body.type === 'prompt')
    expect(resent.map((p) => p.body.payload.text)).toEqual(['important'])
  })

  it('does not reconnect after close()', () => {
    const bridge = newBridge()
    latest().session('abc')

    bridge.close()
    vi.runOnlyPendingTimers()

    expect(latest().closed).toBe(true)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('posts as text/plain so the browser skips the CORS preflight', async () => {
    newBridge()
    latest().session('abc')
    await settle()

    expect(posted[0].contentType).toMatch(/^text\/plain/)
  })

  it('keeps a query string on an explicit sseUrl when addressing the session', async () => {
    newBridge({ sseUrl: 'https://other.test/sse?region=eu' })
    latest().session('abc')
    await settle()

    const u = new URL(posted[0].url)
    expect(u.pathname).toBe('/sse/abc')
    expect(u.searchParams.get('region')).toBe('eu')
  })

  it('keeps the query string of url when deriving the SSE endpoint', () => {
    newBridge({ url: 'wss://example.test/ws?token=fromurl', apiKey: undefined })
    expect(latest().url).toBe('https://example.test/sse?token=fromurl')
  })

  it('reports a rejected message instead of resending it forever', async () => {
    const onError = vi.fn()
    const bridge = newBridge({ onError })
    latest().session('abc')
    ack(latest())
    await settle()

    postStatus = 413 // e.g. over the server's size limit
    bridge.prompt('too big')
    await settle()
    vi.runOnlyPendingTimers()

    expect(onError).toHaveBeenCalledWith({ message: expect.stringContaining('413') })
    expect(latest().closed).toBe(false) // the session itself is fine
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(posted.filter((p) => p.body.type === 'prompt')).toHaveLength(1)
  })

  it('does not resend a prompt whose POST got no response', async () => {
    const onError = vi.fn()
    const bridge = newBridge({ onError })
    latest().session('abc')
    ack(latest())
    await settle()

    postNetworkError = true // the server may still have received it
    bridge.prompt('maybe sent')
    await settle()
    postNetworkError = false
    vi.runOnlyPendingTimers()
    await settle()

    expect(onError).toHaveBeenCalledWith({ message: expect.stringContaining('not resent') })
    expect(posted.filter((p) => p.body.type === 'prompt')).toHaveLength(1)
  })

  it('resends a lost prompt ahead of prompts queued after it', async () => {
    const bridge = newBridge()
    latest().session('abc')
    ack(latest())
    await settle()

    holdRequested = true
    bridge.prompt('A') // in flight…
    await settle()
    latest().fail() // …the stream breaks…
    bridge.prompt('B') // …B is queued while disconnected…
    holdNextPost!.release(404) // …then A's POST comes back: session gone
    await settle()

    vi.runOnlyPendingTimers()
    latest().session('def')
    ack(latest())
    await settle()
    const onNewSession = posted.filter((p) => p.url.endsWith('/def') && p.body.type === 'prompt')
    expect(onNewSession.map((p) => p.body.payload.text)).toEqual(['A', 'B'])
  })

  it('sends a lost prompt right away when its failure reports in after the next session is up', async () => {
    const bridge = newBridge()
    latest().session('abc')
    ack(latest())
    await settle()

    holdRequested = true
    bridge.prompt('slow') // the old session's POST hangs…
    await settle()
    latest().fail()
    // Past the reconnect backoff only — not to the POST's own timeout,
    // which would abort it before it can come back as a 404.
    vi.advanceTimersByTime(1_000)
    latest().session('def') // …while a new session comes up and acks…
    ack(latest())
    await settle()
    expect(posted.some((p) => p.url.endsWith('/def') && p.body.type === 'prompt')).toBe(false)

    holdNextPost!.release(404) // …and only then does the old POST come back lost
    await settle()
    const resent = posted.filter((p) => p.url.endsWith('/def') && p.body.type === 'prompt')
    expect(resent.map((p) => p.body.payload.text)).toEqual(['slow'])
  })

  it('starts over when the hello POST fails, instead of waiting for an ack that never comes', async () => {
    const onError = vi.fn()
    newBridge({ onError })
    postStatus = 502
    latest().session('abc')
    await settle()

    expect(latest().closed).toBe(true)
    expect(onError).not.toHaveBeenCalled()
    postStatus = 202
    vi.runOnlyPendingTimers()
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('gives up on a stream that never delivers its session event', () => {
    newBridge()
    vi.advanceTimersByTime(15_000) // e.g. a proxy buffering the event stream

    expect(FakeEventSource.instances[0].closed).toBe(true)
    vi.runOnlyPendingTimers()
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('gives up on a session whose ack never arrives', async () => {
    newBridge()
    latest().session('abc')
    await settle()
    vi.advanceTimersByTime(15_000)

    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('does not time out a session once it has replied', async () => {
    newBridge()
    latest().session('abc')
    ack(latest())
    await settle()
    vi.advanceTimersByTime(60_000)

    expect(latest().closed).toBe(false)
  })

  it('aborts a POST that hangs, so later messages are not stuck behind it', async () => {
    const onError = vi.fn()
    const bridge = newBridge({ onError })
    latest().session('abc')
    ack(latest())
    await settle()

    holdRequested = true
    bridge.prompt('hangs')
    await settle()
    vi.advanceTimersByTime(10_000)
    await settle()

    expect(onError).toHaveBeenCalledWith({ message: expect.stringContaining('not resent') })
    expect(latest().closed).toBe(true) // a hanging POST means a broken connection
    vi.runOnlyPendingTimers()
    expect(FakeEventSource.instances).toHaveLength(2)
  })
})

describe('transport callbacks', () => {
  it('ignores a replaced transport closing late', () => {
    vi.stubGlobal('WebSocket', AsyncCloseWebSocket)
    const bridge = newBridge({ transport: 'ws' })
    const first = AsyncCloseWebSocket.instances[0]
    first.open()
    first.ack()

    // Hidden and shown again before the first socket's close event lands.
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    const second = AsyncCloseWebSocket.instances[1]
    second.open()
    second.ack()

    first.finishClosing() // the stale close event
    vi.runOnlyPendingTimers()

    expect(AsyncCloseWebSocket.instances).toHaveLength(2) // no extra connect
    bridge.prompt('still live')
    expect(second.sent.some((s) => s.includes('still live'))).toBe(true)
  })
})

describe('auto transport', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', DeadWebSocket)
  })

  function refuseLatestWs(): void {
    DeadWebSocket.instances[DeadWebSocket.instances.length - 1].refuse()
    vi.runOnlyPendingTimers()
  }

  it('falls back to SSE only after repeated WebSocket attempts never open', () => {
    newBridge({ transport: 'auto' })

    refuseLatestWs()
    refuseLatestWs()
    // Two refusals look like a backend restarting, not a blocked wire.
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(DeadWebSocket.instances).toHaveLength(3)

    refuseLatestWs()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(DeadWebSocket.instances).toHaveLength(3)
  })

  it('does not count a close it caused itself', () => {
    newBridge({ transport: 'auto' })

    for (let i = 0; i < 3; i++) {
      // Page hidden mid-handshake, then shown again.
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      DeadWebSocket.instances[DeadWebSocket.instances.length - 1].refuse()
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    }

    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('does not count attempts made while the browser is offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    newBridge({ transport: 'auto' })

    refuseLatestWs()
    refuseLatestWs()
    refuseLatestWs()

    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('goes back to WebSocket when SSE cannot open either — the server is the problem', () => {
    // Backend down mid-deploy, or refusing the app (403/429): SSE fails
    // exactly like the WebSocket did, so it says nothing about the wire.
    newBridge({ transport: 'auto' })
    refuseLatestWs()
    refuseLatestWs()
    refuseLatestWs()
    expect(FakeEventSource.instances).toHaveLength(1)

    latest().fail() // the SSE trial never opens
    vi.runOnlyPendingTimers()

    expect(DeadWebSocket.instances).toHaveLength(4)
    expect(FakeEventSource.instances).toHaveLength(1)
    // And the count starts over: one more refusal is not enough.
    refuseLatestWs()
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('commits to SSE once an SSE connection actually opens', () => {
    newBridge({ transport: 'auto' })
    refuseLatestWs()
    refuseLatestWs()
    refuseLatestWs()
    latest().session('abc') // the trial works: the wire was the problem

    latest().fail()
    vi.runOnlyPendingTimers()

    expect(FakeEventSource.instances).toHaveLength(2)
    expect(DeadWebSocket.instances).toHaveLength(3)
  })

  it('tries the WebSocket again after staying on SSE for a while', () => {
    newBridge({ transport: 'auto' })
    refuseLatestWs()
    refuseLatestWs()
    refuseLatestWs()
    latest().session('abc')
    ack(latest()) // a healthy session, so the handshake timeout doesn't apply

    vi.advanceTimersByTime(10 * 60_000)
    latest().fail()
    vi.runOnlyPendingTimers()
    expect(DeadWebSocket.instances).toHaveLength(4) // the probe

    refuseLatestWs() // still blocked: straight back to SSE, no new streak
    expect(FakeEventSource.instances).toHaveLength(2)
  })
})
