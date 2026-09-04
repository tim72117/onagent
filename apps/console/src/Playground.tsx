import { useEffect, useRef, useState } from 'react'
import { BASE } from './api'
import type { Tool } from './schema'
import styles from './Playground.module.css'

type ConnectionState = 'connecting' | 'open' | 'closed'

interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'tool_call' | 'tool_query' | 'error'
  text: string
}

// Mirrors backend/internal/protocol/message.go's Envelope/*Payload shapes —
// this is now the real wire protocol (see this file's header comment below),
// not a hand-rolled subset, so these types intentionally track that package
// rather than diverging from it.
type MessageType =
  | 'hello'
  | 'ack'
  | 'prompt'
  | 'tool_call'
  | 'tool_query'
  | 'tool_result'
  | 'assistant_message'
  | 'error'

interface Envelope {
  type: MessageType
  requestId?: string
  payload?: unknown
}

interface AckPayload {
  sessionId: string
  toolNames: string[]
}

interface ToolCallPayload {
  toolName: string
  args?: unknown
}

interface ToolResultPayload {
  toolName: string
  ok: boolean
  result?: unknown
  error?: string
}

interface AssistantMessagePayload {
  text: string
}

interface ErrorPayload {
  message: string
  code?: string
}

// How long Playground waits before giving up on a tool_call/tool_query that
// has no mock effect to run (see handleToolMessage below) and sending back
// an explicit ok:false tool_result, rather than staying silent and letting
// the backend's own ~20s AskInteraction timeout (ws/session.go's
// interactionTimeout) fire instead. Deliberately shorter than that timeout —
// the backend's is calibrated for a real page that might just be slow, but
// here we already know with certainty (immediately) that nothing will ever
// answer, so making the developer and the LLM wait the full 20s to learn
// that would be a pointless delay, not extra honesty.
const NO_MOCK_TIMEOUT_MS = 2_000

// How long a mock button stays visibly "clicked" after a matching tool_call
// arrives — long enough to notice, short enough that a burst of tool calls
// (a real click_button tool being called repeatedly) still reads as
// distinct events rather than one stuck-on highlight.
const CLICK_FLASH_MS = 900

