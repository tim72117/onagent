import type { Tool } from './schema'
import { connectPlayground, send } from './playgroundProtocol'
import type { ToolCallPayload } from './playgroundProtocol'
import { randomRequestId } from './randomRequestId'

// Talks to the *existing* Playground WebSocket endpoint
// (backend/internal/console/playground.go) via playgroundProtocol.ts's
// shared connection/handshake/dispatch logic — the same hello, wait for
// ack, prompt, then answer the resulting tool_call round trip
// Playground.tsx uses, rather than adding any new backend endpoint or
// hand-rolling a second copy of that protocol handling (see
// playgroundProtocol.ts's own header comment on why that used to be two
// independently-maintained implementations). tool-builder's only tool is
// propose_tool (kind: action, per
// backend/internal/console/tool-builder-tools.yaml: its acknowledgement is
// never reasoned about further, so it's fire-and-forget, not a blocking
// query — see toolschema.Tool.Kind's doc comment). Fire-and-forget still
// means the backend's ws.Session.AskInteraction blocks waiting for a
// tool_result regardless of Kind, same as Playground.tsx's own
// handleToolMessage documents, so this always sends one back — it's just
// that nothing feeds the *content* of that result back into the LLM.
//
// This module opens a brand-new connection per generateToolFromDescription
// call and closes it as soon as that one request finishes — unlike
// Playground.tsx's stable, reused-across-reconnects connection. That
// difference lives entirely on the backend (playground.go's ResolveApp
// gives tool-builder's sessionID a random suffix per connection, precisely
// because each Generate attempt must be stateless) and in which of these
// two files decides when to open/close a WebSocket; playgroundProtocol.ts
// itself is agnostic to either lifecycle, so sharing it doesn't risk
// accidentally sharing a session between the two.
//
// TOOL_BUILDER_APP_ID is still hardcoded/shared, not yet provisioned per
// user or hidden from the normal app list.
const TOOL_BUILDER_APP_ID = 'tool-builder'

interface ProposeToolArgs {
  name?: unknown
  description?: unknown
  parameters?: unknown
  returns?: unknown
  kind?: unknown
}

function isProposeToolArgs(v: unknown): v is ProposeToolArgs {
  return typeof v === 'object' && v !== null
}

// Trusts the LLM's output shape rather than deeply validating it — this is
// a spike, and the result lands in ToolEditSheet for the developer to
// review/fix before Save anyway (App.tsx's validateApp catches anything
// actually wrong before it can be saved). Only guards against outright
// missing name/description/parameters, since Tool requires those.
function toTool(args: ProposeToolArgs): Tool | null {
  if (typeof args.name !== 'string' || typeof args.description !== 'string') return null
  if (typeof args.parameters !== 'object' || args.parameters === null) return null
  // Falls back to undefined (-> 'action', the backend's own default) for
  // anything other than exactly 'action'/'query' — an LLM mis-typing this
  // enum should degrade to the safe default, not smuggle an invalid string
  // through to a save. See docs/audit-functional.md's 2026-09-11 entry for
  // why silently defaulting to 'action' here (rather than, say, failing
  // toTool outright) is the same behavior a human editing this tool by
  // hand would get from the backend either way.
  const kind = args.kind === 'action' || args.kind === 'query' ? args.kind : undefined
  return {
    name: args.name,
    description: args.description,
    parameters: args.parameters as Tool['parameters'],
    returns: (args.returns as Tool['returns'] | undefined) ?? undefined,
    kind,
  }
}

// What the AI actually did with the description, for the caller to render:
// either it proposed a tool (the happy path), or it responded with plain
// text instead of calling propose_tool — tool-builder's own Thought asks it
// to always call the tool, but a vague description can still lead it to
// ask a clarifying question in plain text rather than comply. Surfacing
// that text (rather than treating it as a silent non-event) is what lets a
// caller stop waiting and show the developer *why* nothing was proposed,
// instead of only finding out via the 30s timeout below.
export type GenerateResult = { kind: 'tool'; tool: Tool } | { kind: 'message'; text: string }

// Rejects after 30s only if the AI produces NEITHER a tool_call nor any
// assistant text — mirrors the backend's own completeTimeout
// (internal/inference/want.go) at the same order of magnitude, so a
// genuinely hung request (no response of any kind) fails on its own rather
// than leaving the caller's "generating…" state stuck forever. Any actual
// response — a proposed tool, or plain text — resolves immediately instead
// of waiting out the rest of this timer.
export function generateToolFromDescription(description: string): Promise<GenerateResult> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null
    const timer = setTimeout(() => {
      ws?.close()
      reject(new Error('Timed out waiting for a response from the AI.'))
    }, 30_000)

    function finish(result: { ok: true; value: GenerateResult } | { ok: false; error: Error }) {
      clearTimeout(timer)
      ws?.close()
      if (result.ok) resolve(result.value)
      else reject(result.error)
    }

    ws = connectPlayground(TOOL_BUILDER_APP_ID, {
      onAck: () => {
        // requestId must be globally unique — see Playground.tsx's own
        // sendPrompt comment: the backend's Quota.Record uses this
        // session's id plus requestId as a usage_events idempotency key.
        if (ws) send(ws, 'prompt', randomRequestId(), { text: description })
      },
      onToolMessage: (socket, _type, requestId, payload: ToolCallPayload) => {
        if (payload.toolName !== 'propose_tool') return

        // See this module's header comment — a tool_result is always
        // expected regardless of Kind, even though propose_tool's own
        // result content is never read by anything.
        send(socket, 'tool_result', requestId, { toolName: 'propose_tool', ok: true })

        const args = payload.args
        const tool = isProposeToolArgs(args) ? toTool(args) : null
        if (tool) finish({ ok: true, value: { kind: 'tool', tool } })
        else finish({ ok: false, error: new Error('The AI’s response was missing required fields.') })
      },
      // The AI chose to respond with plain text instead of calling
      // propose_tool (see this function's doc comment) — surface it and
      // stop waiting, rather than silently ignoring it until the timeout.
      onAssistantMessage: (payload) => {
        const text = payload?.text
        if (typeof text === 'string' && text.trim()) {
          finish({ ok: true, value: { kind: 'message', text } })
        }
      },
      onError: (payload) => {
        finish({ ok: false, error: new Error(payload?.message ?? 'Unknown error') })
      },
      onConnectionError: () => {
        finish({ ok: false, error: new Error('WebSocket connection failed.') })
      },
    })
  })
}
