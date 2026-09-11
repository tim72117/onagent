import { useEffect, useRef, useState } from 'react'
import { AgentBridge, defineTool } from '@onagent/bridge'
import styles from './SupportDemo.module.css'

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
// The chat panel is framed as a phone (.csPhoneDock), floating over the
// light .siteMock backdrop's bottom-right corner — the way a real
// embedded support widget expands from its launcher bubble — rather than
// a flat sidebar panel. This component's module (SupportDemo.module.css)
// is fully distinct from SupportCase.tsx's own (SupportCase.module.css)
// even though both render a support conversation.
//
// .siteMock is the salon's own weekly stylist schedule (styling only for
// now — its slots are static JSX below, not driven by any tool call's
// actual result). The plan is to highlight whichever slot a completed
// check_availability/book_appointment call touched
// (.scheduleSlotHighlight already exists for this), so a visitor can see
// the AI's tool call actually touch "their own" calendar — not wired up
// yet.

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

// Each stylist's color + a simple cartoon-avatar emoji, used on the week
// grid's checkmarks and the legend below (keys match STYLISTS[].name).
const STYLISTS = ['Amy', 'Jordan', 'Priya'] as const
const STYLIST_COLORS: Record<(typeof STYLISTS)[number], string> = {
  Amy: '#2f8a53',
  Jordan: '#3f7cc9',
  Priya: '#c9578f',
}
const STYLIST_AVATARS: Record<(typeof STYLISTS)[number], string> = {
  Amy: '👩‍🦰',
  Jordan: '👨‍🦱',
  Priya: '👩🏽‍🦱',
}

