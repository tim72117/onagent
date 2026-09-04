import { useEffect, useRef, useState } from 'react'
import { BASE } from './api'
import type { Tool } from './schema'
import styles from './Playground.module.css'

type ConnectionState = 'connecting' | 'open' | 'closed'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'tool_call' | 'error'
  text: string
}

interface PlaygroundEnvelope {
  type: 'prompt' | 'tool_call' | 'assistant_message' | 'error'
  requestId?: string
  payload?: unknown
}

// How long a mock button stays visibly "clicked" after a matching tool_call
// arrives — long enough to notice, short enough that a burst of tool calls
// (a real click_button tool being called repeatedly) still reads as
// distinct events rather than one stuck-on highlight.
const CLICK_FLASH_MS = 900

// Playground lets a developer test-drive their app's agent from inside the
// console — no real front-end site required. It talks to a dedicated,
// simpler WS endpoint (backend/internal/console/playground.go) rather than
// the one AgentBridge/real sites use: auth is the developer's own console
// session (not an API key the console doesn't even hold in plaintext), and
// there's no Origin/allowedOrigin check to satisfy since this never leaves
// the console's own origin.
//
// tool_call results are logged as plain text below, not executed — there's
// no real DOM here for a tool to act on in general. The one exception:
// tools built from the "Click a fixed button" wizard template (see
// ToolWizard.tsx's TEMPLATES) get an actual mock button rendered above the
// transcript, since that template's whole point is "click one specific,
// named button" — simple enough to genuinely simulate here, unlike a form
// fill or a list of dynamic items. Other templates still only log; this is
// deliberately a first step, not full simulation for every tool shape.
export function Playground({ appId, tools }: { appId: string; tools: Tool[] }) {
  const [state, setState] = useState<ConnectionState>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [flashedTool, setFlashedTool] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const nextId = useRef(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clickButtonTools = tools.filter((t) => t.sourceTemplate === 'click_button')

  // SDK-style dispatch: tool_call.toolName is looked up in a handler map,
  // the same shape AgentBridgeOptions.tools takes (packages/bridge/src/
  // client.ts) — a name with no registered handler logs a warning instead
  // of silently doing nothing, mirroring the real SDK's validateHandlers.
  // Only "click fixed button" tools have a real handler today; every tool
  // call still reaches the transcript log below regardless, just without a
  // handler to also run if it's some other template.
  //
  // Kept in a ref, refreshed every render (not inside the connection
  // effect, which intentionally only reconnects when appId changes) so the
  // WS message listener — bound once at mount — always dispatches through
  // whatever the current tools prop is, without needing a socket reconnect
  // every time a tool is added/edited.
  const toolHandlersRef = useRef<Record<string, (args: unknown) => void>>({})
  useEffect(() => {
    toolHandlersRef.current = Object.fromEntries(
      clickButtonTools.map((t) => [t.name, () => triggerClickFlash(t.name)]),
    )
  })

  useEffect(() => {
    setMessages([])
    setState('connecting')

    const wsUrl = BASE.replace(/^http/, 'ws') + `/console/apps/${encodeURIComponent(appId)}/playground`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.addEventListener('open', () => setState('open'))
    ws.addEventListener('close', () => setState('closed'))
    ws.addEventListener('error', () => setState('closed'))
    ws.addEventListener('message', (event) => {
      let env: PlaygroundEnvelope
      try {
        env = JSON.parse(event.data)
      } catch {
        return
      }
      if (env.type === 'assistant_message') {
        const text = (env.payload as { text: string } | undefined)?.text ?? ''
        appendMessage('assistant', text)
        setSending(false)
      } else if (env.type === 'tool_call') {
        const p = env.payload as { toolName: string; args: unknown } | undefined
        appendMessage('tool_call', `${p?.toolName ?? '?'}(${JSON.stringify(p?.args ?? {})})`)
        // Unlike the real SDK's validateHandlers, a missing entry here
        // isn't warned about — most templates genuinely have no mock
        // handler yet (see toolHandlersRef's comment), so "no handler
        // registered" would read as a developer mistake when it's actually
        // just an unimplemented Playground visualization.
        if (p?.toolName) toolHandlersRef.current[p.toolName]?.(p.args)
      } else if (env.type === 'error') {
        const text = (env.payload as { message: string } | undefined)?.message ?? 'Unknown error'
        appendMessage('error', text)
        setSending(false)
      }
    })

    return () => ws.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only when the app changes, not on every render
  }, [appId])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [messages])

  // Clears any pending flash timer on unmount so it doesn't fire setState
  // after this component is gone.
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
  }, [])

  function triggerClickFlash(toolName: string) {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlashedTool(toolName)
    flashTimerRef.current = setTimeout(() => setFlashedTool(null), CLICK_FLASH_MS)
  }

  function appendMessage(role: ChatMessage['role'], text: string) {
    setMessages((cur) => [...cur, { id: nextId.current++, role, text }])
  }

  function send(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || state !== 'open' || sending) return
    appendMessage('user', text)
    setSending(true)
    // requestId must be globally unique, not just unique within this page
    // load: the backend's Quota.Record uses sessionID+":"+requestId as an
    // idempotency key against usage_events (app_id, event_id), and
    // sessionID ("PG-<userID>-<appID>") is the same string across every
    // page load for a given user+app. Reusing nextId.current here (a
    // useRef that resets to 0 on every mount, i.e. every page refresh)
    // collided with the exact same event_id from a previous page load —
    // silently swallowed by that idempotency check, so the prompt got a
    // real response but never counted against quota.
    wsRef.current?.send(JSON.stringify({ type: 'prompt', requestId: crypto.randomUUID(), payload: { text } }))
    setInput('')
  }

  return (
    <div className="playground">
      <div className="playground-header">
        <span className="micro-label">Playground</span>
        <span className={`playground-status playground-status-${state}`}>
          {state === 'connecting' ? 'Connecting…' : state === 'open' ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      <p className="thought-copy">
        Test prompts against this app's agent without a real site. Most tool calls are shown, not
        executed — there's no page here for them to act on — but a fixed-button tool gets a real
        mock button below that lights up when the agent calls it.
      </p>

      {clickButtonTools.length > 0 && (
        <div className={styles.mockButtons}>
          {clickButtonTools.map((t) => (
            <button
              key={t.name}
              type="button"
              className={t.name === flashedTool ? `${styles.mockButton} ${styles.mockButtonClicked}` : styles.mockButton}
              disabled
              title={t.description}
            >
              {t.description || t.name}
            </button>
          ))}
        </div>
      )}

      <div className="playground-transcript" ref={transcriptRef}>
        {messages.length === 0 && (
          <p className="sidebar-empty playground-empty">Send a prompt to see how the agent responds.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`playground-msg playground-msg-${m.role}`}>
            {m.role === 'tool_call' && <span className="playground-msg-label">tool call</span>}
            {m.role === 'error' && <span className="playground-msg-label">error</span>}
            <span className="playground-msg-text">{m.text}</span>
          </div>
        ))}
        {sending && <div className="playground-msg playground-msg-pending">Thinking…</div>}
      </div>

      <form className="playground-input-row" onSubmit={send}>
        <input
          className="playground-input"
          placeholder={state === 'open' ? 'Type a prompt…' : 'Connecting…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={state !== 'open'}
        />
        <button type="submit" className="primary" disabled={state !== 'open' || sending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}