// Playground lets a developer test-drive their app's agent from inside the
// console — no real front-end site required.
//
// This used to speak a separate, simpler protocol against a dedicated
// backend endpoint (backend/internal/console/playground.go) that only
// displayed tool_call messages and never answered them. That endpoint now
// reuses the real internal/ws.Session the Agent Bridge SDK talks to (see
// that Go file's updated header comment), so this component follows suit:
// it speaks the same hello/ack handshake and tool_call/tool_query/
// tool_result round trip as packages/bridge/src/client.ts, the real SDK.
//
// The one place Playground is deliberately still different from a real
// integration: there is no actual web page here for a tool_call to act on.
// A handful of tools get a small mock visual effect (see
// TOOL_MOCK_HANDLERS below) — today that's tools built from the "Click a
// fixed button" wizard template (see ToolWizard.tsx's TEMPLATES), which get
// an actual mock button rendered above the transcript, since that
// template's whole point is "click one specific, named button" — simple
// enough to genuinely simulate here, unlike a form fill or a list of
// dynamic items. Anything without a registered mock effect gets an honest
// "no mock effect, waiting to see if it times out" treatment rather than a
// faked success — see handleToolMessage's doc comment for why.
export function Playground({ appId, tools }: { appId: string; tools: Tool[] }) {
  const [state, setState] = useState<ConnectionState>('connecting')
  const [ready, setReady] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [flashedTool, setFlashedTool] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const nextId = useRef(0)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clickButtonTools = tools.filter((t) => t.sourceTemplate === 'click_button')

  // Lets handleToolMessage (bound once at mount, inside the connection
  // effect below) check "is this tool_call's toolName a click-button
  // template tool" without needing the WS message listener rebound every
  // time clickButtonTools changes. Refreshed each render (not inside the
  // connection effect, which intentionally only reconnects when appId
  // changes) so it always reflects the current tools
  // prop without a socket reconnect every time a tool is added/edited.
  const clickButtonNamesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    clickButtonNamesRef.current = new Set(clickButtonTools.map((t) => t.name))
  })

  useEffect(() => {
    setMessages([])
    setState('connecting')
    setReady(false)

    const wsUrl = BASE.replace(/^http/, 'ws') + `/console/apps/${encodeURIComponent(appId)}/playground`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.addEventListener('open', () => {
      setState('open')
      // Mirrors packages/bridge/src/client.ts's own connect(): hello must
      // go first, and nothing else (prompt) is sent until ack comes back
      // with this session's tool set.
      send(ws, 'hello', crypto.randomUUID(), { appId })
    })
    ws.addEventListener('close', () => {
      setState('closed')
      setReady(false)
    })
    ws.addEventListener('error', () => setState('closed'))
    ws.addEventListener('message', (event) => {
      let env: Envelope
      try {
        env = JSON.parse(event.data)
      } catch {
        return
      }

      switch (env.type) {
        case 'ack': {
          // toolNames (env.payload as AckPayload) isn't currently rendered
          // anywhere in this UI — acknowledged only to flip readiness, same
          // as the real SDK's ready flag.
          void (env.payload as AckPayload | undefined)
          setReady(true)
          break
        }
        case 'assistant_message': {
          const text = (env.payload as AssistantMessagePayload | undefined)?.text ?? ''
          appendMessage('assistant', text)
          setSending(false)
          break
        }
        case 'tool_call':
        case 'tool_query': {
          const p = env.payload as ToolCallPayload | undefined
          if (p) handleToolMessage(ws, env.type, env.requestId, p)
          break
        }
        case 'error': {
          const err = env.payload as ErrorPayload | undefined
          appendMessage('error', err?.message ?? 'Unknown error')
          setSending(false)
          break
        }
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

  function send(ws: WebSocket, type: MessageType, requestId: string | undefined, payload: unknown) {
    ws.send(JSON.stringify({ type, requestId, payload } satisfies Envelope))
  }

  // handleToolMessage answers a tool_call (ToolKindAction) or tool_query
  // (ToolKindQuery) the backend is waiting on (see ws.Session.AskInteraction
  // — it blocks the in-flight prompt's inference call until a matching
  // tool_result arrives or its own ~20s timeout fires).
  //
  // Playground has no real page to run these against. For a "click a fixed
  // button" template tool, or a tool with a mock effect registered in
  // TOOL_MOCK_HANDLERS, that effect runs and a genuine ok:true tool_result
  // is sent back immediately. For everything else, this deliberately does
  // NOT fabricate a fake success — that would
  // let the LLM believe an action happened when it didn't, silently
  // corrupting the rest of the conversation. Instead it shows the call and,
  // after a short grace period, sends back an explicit ok:false tool_result
  // ("no mock effect for this tool in Playground") so the LLM gets a clear,
  // truthful answer quickly rather than the developer having to wait out the
  // backend's full interaction timeout to learn the same thing. The grace
  // period exists only so a mock handler that resolves near-instantly still
  // wins the race and reports its own real result first.
  function handleToolMessage(
    ws: WebSocket,
    type: 'tool_call' | 'tool_query',
    requestId: string | undefined,
    payload: ToolCallPayload
  ) {
    appendMessage(type, `${payload.toolName}(${JSON.stringify(payload.args ?? {})})`)

    // "Click a fixed button" template tools get a real visual effect (the
    // mock button below flashes) instead of going through the stateless
    // TOOL_MOCK_HANDLERS map — the effect is inherently per-component state
    // (which button is flashing right now), not something a module-level
    // handler keyed only by tool name could drive.
    if (clickButtonNamesRef.current.has(payload.toolName)) {
      triggerClickFlash(payload.toolName)
      send(ws, 'tool_result', requestId, {
        toolName: payload.toolName,
        ok: true,
        result: { message: `"${payload.toolName}" clicked (simulated)` },
      } satisfies ToolResultPayload)
      return
    }

    const mock = TOOL_MOCK_HANDLERS[payload.toolName]
    if (mock) {
      Promise.resolve(mock(payload.args))
        .then((result) => {
          send(ws, 'tool_result', requestId, {
            toolName: payload.toolName,
            ok: true,
            result: result ?? null,
          } satisfies ToolResultPayload)
        })
        .catch((err: unknown) => {
          send(ws, 'tool_result', requestId, {
            toolName: payload.toolName,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          } satisfies ToolResultPayload)
        })
      return
    }

    appendMessage(
      'error',
      `"${payload.toolName}" has no mock effect in Playground — reporting failure back to the agent shortly.`
    )
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      send(ws, 'tool_result', requestId, {
        toolName: payload.toolName,
        ok: false,
        error: 'no mock effect for this tool in Playground; nothing here can perform it for real',
      } satisfies ToolResultPayload)
    }, NO_MOCK_TIMEOUT_MS)
  }

  function sendPrompt(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || state !== 'open' || !ready || sending) return
    appendMessage('user', text)
    setSending(true)
    // requestId must be globally unique, not just unique within this page
    // load: the backend's Quota.Record uses this session's stable id
    // ("PG-<userID>-<appID>") plus requestId as an idempotency key against
    // usage_events (app_id, event_id). crypto.randomUUID() (not a
    // page-load-scoped counter) keeps prompts from different page loads for
    // the same user+app from ever colliding.
    wsRef.current && send(wsRef.current, 'prompt', crypto.randomUUID(), { text })
    setInput('')
  }

  const connected = state === 'open' && ready

  return (
    <div className="playground">
      <div className="playground-header">
        <span className="micro-label">Playground</span>
        <span className={`playground-status playground-status-${state}`}>
          {state === 'connecting' || (state === 'open' && !ready)
            ? 'Connecting…'
            : state === 'open'
              ? 'Connected'
              : 'Disconnected'}
        </span>
      </div>
      <p className="thought-copy">
        Test prompts against this app's agent without a real site. Most tool calls have no page
        here to act on, so they'll report failure back to the agent — but a fixed-button tool
        gets a real mock button below that lights up when the agent calls it.
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
            {(m.role === 'tool_call' || m.role === 'tool_query') && (
              <span className="playground-msg-label">{m.role === 'tool_call' ? 'tool call' : 'tool query'}</span>
            )}
            {m.role === 'error' && <span className="playground-msg-label">error</span>}
            <span className="playground-msg-text">{m.text}</span>
          </div>
        ))}
        {sending && <div className="playground-msg playground-msg-pending">Thinking…</div>}
      </div>

      <form className="playground-input-row" onSubmit={sendPrompt}>
        <input
          className="playground-input"
          placeholder={connected ? 'Type a prompt…' : 'Connecting…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!connected}
        />
        <button type="submit" className="primary" disabled={!connected || sending || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

// TOOL_MOCK_HANDLERS maps a tool name to a small stateless simulated effect
// Playground can run in place of a real page, so a developer testing a
// common action-shaped tool sees something happen instead of an immediate
// failure. "Click a fixed button" template tools are handled separately,
// directly in handleToolMessage (see clickButtonNamesRef above) — that
// effect needs per-component state (which button is flashing right now),
// which a module-level map keyed only by tool name can't hold. This map is
// for future mock effects that don't need component state; empty for now.
// Add an entry here — keyed by the exact tool name a template produces;
// handleToolMessage already does the race-with-the-timeout wiring needed to
// use it.
const TOOL_MOCK_HANDLERS: Record<string, (args: unknown) => Promise<unknown> | unknown> = {}
