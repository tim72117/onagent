import { BASE } from './api'
import { randomRequestId } from './randomRequestId'

// Shared wire-protocol layer for backend/internal/console/playground.go's
// WebSocket endpoint — connection setup, the hello/ack handshake, and
// message parsing/dispatch, factored out of Playground.tsx and
// aiToolGenerator.ts, which used to each hand-roll their own copy of this
// exact logic. That duplication is what let aiToolGenerator.ts's protocol
// assumptions drift out of sync with the real wire format (it once listened
// for the wrong message type — see docs/audit-functional.md) without
// Playground.tsx's already-correct handling of the same wire format ever
// catching the mistake.
//
// Deliberately NOT responsible for a connection's lifecycle (when to open,
// when to close, whether to reconnect) — that varies by caller and must
// stay that way: Playground.tsx opens one connection per selected app and
// keeps it alive across the whole editing session (a stable backend
// sessionID, "PG-<userID>-<appID>", so the conversation persists across
// reconnects/reloads); aiToolGenerator.ts opens a brand-new connection per
// "Generate" click and closes it the moment that one request finishes (the
// backend appends a random suffix to sessionID specifically for
// appId === "tool-builder", so each Generate attempt gets its own
// stateless orchestrator instead of accumulating unrelated conversation
// history — see playground.go's ResolveApp doc comment). This module only
// ever sees "here is a WebSocket, wire it up" — it never decides to create
// or destroy one, so it can't accidentally couple the two callers' very
// different session lifecycles together.

// Mirrors backend/internal/protocol/message.go's Envelope/*Payload shapes —
// this is the real wire protocol (see Playground.tsx's own former header
// comment on why), not a hand-rolled subset, so these types intentionally
// track that package rather than diverging from it.
export type MessageType =
  | 'hello'
  | 'ack'
  | 'prompt'
  | 'tool_call'
  | 'tool_query'
  | 'tool_result'
  | 'assistant_message'
  | 'error'

export interface Envelope {
  type: MessageType
  requestId?: string
  payload?: unknown
}

export interface AckPayload {
  sessionId: string
  toolNames: string[]
}

export interface ToolCallPayload {
  toolName: string
  args?: unknown
}

export interface ToolResultPayload {
  toolName: string
  ok: boolean
  result?: unknown
  error?: string
}

export interface AssistantMessagePayload {
  text: string
}

export interface ErrorPayload {
  message: string
  code?: string
}

export function playgroundWsUrl(appId: string): string {
  return BASE.replace(/^http/, 'ws') + `/console/apps/${encodeURIComponent(appId)}/playground`
}

export function send(ws: WebSocket, type: MessageType, requestId: string | undefined, payload: unknown) {
  ws.send(JSON.stringify({ type, requestId, payload } satisfies Envelope))
}

// Connects, sends hello, and dispatches every subsequent message to the
// matching handler below — the exact hello-then-wait-for-ack sequence
// packages/bridge/src/client.ts's real SDK uses, so both console callers
// keep tracking that as the source of truth rather than each guessing at
// it independently. Handlers are optional: a caller that doesn't care about
// (say) assistant_message just omits it. onOpen/onAck/onToolMessage/
// onAssistantMessage/onError/onClose all receive the live WebSocket where
// relevant, so a handler can itself call send() to reply (e.g. a
// tool_result) without this module needing to know anything about what a
// reply should contain.
export function connectPlayground(
  appId: string,
  handlers: {
    onOpen?: (ws: WebSocket) => void
    onAck?: (payload: AckPayload | undefined) => void
    onToolMessage?: (ws: WebSocket, type: 'tool_call' | 'tool_query', requestId: string | undefined, payload: ToolCallPayload) => void
    onAssistantMessage?: (payload: AssistantMessagePayload | undefined) => void
    onError?: (payload: ErrorPayload | undefined) => void
    onClose?: () => void
    // Fired on the WebSocket's own 'error' event (a connection-level
    // failure, e.g. it never opened) — distinct from onError above, which
    // is the backend's in-protocol {type:'error'} message on an
    // already-open connection.
    onConnectionError?: () => void
  },
): WebSocket {
  const ws = new WebSocket(playgroundWsUrl(appId))

  ws.addEventListener('open', () => {
    // Mirrors packages/bridge/src/client.ts's own connect(): hello must go
    // first, and nothing else (prompt) is sent until ack comes back with
    // this session's tool set.
    send(ws, 'hello', randomRequestId(), { appId })
    handlers.onOpen?.(ws)
  })

  ws.addEventListener('close', () => handlers.onClose?.())
  ws.addEventListener('error', () => handlers.onConnectionError?.())

  ws.addEventListener('message', (event) => {
    let env: Envelope
    try {
      env = JSON.parse(event.data)
    } catch {
      return
    }

    switch (env.type) {
      case 'ack':
        handlers.onAck?.(env.payload as AckPayload | undefined)
        break
      case 'assistant_message':
        handlers.onAssistantMessage?.(env.payload as AssistantMessagePayload | undefined)
        break
      case 'tool_call':
      case 'tool_query': {
        const p = env.payload as ToolCallPayload | undefined
        if (p) handlers.onToolMessage?.(ws, env.type, env.requestId, p)
        break
      }
      case 'error':
        handlers.onError?.(env.payload as ErrorPayload | undefined)
        break
    }
  })

  return ws
}
