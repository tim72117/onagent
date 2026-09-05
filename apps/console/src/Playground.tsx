import { useEffect, useRef, useState } from 'react'
import { BASE } from './api'
import type { Tool } from './schema'
import { MOCK_TEMPLATE_KEYS, useMockRuntimes } from './playgroundMocks'
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
// Tools built from certain ToolWizard templates get a small mock effect
// instead (see the playgroundMocks/ package) — a fixed, real UI (mock
// buttons, mock inputs, …) that a human tester can operate directly and
// that a matching tool_call operates too, through the exact same code
// path (see each template's useXxxMock for its "two triggers, one real
// effect" implementation). tool_result's ok is derived from observing
// whether the effect actually took hold, never assumed — see
// handleToolMessage's doc comment. A tool whose template has no
// registered mock (or a call naming a target Playground didn't prepare
// for) gets an honest "no mock effect" failure rather than a fabricated
// success.
export function Playground({ appId, tools }: { appId: string; tools: Tool[] }) {
  const [state, setState] = useState<ConnectionState>('connecting')
  const [ready, setReady] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const nextId = useRef(0)
  const transcriptRef = useRef<HTMLDivElement>(null)

  // One runtime per registered template mock (see playgroundMocks/) —
  // Playground never inspects a runtime's internals, only calls its
  // render()/invoke(). Kept out of a ref: mockRuntimes itself doesn't
  // change identity across renders in a way handleToolMessage needs to
  // chase (see mockRuntimesRef below, which handles that).
  const mockRuntimes = useMockRuntimes(tools)
  const mockRuntimesRef = useRef(mockRuntimes)
  mockRuntimesRef.current = mockRuntimes

  // Which registered-mock templates have at least one matching tool in
  // this app — determines which mock UI blocks render in the left rail.
  // Order comes from MOCK_TEMPLATE_KEYS, not tools' own order, so the
  // rail's layout is stable regardless of how tools are arranged.
  const activeTemplateKeys = MOCK_TEMPLATE_KEYS.filter((key) =>
    tools.some((t) => t.sourceTemplate === key),
  )

  // Lets handleToolMessage (bound once at mount, inside the connection
  // effect below) look up "which registered template, if any, was this
  // tool_call's toolName built from" without needing the WS message
  // listener rebound every time tools changes. Refreshed each render (not
  // inside the connection effect, which intentionally only reconnects
  // when appId changes) so it always reflects the current tools prop
  // without a socket reconnect every time a tool is added/edited.
  const toolTemplateRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const next = new Map<string, string>()
    for (const t of tools) {
      if (t.sourceTemplate && t.sourceTemplate in mockRuntimes) next.set(t.name, t.sourceTemplate)
    }
    toolTemplateRef.current = next
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
  // Playground has no real page to run these against. If payload.toolName
  // was built from a template with a registered mock (see
  // playgroundMocks/), that mock's invoke() runs its real effect and
  // reports what it actually observed — ok is derived from that
  // observation, never assumed (see each useXxxMock's own invoke doc
  // comment). Playground itself doesn't know or care which template that
  // was, or what shape its arguments take — it's purely a toolName →
  // templateKey → runtime lookup (see toolTemplateRef/mockRuntimesRef).
  // For everything else, this deliberately does NOT fabricate a fake
  // success — that would let the LLM believe an action happened when it
  // didn't, silently corrupting the rest of the conversation. Instead it
  // shows the call and, after a short grace period, sends back an
  // explicit ok:false tool_result ("no mock effect for this tool in
  // Playground") so the LLM gets a clear, truthful answer quickly rather
  // than the developer having to wait out the backend's full interaction
  // timeout to learn the same thing.
  function handleToolMessage(
    ws: WebSocket,
    type: 'tool_call' | 'tool_query',
    requestId: string | undefined,
    payload: ToolCallPayload
  ) {
    appendMessage(type, `${payload.toolName}(${JSON.stringify(payload.args ?? {})})`)

    const templateKey = toolTemplateRef.current.get(payload.toolName)
    const runtime = templateKey ? mockRuntimesRef.current[templateKey] : undefined
    if (runtime) {
      const outcome = runtime.invoke(payload.args)
      send(ws, 'tool_result', requestId, { toolName: payload.toolName, ...outcome } satisfies ToolResultPayload)
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
        here to act on, so they'll report failure back to the agent — but some templates (a
        click-a-button tool, a fill-a-form-field tool) get real mock controls below that respond
        when the agent calls them. You can operate them yourself too — same controls, same
        effect.
      </p>

      <div className={styles.body}>
        {activeTemplateKeys.length > 0 && (
          <div className={styles.mockRail}>
            {activeTemplateKeys.map((key) => (
              <div key={key}>{mockRuntimes[key].render()}</div>
            ))}
          </div>
        )}

        <div className={styles.main}>
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
      </div>
    </div>
  )
}
