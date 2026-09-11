import { useEffect, useRef, useState } from 'react'
import { AgentBridge, defineTool } from '@onagent/bridge'

// AI customer support agent — the "/support" demo shell. Unlike the old
// static mock this replaced, this is a real, working AgentBridge
// connection to support-app (see .env.example's VITE_SUPPORT_* vars) —
// a visitor can actually type a message and get a real LLM reply, and
// lookup_order's tool call is really dispatched back into this page,
// same mechanism a real developer's own site would use.
//
// lookup_order's "backend" here is a hardcoded mock table (ORDERS below),
// not a real order database — that's the honest boundary of what a public
// marketing demo can safely expose (see also src/marketing-demo/widget.js,
// which mocks its own data the same way) — but the AI's tool-calling
// decision, the WebSocket round trip, and the reply are all real.
//
// The chat panel is framed as a phone (.cs-phone-dock), floating over the
// light .site-mock backdrop's bottom-right corner — the way a real
// embedded support widget expands from its launcher bubble — rather than
// a flat sidebar panel. Classes here are ".cs-*" ("chat shell"), distinct
// from SupportCase.tsx's ".pc-*" ("phone card") even though both render a
// support conversation.

const WS_URL = import.meta.env.VITE_SUPPORT_WS_URL ?? 'wss://onagent.shuttle.tools/ws'
const APP_ID = import.meta.env.VITE_SUPPORT_APP_ID ?? 'support-app'
const API_KEY = import.meta.env.VITE_SUPPORT_API_KEY

// Mock order data lookup_order's handler serves — see this file's header
// comment on why this is fake data, not a real store's database. Any
// order id not in this table still gets a plausible answer (the `default`
// entry) rather than a dead-end "not found", since the point of the demo
// is showing the tool-call round trip, not testing error handling.
const ORDERS: Record<string, { status: string; carrier: string; eta: string }> = {
  '48213': { status: 'in_transit', carrier: 'UPS · 1Z 999 AA1 01', eta: 'Today, by 6:00 pm' },
  default: { status: 'processing', carrier: 'Not yet shipped', eta: 'Within 2-3 business days' },
}

interface ToolCallEntry {
  kind: 'tool'
  id: number
  name: string
  args: Record<string, unknown>
  result?: Record<string, unknown>
}
interface ChatEntry {
  kind: 'user' | 'assistant'
  id: number
  text: string
}
type Entry = ToolCallEntry | ChatEntry

let nextEntryId = 0

