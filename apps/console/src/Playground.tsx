import { useEffect, useRef, useState } from 'react'
import { BASE } from './api'

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

// Playground lets a developer test-drive their app's agent from inside the
// console — no real front-end site required. It talks to a dedicated,
// simpler WS endpoint (backend/internal/console/playground.go) rather than
// the one AgentBridge/real sites use: auth is the developer's own console
// session (not an API key the console doesn't even hold in plaintext), and
// there's no Origin/allowedOrigin check to satisfy since this never leaves
// the console's own origin.
//
// tool_call results are displayed, not executed — there's no real DOM here
// for a tool to act on. That's the one behavioral difference from a real
// integration worth calling out to the developer (see the hint text below
// the transcript).
export function Playground({ appId }: { appId: string }) {
  const [state, setState] = useState<ConnectionState>('connecting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const nextId = useRef(0)
  const transcriptRef = useRef<HTMLDivElement>(null)

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

  function appendMessage(role: ChatMessage['role'], text: string) {
    setMessages((cur) => [...cur, { id: nextId.current++, role, text }])
  }

  function send(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || state !== 'open' || sending) return
    appendMessage('user', text)
    setSending(true)
    wsRef.current?.send(JSON.stringify({ type: 'prompt', requestId: String(nextId.current), payload: { text } }))
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
        Test prompts against this app's agent without a real site. Tool calls are shown, not
        executed — there's no page here for them to act on.
      </p>

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