// Mock weekly schedule for siteMock's backdrop — a real calendar-app-style
// grid: TIME_ROWS is the shared time axis running down the far-left
// column, Mon-Sun run across the top as columns, and each (day, time)
// cell holds at most one stylist (single-chair-per-slot, matching a real
// salon's own booking grid — see this file's header comment on the
// eventual highlight wiring), either open or already booked.
const TIME_ROWS = ['10am', '11am', '1pm', '2pm', '3pm'] as const
interface DayCellData {
  stylist: (typeof STYLISTS)[number]
  booked: boolean
}
const WEEK: { day: string; date: number; byTime: Partial<Record<(typeof TIME_ROWS)[number], DayCellData>> }[] = [
  { day: 'Mon', date: 8, byTime: {} },
  {
    day: 'Tue', date: 9, byTime: {
      '10am': { stylist: 'Amy', booked: true },
      '2pm': { stylist: 'Jordan', booked: false },
    },
  },
  {
    day: 'Wed', date: 10, byTime: {
      '11am': { stylist: 'Amy', booked: false },
      '2pm': { stylist: 'Priya', booked: true },
    },
  },
  {
    day: 'Thu', date: 11, byTime: {
      '10am': { stylist: 'Jordan', booked: true },
      '3pm': { stylist: 'Priya', booked: false },
    },
  },
  {
    day: 'Fri', date: 12, byTime: {
      '2pm': { stylist: 'Amy', booked: false },
      '3pm': { stylist: 'Priya', booked: true },
    },
  },
  {
    day: 'Sat', date: 13, byTime: {
      '11am': { stylist: 'Jordan', booked: true },
      '1pm': { stylist: 'Priya', booked: true },
    },
  },
  { day: 'Sun', date: 14, byTime: {} },
]

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
    <div className={styles.supportShell}>
      {/* Backdrop: the salon's own weekly stylist schedule — a plausible
          "why is a support widget embedded in this page" justification,
          and (styling only for now, see this component's header comment)
          the eventual target for highlighting whichever slot a tool call
          actually touched. */}
      <div className={styles.siteMock}>
        <div className={styles.siteMockNav}>
          <div className={styles.siteMockLogo} />
          <span className={styles.siteMockTitleText}>This week</span>
        </div>
        <table className={styles.weekGrid}>
          <thead>
            <tr>
              <th className={styles.timeAxisHead} />
              {WEEK.map((d) => (
                <th key={d.day} className={styles.dayHead}>
                  <div className={styles.dayLabel}>{d.day}</div>
                  <div className={styles.dayDate}>{d.date}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIME_ROWS.map((time) => (
              <tr key={time}>
                <td className={styles.timeAxisCell}>{time}</td>
                {WEEK.map((d) => {
                  const cell = d.byTime[time]
                  return (
                    <td className={styles.dayCell} key={d.day}>
                      {cell && (
                        <span
                          className={styles.dayAvatarWrap}
                          aria-label={`${cell.stylist}${cell.booked ? ' — booked' : ' available'} ${d.day} ${time}`}
                          title={cell.stylist}
                        >
                          {cell.booked && (
                            <span className={styles.bookedBadge} aria-hidden="true">
                              <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
                            </span>
                          )}
                          <span className={styles.dayAvatar} style={{ borderColor: STYLIST_COLORS[cell.stylist] }}>
                            {STYLIST_AVATARS[cell.stylist]}
                          </span>
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className={styles.legend}>
          {STYLISTS.map((name) => (
            <span key={name} className={styles.legendItem}>
              <span className={styles.legendAvatar} style={{ borderColor: STYLIST_COLORS[name] }}>
                {STYLIST_AVATARS[name]}
              </span>
              {name}
            </span>
          ))}
        </div>
      </div>

      {/* The support widget itself — the actual subject of this demo,
          framed as a phone, wired to a real AgentBridge connection. */}
      <div className={styles.csPhoneDock}>
        <div className={styles.csPhoneNotch} />
        <div className={styles.csPanel}>
          <div className={styles.csPanelHeader}>
            <span className={`${styles.csAvatar} ${styles.csAvatarLg}`}>
              <svg viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
            </span>
            <div>
              <div className={styles.csPanelTitle}>Support</div>
              <div className={styles.csPanelSubtitle}><span className={styles.csDot} />Online · usually replies instantly</div>
            </div>
          </div>

          <div className={styles.csPanelThread} ref={threadRef}>
            <div className={styles.csDayDivider}>Today</div>

            {entries.map((entry) =>
              entry.kind === 'tool' ? (
                <div className={styles.csToolCard} key={entry.id}>
                  <div className={styles.csToolHead}>
                    <svg viewBox="0 0 24 24"><path d="M12 8v4l3 3M12 2a10 10 0 100 20 10 10 0 000-20z" /></svg>
                    <span>{entry.name}</span>
                    <span className={styles.csToolStatus}>done</span>
                  </div>
                  {entry.result && (
                    <div className={styles.csToolBody}>
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
                <div className={`${styles.csRow} ${entry.kind === 'user' ? styles.fromUser : styles.fromAi}`} key={entry.id}>
                  <div className={styles.csBubble}>{entry.text}</div>
                </div>
              ),
            )}

            {thinking && (
              <div className={`${styles.csRow} ${styles.fromAi}`}>
                <div className={`${styles.csBubble} ${styles.csThinking}`}>
                  <span /><span /><span />
                </div>
              </div>
            )}
          </div>

          <div className={styles.csPanelInput}>
            <form
              className={styles.csInputRow}
              onSubmit={(e) => {
                e.preventDefault()
                handleSend()
              }}
            >
              <input
                className={styles.csTextarea}
                placeholder={API_KEY ? 'Ask about an order, a return, or anything else…' : 'Demo not wired up (missing API key)'}
                value={input}
                disabled={!API_KEY}
                onChange={(e) => setInput(e.target.value)}
              />
              <button type="submit" className={styles.csSendBtn} disabled={!API_KEY || !input.trim()} aria-label="Send">
                <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </form>
            <div className={styles.csPowered}>Powered by <b>onagent</b></div>
          </div>
        </div>
      </div>
    </div>
  )
}

declare global {
  interface Window {
    dataLayer?: unknown[]
  }
}
