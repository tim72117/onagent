import { BASE } from './api'
import type { Tool } from './schema'
import { randomRequestId } from './randomRequestId'

// Talks to the *existing* Playground WebSocket endpoint
// (backend/internal/console/playground.go) exactly the way Playground.tsx
// already does — hello, wait for ack, prompt, then answer the resulting
// tool_query — rather than adding any new backend endpoint. tool-builder's
// only tool is propose_tool (kind: query, per
// docs/ai-tool-builder-design-2026-09-09.md, so the backend sends
// TypeToolQuery, not TypeToolCall — see protocol/message.go's doc comment
// on the distinction). ws.Session.AskInteraction blocks waiting for a
// tool_result regardless of Kind, same as Playground.tsx's own
// handleToolMessage documents, so this always sends one back.
//
// TOOL_BUILDER_APP_ID is still hardcoded/shared, not yet provisioned per
// user or hidden from the normal app list — see
// docs/ai-tool-builder-design-2026-09-09.md's "Runtime notes" for what's
// still outstanding there.
const TOOL_BUILDER_APP_ID = 'tool-builder'

type Envelope = { type: string; requestId?: string; payload?: unknown }

interface ProposeToolArgs {
  name?: unknown
  description?: unknown
  parameters?: unknown
  returns?: unknown
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
  return {
    name: args.name,
    description: args.description,
    parameters: args.parameters as Tool['parameters'],
    returns: (args.returns as Tool['returns'] | undefined) ?? undefined,
  }
}

// Rejects after 30s if propose_tool is never called — mirrors the backend's
// own completeTimeout (internal/inference/want.go) at the same order of
// magnitude, so a hung request fails on its own rather than leaving the
// caller's "generating…" state stuck forever.
export function generateToolFromDescription(description: string): Promise<Tool> {
  return new Promise((resolve, reject) => {
    const wsUrl = BASE.replace(/^http/, 'ws') + `/console/apps/${encodeURIComponent(TOOL_BUILDER_APP_ID)}/playground`
    const ws = new WebSocket(wsUrl)

    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('Timed out waiting for the AI to propose a tool.'))
    }, 30_000)

    function finish(result: { ok: true; tool: Tool } | { ok: false; error: Error }) {
      clearTimeout(timer)
      ws.close()
      if (result.ok) resolve(result.tool)
      else reject(result.error)
    }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', requestId: randomRequestId(), payload: { appId: TOOL_BUILDER_APP_ID } } satisfies Envelope))
    })

    ws.addEventListener('error', () => finish({ ok: false, error: new Error('WebSocket connection failed.') }))

    ws.addEventListener('message', (event) => {
      let env: Envelope
      try {
        env = JSON.parse(event.data)
      } catch {
        return
      }

      if (env.type === 'ack') {
        ws.send(JSON.stringify({ type: 'prompt', requestId: randomRequestId(), payload: { text: description } } satisfies Envelope))
        return
      }

      if (env.type === 'tool_query') {
        const payload = env.payload as { toolName?: string; args?: unknown } | undefined
        if (payload?.toolName !== 'propose_tool') return

        // See this file's header comment — a tool_result is always
        // expected regardless of Kind, even though propose_tool's own
        // result content is never read by anything.
        ws.send(JSON.stringify({
          type: 'tool_result',
          requestId: env.requestId,
          payload: { toolName: 'propose_tool', ok: true },
        } satisfies Envelope))

        const args = payload.args
        const tool = isProposeToolArgs(args) ? toTool(args) : null
        if (tool) finish({ ok: true, tool })
        else finish({ ok: false, error: new Error('The AI’s response was missing required fields.') })
        return
      }

      if (env.type === 'error') {
        const message = (env.payload as { message?: string } | undefined)?.message ?? 'Unknown error'
        finish({ ok: false, error: new Error(message) })
      }
    })
  })
}