export function SupportDemo() {
  const [entries, setEntries] = useState<Entry[]>([
    { kind: 'assistant', id: nextEntryId++, text: "Hi! I'm Acme's assistant. Ask me about orders, returns, or anything on the site." },
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const bridgeRef = useRef<AgentBridge | null>(null)
  const threadRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.dataLayer = window.dataLayer || []
    window.dataLayer.push({ event: 'demo_open', demo_id: 'showcase-support' })
  }, [])

  // Same "unlock the moment the AgentBridge instance is constructed"
  // pattern src/marketing-demo/widget.js's own comment explains — there is
  // no reliable "connection actually succeeded" signal to gate on that
  // doesn't risk a deadlock, so a real connection failure surfaces later,
  // via onError, instead of blocking input upfront.
  useEffect(() => {
    if (!API_KEY) return
    const bridge = new AgentBridge({
      url: WS_URL,
      appId: APP_ID,
      apiKey: API_KEY,
      onAssistantMessage: (text) => {
        setThinking(false)
        setEntries((es) => [...es, { kind: 'assistant', id: nextEntryId++, text }])
      },
      onError: (err) => {
        setThinking(false)
        console.error('[support-demo]', err)
        setEntries((es) => [...es, { kind: 'assistant', id: nextEntryId++, text: "Sorry, something went wrong on my end — I'll get a human to help." }])
      },
      onQuotaExceeded: () => {
        setThinking(false)
        setEntries((es) => [...es, { kind: 'assistant', id: nextEntryId++, text: "This demo has hit its usage limit for now — please check back later." }])
      },
      tools: [
        defineTool(
          'lookup_order',
          (raw) => {
            const args = raw as { order_id?: unknown }
            if (typeof args.order_id !== 'string') throw new Error('order_id is required')
            return { order_id: args.order_id.replace(/^#/, '') }
          },
          ({ order_id }) => {
            const info = ORDERS[order_id] ?? ORDERS.default
            const result = { order_id, ...info }
            setEntries((es) => [...es, { kind: 'tool', id: nextEntryId++, name: 'lookup_order', args: { order_id }, result }])
            return result
          },
        ),
      ],
    })
    bridgeRef.current = bridge
    return () => {
      bridge.close()
      bridgeRef.current = null
    }
    // Runs once on mount — one connection for this component's whole
    // lifetime, matching MarketingDemo.tsx's own single-mount AgentBridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [entries, thinking])

  function handleSend() {
    const text = input.trim()
    if (!text || !bridgeRef.current) return
    setEntries((es) => [...es, { kind: 'user', id: nextEntryId++, text }])
    setInput('')
    setThinking(true)
    bridgeRef.current.prompt(text)
  }

  return (
    <div className="support-shell">
      {/* Backdrop: a generic "customer's own site" — never interactive
          (pointer-events: none in CSS), just enough visual weight to
          justify the floating phone being "embedded" in something. */}
      <div className="site-mock" aria-hidden="true">
        <div className="site-mock-nav">
          <div className="site-mock-logo" />
          <div className="site-mock-links">
            <span className="ph" style={{ width: 48 }} />
            <span className="ph" style={{ width: 60 }} />
            <span className="ph" style={{ width: 40 }} />
          </div>
        </div>
        <div className="site-mock-hero">
          <div className="ph site-mock-title" />
          <span className="ph" style={{ width: '85%' }} />
          <span className="ph" style={{ width: '70%' }} />
          <span className="ph" style={{ width: '60%' }} />
          <div className="site-mock-cards">
            <div className="site-mock-card" />
            <div className="site-mock-card" />
            <div className="site-mock-card" />
          </div>
        </div>
      </div>

      {/* The support widget itself — the actual subject of this demo,
          framed as a phone, wired to a real AgentBridge connection. */}
      <div className="cs-phone-dock">
        <div className="cs-phone-notch" />
        <div className="cs-panel">
          <div className="cs-panel-header">
            <span className="cs-avatar cs-avatar-lg">
              <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
            </span>
            <div>
              <div className="cs-panel-title">Support</div>
              <div className="cs-panel-subtitle"><span className="cs-dot" />Online · usually replies instantly</div>
            </div>
          </div>

          <div className="cs-panel-thread" ref={threadRef}>
            <div className="cs-day-divider">Today</div>

            {entries.map((entry) =>
              entry.kind === 'tool' ? (
                <div className="cs-tool-card" key={entry.id}>
                  <div className="cs-tool-head">
                    <svg viewBox="0 0 24 24"><path d="M12 8v4l3 3M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
                    <span>{entry.name}</span>
                    <span className="cs-tool-status">done</span>
                  </div>
                  {entry.result && (
                    <div className="cs-tool-body">
                      {Object.entries(entry.result).map(([k, v]) => (
                        <>
                          <span key={`${entry.id}-${k}-key`}>{k}</span>
                          <span key={`${entry.id}-${k}-val`}>{String(v)}</span>
                        </>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className={`cs-row ${entry.kind === 'user' ? 'from-user' : 'from-ai'}`} key={entry.id}>
                  <div className="cs-bubble">{entry.text}</div>
                </div>
              ),
            )}

            {thinking && (
              <div className="cs-row from-ai">
                <div className="cs-bubble cs-thinking">
                  <span /><span /><span />
                </div>
              </div>
            )}
          </div>

          <div className="cs-panel-input">
            <form
              className="cs-input-row"
              onSubmit={(e) => {
                e.preventDefault()
                handleSend()
              }}
            >
              <input
                className="cs-textarea"
                placeholder={API_KEY ? 'Ask about an order, a return, or anything else…' : 'Demo not wired up (missing API key)'}
                value={input}
                disabled={!API_KEY}
                onChange={(e) => setInput(e.target.value)}
              />
              <button type="submit" className="cs-send-btn" disabled={!API_KEY || !input.trim()} aria-label="Send">
                <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </form>
            <div className="cs-powered">Powered by <b>onagent</b></div>
          </div>
        </div>
      </div>
    </div>
  )
}
