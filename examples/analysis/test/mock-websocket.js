// Minimal fake WebSocket implementing just what AgentBridge (packages/bridge
// /src/client.ts) actually touches: addEventListener, send, close,
// readyState, and the static OPEN constant. Installed as globalThis.WebSocket
// before a test creates an AgentBridge, so `new WebSocket(url)` inside the
// real, unmodified SDK picks this up transparently — AgentBridge itself is
// never mocked, only its transport.
//
// The point of faking the transport instead of stubbing AgentBridge's own
// methods is to drive a message into the SDK exactly like a real server
// would — by firing a "message" event — rather than calling some internal
// method that bypasses the real dispatch/parsing path this is meant to
// test.
export class MockWebSocket {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3

    // Every constructed instance is pushed here so test code can reach
    // "the" instance a component under test created, without the test
    // needing its own reference passed through.
    static instances = []

    constructor(url) {
        this.url = url
        this.readyState = MockWebSocket.CONNECTING
        this.sent = []
        this.listeners = { open: [], message: [], close: [], error: [] }
        MockWebSocket.instances.push(this)
    }

    addEventListener(type, handler) {
        this.listeners[type]?.push(handler)
    }

    send(data) {
        this.sent.push(data)
    }

    close() {
        this.readyState = MockWebSocket.CLOSED
        this._emit('close', {})
    }

    // --- test-only helpers below; not part of the real WebSocket API ---

    /** Simulate the connection succeeding: flips readyState open and fires "open". */
    simulateOpen() {
        this.readyState = MockWebSocket.OPEN
        this._emit('open', {})
    }

    /** Simulate the server sending one Envelope (see backend/internal/protocol). */
    simulateMessage(envelope) {
        this._emit('message', { data: JSON.stringify(envelope) })
    }

    /** Parses every sent message back out of JSON, in send order. */
    sentEnvelopes() {
        return this.sent.map((raw) => JSON.parse(raw))
    }

    _emit(type, event) {
        for (const handler of this.listeners[type] ?? []) handler(event)
    }
}
