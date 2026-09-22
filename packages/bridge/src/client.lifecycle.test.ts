import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBridge } from './client'

// Connection lifecycle: when the bridge opens a socket, when it closes one,
// and when it declines to reopen. A WebSocket is an open request for its
// whole lifetime, so these rules are what stop an unattended page from
// pinning a backend instance indefinitely — see AgentBridgeOptions'
// disconnectWhenHidden/lazyConnect docs.

/** Minimal controllable WebSocket. jsdom has no implementation, and a real
 *  one would need a server; tests drive open/close by hand instead. */
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  /** Every socket constructed, in order, so a test can assert how many
   *  connections were opened, not merely that one was. */
  static instances: FakeWebSocket[] = []

  readyState: number = FakeWebSocket.CONNECTING
  sent: string[] = []
  readonly url: string
  private listeners: Record<string, ((ev: any) => void)[]> = {}

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (ev: any) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  /** Test-side: complete the handshake. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open', {})
  }

  /** Test-side: the backend (or a request-duration cap) dropped us. */
  dropFromServer(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', {})
  }

  /** Test-side: the backend's reply to `hello`. The bridge treats this,
   *  not the socket opening, as the point it may send queued messages. */
  ack(): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'ack',
        payload: { sessionId: 'test-session', toolNames: [] },
      }),
    })
  }

  private emit(type: string, ev: any): void {
    for (const fn of this.listeners[type] ?? []) fn(ev)
  }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  // jsdom's visibilityState is a getter with no setter.
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** Bridges created by the running test, closed in afterEach. A bridge
 *  listens on the shared document for as long as it is open, so one left
 *  alive would keep reacting to the next test's visibility changes. */
let bridges: AgentBridge[] = []

function newBridge(opts: Partial<ConstructorParameters<typeof AgentBridge>[0]> = {}) {
  const bridge = new AgentBridge({
    url: 'wss://example.test/ws',
    appId: 'test-app',
    tools: {},
    ...opts,
  })
  bridges.push(bridge)
  return bridge
}

/** The socket the bridge most recently constructed. */
function latest(): FakeWebSocket {
  // Indexed rather than .at(-1): tsconfig's lib target predates Array.at.
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  if (!ws) throw new Error('no socket was constructed')
  return ws
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  setVisibility('visible')
  vi.useFakeTimers()
})

afterEach(() => {
  for (const bridge of bridges) bridge.close()
  bridges = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('default connection behaviour', () => {
  it('connects on construction', () => {
    newBridge()

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(latest().url).toContain('wss://example.test/ws')
  })

  it('reconnects after the server drops the connection', () => {
    newBridge()
    latest().open()

    latest().dropFromServer()
    vi.runOnlyPendingTimers()

    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('does not reconnect after close()', () => {
    const bridge = newBridge()
    latest().open()

    bridge.close()
    vi.runOnlyPendingTimers()

    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

describe('disconnectWhenHidden', () => {
  it('closes the socket when the page is hidden', () => {
    newBridge()
    latest().open()
    const ws = latest()

    setVisibility('hidden')

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('does not reconnect while hidden', () => {
    newBridge()
    latest().open()

    setVisibility('hidden')
    // A reconnect scheduled despite the deliberate close would fire here.
    vi.runOnlyPendingTimers()

    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reopens when the page becomes visible again', () => {
    newBridge()
    latest().open()

    setVisibility('hidden')
    setVisibility('visible')

    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('stays connected while hidden when disabled', () => {
    newBridge({ disconnectWhenHidden: false })
    latest().open()
    const ws = latest()

    setVisibility('hidden')

    expect(ws.readyState).toBe(FakeWebSocket.OPEN)
  })
})

describe('lazyConnect', () => {
  it('does not connect on construction', () => {
    newBridge({ lazyConnect: true })

    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('connects on the first prompt', () => {
    const bridge = newBridge({ lazyConnect: true })

    bridge.prompt('hello')

    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('flushes a prompt queued before the socket opened', () => {
    const bridge = newBridge({ lazyConnect: true })

    bridge.prompt('hello')
    latest().open()
    latest().ack()

    const prompts = latest().sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].payload.text).toBe('hello')
  })

  it('opens only one socket for several prompts sent before connecting', () => {
    const bridge = newBridge({ lazyConnect: true })

    bridge.prompt('one')
    bridge.prompt('two')

    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('stays closed when an unused page is merely shown', () => {
    newBridge({ lazyConnect: true })

    setVisibility('hidden')
    setVisibility('visible')

    // Showing a page is not a reason to open a connection the caller
    // deliberately deferred — only an actual send is.
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('reopens on return for a page that had been used', () => {
    const bridge = newBridge({ lazyConnect: true })
    bridge.prompt('hello')
    latest().open()

    setVisibility('hidden')
    setVisibility('visible')

    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('defers connecting for a prompt sent while hidden', () => {
    const bridge = newBridge({ lazyConnect: true })

    setVisibility('hidden')
    bridge.prompt('hello')

    // Connecting from a hidden page would reinstate exactly the always-on
    // connection this is meant to avoid; the queue waits for the return.
    expect(FakeWebSocket.instances).toHaveLength(0)

    setVisibility('visible')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
