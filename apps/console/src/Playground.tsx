import { useEffect, useMemo, useRef, useState } from 'react'
import type { Tool } from './schema'
import { MOCK_TEMPLATE_KEYS, useMockRuntimes } from './playgroundMocks'
import { randomRequestId } from './randomRequestId'
import { connectPlayground, send } from './playgroundProtocol'
import type { ToolCallPayload, ToolResultPayload } from './playgroundProtocol'
import { fakeDataFromSchema } from './fakeDataFromSchema'
import { ToolCallDetailSheet } from './ToolCallDetailSheet'
import { isOverQuota, useQuota } from './QuotaContext'
import { usePopoverPlacement } from './usePopoverPlacement'
import styles from './Playground.module.css'

// 'quotaExceeded' is deliberately its own state rather than a flavor of
// 'closed': the connection was never attempted (see the connect effect
// below), and the distinction is the entire point — "you're out of tokens"
// is actionable, "Disconnected" is not.
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'quotaExceeded'

// Single source for the status pill's text/CSS-modifier-key, shared between
// Playground's own header render and onStatusChange's report to a parent
// (PlaygroundSheet.tsx) that wants to render its own copy elsewhere — kept
// as a plain function (not inlined at either call site) specifically so the
// two never drift out of sync with each other. Returns a semantic key, not
// a resolved CSS Modules classname: classnames are hashed per-file, so a
// caller in a different .module.css must map this key through its own
// stylesheet rather than being handed one of Playground.module.css's.
export function playgroundStatus(state: ConnectionState, ready: boolean): { label: string; key: ConnectionState } {
  if (state === 'quotaExceeded') return { label: 'Out of tokens', key: 'quotaExceeded' }
  if (state === 'connecting' || (state === 'open' && !ready)) return { label: 'Connecting…', key: 'connecting' }
  if (state === 'open') return { label: 'Connected', key: 'open' }
  return { label: 'Disconnected', key: 'closed' }
}

interface ChatMessage {
  id: number
  // 'fabricated' is distinct from 'error': it's the no-mock query-tool
  // fallback (see handleToolMessage) reporting a fake but ok:true result —
  // sharing 'error' styling here would read as a failure even though the
  // agent actually got usable (fabricated) data back.
  role: 'user' | 'assistant' | 'tool_call' | 'tool_query' | 'error' | 'fabricated'
  text: string
}

// One entry per tool_call/tool_query received this connection, shown as an
// icon strip above the transcript (see the header's .toolCallStrip below) —
// a quick-glance "what has this agent tried to do so far" view, distinct
// from the transcript's own per-call text line. Never removed once added;
// only status/result/error transition in place (pending -> ok/failed) as
// handleToolMessage's mock lookup or no-mock timeout settles, mirroring
// whatever ok value the matching tool_result was actually sent with.
// args/result/error are exactly what went out over the wire (the same
// payload send() below sees), captured here purely for
// ToolCallDetailSheet.tsx's read-only display when a developer taps this
// entry's icon — never read for any behavioral decision, so there's no risk
// of this display copy drifting out of sync with what the LLM actually got.
export interface ToolCallEntry {
  id: number
  toolName: string
  args: unknown
  status: 'pending' | 'ok' | 'failed'
  result?: unknown
  error?: string
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
// for) gets an honest "no mock effect" failure — unless it's a query tool
// (has a `returns` schema), in which case it gets a clearly-labeled
// fabricated placeholder value instead (see fakeDataFromSchema.ts and
// handleToolMessage's own doc comment for why query tools get this
// treatment and action tools don't).
export function Playground({
  appId,
  tools,
  // Set by PlaygroundSheet.tsx (mobile) to move Playground's whole
  // .playgroundHeader row — the help popover, connection-status pill, and
  // Reset context button — out of Playground's own render and into the
  // sheet's SheetHeader close-button row instead, the header a phone user
  // actually sees without scrolling; .playgroundHeader itself is then
  // omitted entirely rather than left behind as an empty/near-empty row.
  // Desktop's Playground (embedded directly in App.tsx, no SheetHeader to
  // move it into) leaves this unset and keeps everything in its own
  // header, unchanged. renderHeaderExtras is how that content actually
  // reaches the parent to render (Playground still owns all of the state
  // it's built from — connection state, helpOpen, etc. — it just also
  // hands the resulting node upward instead of only rendering it itself);
  // the function-as-prop shape (not a plain node) exists because this
  // content depends on state that changes after every render, so the
  // parent re-invokes it each time rather than holding a stale snapshot.
  hideHeaderInBody,
  renderHeaderExtras,
}: {
  appId: string
  tools: Tool[]
  hideHeaderInBody?: boolean
  renderHeaderExtras?: (extras: React.ReactNode) => void
}) {
  const { quota, refresh: refreshQuota } = useQuota()
  const [state, setState] = useState<ConnectionState>('connecting')
  const [ready, setReady] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCallEntry[]>([])
  // Which toolCalls entry's icon was tapped, if any — drives
  // ToolCallDetailSheet below. Holds the id, not the entry itself, so the
  // sheet stays live-updating (e.g. pending -> ok) while open, the same way
  // ToolEditSheet.tsx's row-sheets always read the current draft rather
  // than a snapshot taken at open time.
  const [selectedToolCallId, setSelectedToolCallId] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  // How many toolCalls entries existed when the current prompt was sent —
  // the strip's pulsing inference dot shows only while sending AND no tool
  // call has arrived yet this turn (toolCalls.length === turnBaseCount),
  // so the dot reads as "the model is deciding" and then *becomes* the
  // tool icon the moment a call lands, rather than lingering after it.
  const [turnBaseCount, setTurnBaseCount] = useState(0)
  // Whether the "what is this" help popover (triggered by the header's ?
  // icon) is open — see the click-outside/Escape effect below, same
  // dismissal pattern as DesktopAppBar.tsx's own popover (no BottomSheet
  // backdrop to supply that for free here, since this popover is a small
  // anchored overlay, not a mobile sheet).
  const [helpOpen, setHelpOpen] = useState(false)
  const helpRef = useRef<HTMLDivElement>(null)
  const helpPlacement = usePopoverPlacement(helpOpen, helpRef)
  // Bumped by resetContext() below to force the connect effect (keyed on
  // [appId, resetKey]) to tear down and reconnect with fresh:true — unlike
  // an ordinary reconnect (same stable sessionID, so the want orchestrator
  // and its session-store history both carry over by design), this asks
  // playground.go's ResolveApp for a brand-new sessionID (see
  // playgroundWsUrl's own doc comment). A genuinely different orchestrator
  // under a genuinely different id has no way to load the old
  // conversation's rows back in — not a race between closing the old
  // connection and opening the new one (there's nothing shared between
  // them left to race over), just two independent sessions that happen to
  // both belong to this same appId. Old history stays exactly where it
  // was, under the old sessionID, untouched. Value itself is never read,
  // only its identity changing.
  const [resetKey, setResetKey] = useState(0)
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
  // Same refresh-every-render/no-reconnect pattern as toolTemplateRef above —
  // lets handleToolMessage look up a toolName's own `returns` schema (for
  // the no-mock fake-data fallback below) without rebinding the WS listener.
  const toolsByNameRef = useRef<Map<string, Tool>>(new Map())
  useEffect(() => {
    const next = new Map<string, string>()
    for (const t of tools) {
      if (t.sourceTemplate && t.sourceTemplate in mockRuntimes) next.set(t.name, t.sourceTemplate)
    }
    toolTemplateRef.current = next
    toolsByNameRef.current = new Map(tools.map((t) => [t.name, t]))
  })

  useEffect(() => {
    setMessages([])
    setToolCalls([])
    setState('connecting')
    setReady(false)

    // cancelled guards every post-await write below: this effect now has a
    // suspension point (the quota fetch), so appId can change — or this
    // component can unmount — while it's in flight, and without this the
    // stale run would still open a socket for the app the user just
    // navigated away from.
    let cancelled = false
    let ws: WebSocket | null = null

    async function connect() {
      // Checked BEFORE opening the socket, because the backend's own gate
      // (playground.go's ResolveApp) refuses an over-quota caller with an
      // HTTP 429 during the WebSocket upgrade itself — and a failed upgrade
      // reaches JS as a bare `error` event with no status code or body
      // attached (the WebSocket API deliberately withholds both). So
      // without asking here, the UI could only ever say "Disconnected",
      // indistinguishable from the backend being down. refresh() rather
      // than the context's current `quota`: this decides whether to even
      // try connecting, so it should use the same freshness the backend
      // will, not a value cached since page load.
      const current = await refreshQuota()
      if (cancelled) return
      if (isOverQuota(current)) {
        setState('quotaExceeded')
        return
      }

      // connectPlayground sends hello itself the moment the socket opens
      // (see playgroundProtocol.ts). Every prior run of this effect
      // (appId unchanged, resetKey bumped by resetContext) passes
      // fresh:true, which asks the backend for a brand-new sessionID
      // instead of the usual stable "PG-<userID>-<appId>" one — see
      // resetKey's own comment and playgroundWsUrl's doc comment. Ordinary
      // mounts/reconnects (resetKey untouched) keep the stable id, so the
      // whole conversation transcript still persists across reconnects/
      // reloads for the same appId, same as before Reset context existed.
      ws = connectPlayground(
        appId,
        {
          onOpen: () => setState('open'),
          onClose: () => {
            setState('closed')
            setReady(false)
          },
          onConnectionError: () => setState('closed'),
          // toolNames isn't currently rendered anywhere in this UI —
          // acknowledged only to flip readiness, same as the real SDK's
          // ready flag.
          onAck: () => setReady(true),
          onAssistantMessage: (payload) => {
            appendMessage('assistant', payload?.text ?? '')
            setSending(false)
            // A turn just finished, so tokens were just spent — refresh so
            // the account chrome (SettingsView/AccountSheet) and this
            // component's own next connect see the new standing rather
            // than a figure from page load.
            void refreshQuota()
          },
          onToolMessage: (socket, type, requestId, payload) => handleToolMessage(socket, type, requestId, payload),
          onError: (payload) => {
            appendMessage('error', payload?.message ?? 'Unknown error')
            setSending(false)
            // Covers the per-prompt gate (ws/session.go's handlePrompt
            // sends CodeQuotaExceeded once usage crosses the limit
            // mid-session) as well as any other backend error that might
            // have coincided with spending tokens.
            void refreshQuota()
          },
        },
        resetKey > 0,
      )
      wsRef.current = ws
    }

    void connect()

    return () => {
      cancelled = true
      ws?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnect only when the app or resetKey changes, not on every render
  }, [appId, resetKey])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [messages])

  // Dropdown-standard dismissal for the help popover — same pattern as
  // DesktopAppBar.tsx's own popover (see its comment): no BottomSheet
  // backdrop to supply "click outside closes it" for free here, since this
  // is a small anchored overlay, not a mobile sheet.
  useEffect(() => {
    if (!helpOpen) return
    function onPointerDown(e: PointerEvent) {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
        setHelpOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setHelpOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [helpOpen])

  function appendMessage(role: ChatMessage['role'], text: string) {
    setMessages((cur) => [...cur, { id: nextId.current++, role, text }])
  }

  // Disconnects and reconnects under a brand-new sessionID (fresh:true —
  // see resetKey's own comment) rather than clearing the current one's
  // state in place: a genuinely different sessionID means a genuinely
  // different want orchestrator with no memory of the prior conversation
  // to begin with, and no way to load the old conversation's rows back in
  // from the session store either, since that's keyed by sessionID too.
  // The connect effect's own setMessages([])/setToolCalls([]) at its top
  // already clears local state on every run, so this only needs to bump
  // resetKey to trigger that run; input/sending aren't touched here since
  // a reset is expected mid-idle (the Send button is disabled while
  // sending), and turnBaseCount naturally resets to whatever the next
  // prompt sets it to.
  function resetContext() {
    setResetKey((k) => k + 1)
  }

  // Appends a new pending entry and returns its id, so the caller can flip
  // it to ok/failed later via settleToolCall once the matching tool_result
  // is actually sent — see ToolCallEntry's own comment on why entries are
  // updated in place rather than replaced or removed.
  function appendToolCall(toolName: string, args: unknown): number {
    const id = nextId.current++
    setToolCalls((cur) => [...cur, { id, toolName, args, status: 'pending' }])
    return id
  }

  function settleToolCall(id: number, outcome: { ok: boolean; result?: unknown; error?: string }) {
    setToolCalls((cur) =>
      cur.map((c) => (c.id === id ? { ...c, status: outcome.ok ? 'ok' : 'failed', result: outcome.result, error: outcome.error } : c)),
    )
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
  //
  // For everything else, this does NOT fabricate a fake success for an
  // action tool (no `returns`) — that would let the LLM believe an action
  // happened when it didn't, silently corrupting the rest of the
  // conversation. But a query tool (has `returns`) exists specifically to
  // hand data back for the LLM to reason about, and always failing it left
  // a developer with no way to test that reasoning without a real page —
  // so this fabricates a schema-shaped placeholder value instead (see
  // fakeDataFromSchema.ts) and reports ok:true with it, clearly labeled as
  // fabricated in the transcript so it's never mistaken for a real mock's
  // honestly-observed result. An action tool with no `returns` still gets
  // the honest path: shows the call and, after a short grace period, sends
  // back an explicit ok:false tool_result ("no mock effect for this tool
  // in Playground") so the LLM gets a clear, truthful answer quickly
  // rather than the developer having to wait out the backend's full
  // interaction timeout to learn the same thing.
  function handleToolMessage(
    ws: WebSocket,
    type: 'tool_call' | 'tool_query',
    requestId: string | undefined,
    payload: ToolCallPayload
  ) {
    appendMessage(type, `${payload.toolName}(${JSON.stringify(payload.args ?? {})})`)
    const callId = appendToolCall(payload.toolName, payload.args)

    const templateKey = toolTemplateRef.current.get(payload.toolName)
    const runtime = templateKey ? mockRuntimesRef.current[templateKey] : undefined
    if (runtime) {
      const outcome = runtime.invoke(payload.args)
      settleToolCall(callId, outcome)
      send(ws, 'tool_result', requestId, { toolName: payload.toolName, ...outcome } satisfies ToolResultPayload)
      return
    }

    const returnsSchema = toolsByNameRef.current.get(payload.toolName)?.returns
    if (returnsSchema) {
      // Query tool, no real mock — fabricate a schema-shaped placeholder
      // instead of failing outright (see this function's own doc comment
      // above for why action vs query tools are treated differently here).
      const fakeResult = fakeDataFromSchema(returnsSchema)
      appendMessage(
        'fabricated',
        `"${payload.toolName}" has no mock effect in Playground — returning fabricated placeholder data (${JSON.stringify(fakeResult)}) so the agent has something to reason about.`
      )
      settleToolCall(callId, { ok: true, result: fakeResult })
      send(ws, 'tool_result', requestId, { toolName: payload.toolName, ok: true, result: fakeResult } satisfies ToolResultPayload)
      return
    }

    appendMessage(
      'error',
      `"${payload.toolName}" has no mock effect in Playground — reporting failure back to the agent shortly.`
    )
    setTimeout(() => {
      const error = 'no mock effect for this tool in Playground; nothing here can perform it for real'
      settleToolCall(callId, { ok: false, error })
      if (ws.readyState !== WebSocket.OPEN) return
      send(ws, 'tool_result', requestId, {
        toolName: payload.toolName,
        ok: false,
        error,
      } satisfies ToolResultPayload)
    }, NO_MOCK_TIMEOUT_MS)
  }

  function sendPrompt(e: React.FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text || state !== 'open' || !ready || sending) return
    appendMessage('user', text)
    setSending(true)
    setTurnBaseCount(toolCalls.length)
    // requestId must be globally unique, not just unique within this page
    // load: the backend's Quota.Record uses this session's stable id
    // ("PG-<userID>-<appID>") plus requestId as an idempotency key against
    // usage_events (app_id, event_id). randomRequestId() (not a
    // page-load-scoped counter) keeps prompts from different page loads for
    // the same user+app from ever colliding.
    wsRef.current && send(wsRef.current, 'prompt', randomRequestId(), { text })
    setInput('')
  }

  const connected = state === 'open' && ready
  const selectedToolCall = toolCalls.find((c) => c.id === selectedToolCallId) ?? null

  // playground-status-${key} and playground-msg-${role} used to be plain
  // string concatenation against global classes — CSS Modules classnames
  // aren't predictable that way, so both become explicit lookups instead.
  const statusModifierClass: Record<ConnectionState, string> = {
    connecting: '',
    open: styles.playgroundStatusOpen,
    closed: styles.playgroundStatusClosed,
    quotaExceeded: styles.playgroundStatusClosed,
  }

  const status = playgroundStatus(state, ready)

  const msgRoleClass: Record<ChatMessage['role'], string> = {
    user: styles.playgroundMsgUser,
    assistant: styles.playgroundMsgAssistant,
    tool_call: styles.playgroundMsgTool_call,
    tool_query: '',
    error: styles.playgroundMsgError,
    fabricated: styles.playgroundMsgFabricated,
  }

  // What-is-this help (collapsed behind a ? trigger instead of a
  // permanently-visible paragraph — the instructional copy only matters
  // the first few times someone opens Playground, so leaving it always on
  // screen cost more vertical space than it was worth for a returning
  // developer), the connection-status pill, and the Reset context button —
  // together, everything Playground's own header row shows besides its
  // "Playground" label. Computed as a value (not rendered inline below) so
  // PlaygroundSheet.tsx (mobile) can receive the exact same node via
  // renderHeaderExtras and place it in the sheet's SheetHeader row instead
  // — the header a phone user actually sees without scrolling — with
  // .playgroundHeader itself then omitted entirely rather than left behind
  // holding only the "Playground" label. helpRef anchors both the trigger
  // and its popover so the click-outside effect above can tell a click
  // inside either of them apart from one that should close it.
  // Memoized so its identity only changes when a value it actually reads
  // changes — renderHeaderExtras's own effect below depends on this
  // reference, and without memoizing it, a plain `const headerExtras = (…)`
  // produces a brand-new element tree every render. PlaygroundSheet.tsx's
  // renderHeaderExtras is a setState function: calling it with a fresh
  // value every render re-renders PlaygroundSheet, which re-renders this
  // component, which builds yet another fresh tree — an infinite loop
  // (React's "Maximum update depth exceeded"), not merely wasted work.
  const helpPopoverClass = `${styles.helpPopover} ${styles[`helpPopover${helpPlacement.vertical[0].toUpperCase()}${helpPlacement.vertical.slice(1)}${helpPlacement.horizontal[0].toUpperCase()}${helpPlacement.horizontal.slice(1)}`]}`
  const resetDisabled = sending || (messages.length === 0 && toolCalls.length === 0)
  const headerExtras = useMemo(
    () => (
      <>
        <div className={styles.helpAnchor} ref={helpRef}>
          <button
            type="button"
            className={styles.helpTrigger}
            aria-label="What is Playground?"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((v) => !v)}
          >
            ?
          </button>
          {helpOpen && (
            <div className={helpPopoverClass} role="tooltip">
              Test prompts against this app's agent without a real site. Some templates (a
              click-a-button tool, a fill-a-form-field tool) get real mock controls below that
              respond when the agent calls them — you can operate them yourself too, same controls,
              same effect. A query tool with no mock instead gets a fabricated placeholder result
              (clearly labeled as such in the transcript), so the agent has something to reason
              about; everything else honestly reports failure back to the agent, since there's no
              real page here to act on it.
            </div>
          )}
        </div>

        <span className={`${styles.playgroundStatus} ${statusModifierClass[status.key]}`}>{status.label}</span>

        {/* Disconnects and reconnects under a brand-new sessionID — see
            resetContext's own comment for why that genuinely discards the
            backend's conversation history, not just this transcript.
            Disabled while there's nothing to discard (no messages yet) or
            mid-turn (resetting out from under an in-flight prompt would
            leave that prompt's eventual tool_call/tool_result arriving on
            a socket this component already closed and replaced). */}
        <button
          type="button"
          className={styles.resetContextBtn}
          onClick={resetContext}
          disabled={resetDisabled}
          title="Start a new conversation with this app's agent"
        >
          Reset context
        </button>
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetContext is a plain function redefined every render (it closes over nothing that changes independent of the deps already listed), not a value this element tree reads during render — including it would defeat the memoization it's meant to enable.
    [helpOpen, helpPopoverClass, status.key, status.label, resetDisabled],
  )

  useEffect(() => {
    renderHeaderExtras?.(headerExtras)
  }, [headerExtras, renderHeaderExtras])

  return (
    <div className={styles.playground}>
      {!hideHeaderInBody && (
        <div className={styles.playgroundHeader}>
          <span className="micro-label">Playground</span>
          {headerExtras}
        </div>
      )}

      {state === 'quotaExceeded' && (
        <div className={styles.quotaNotice}>
          <p className={styles.quotaNoticeTitle}>You've used this month's tokens</p>
          <p className={styles.quotaNoticeBody}>
            Playground runs real inference, so it needs available tokens.
            {quota?.enabled && typeof quota.used === 'number' && typeof quota.limit === 'number' && (
              <>
                {' '}
                You've used {quota.used.toLocaleString()} of {quota.limit.toLocaleString()} on the{' '}
                {quota.planName} plan.
              </>
            )}
            {quota?.periodEnd && <> Your allowance resets on {new Date(quota.periodEnd).toLocaleDateString()}.</>}
          </p>
        </div>
      )}

      {/* The strip reads as a left-to-right timeline of the conversation's
          tool activity: each settled/pending call is an icon, consecutive
          steps are joined by a short connector line, and while a prompt's
          inference is still running (sending) a pulsing dot sits at the
          end of the line — the "something is being decided right now"
          position a tool icon will occupy if the model decides to call
          one. Always rendered (not gated on toolCalls.length || sending),
          with its own dashed outline and (while genuinely empty) a short
          caption — a bare empty strip read as a stray layout gap, not a
          dedicated "tool activity happens here" area, before there was
          ever a real reason to look at it. The outline/caption together
          also keep this row's height reserved from the start, so the
          transcript below it doesn't jump/resize the instant the first
          tool call or inference dot appears. */}
      <div className={`${styles.toolCallStrip} ${toolCalls.length === 0 && !sending ? styles.toolCallStripEmpty : ''}`}>
          {toolCalls.length === 0 && !sending && (
            <span className={styles.toolCallStripEmptyLabel}>Tool calls will appear here</span>
          )}
          {toolCalls.map((c, i) => (
            <span key={c.id} className={styles.flowStep}>
              {i > 0 && <span className={styles.flowConnector} aria-hidden="true" />}
              <button
                type="button"
                className={`${styles.toolCallIcon} ${styles[`toolCallIcon${c.status[0].toUpperCase()}${c.status.slice(1)}`]}`}
                title={`${c.toolName} — ${c.status}`}
                onClick={() => setSelectedToolCallId(c.id)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                <span className={styles.toolCallStatusDot} aria-hidden="true" />
              </button>
            </span>
          ))}
          {/* Only until this turn's first tool call lands (see
              turnBaseCount's own comment) — the dot then reads as having
              become that icon, instead of lingering after it. */}
          {sending && toolCalls.length === turnBaseCount && (
            <span className={styles.flowStep}>
              {toolCalls.length > 0 && <span className={styles.flowConnector} aria-hidden="true" />}
              <span className={styles.inferenceDot} title="Thinking…" />
            </span>
          )}
      </div>

      <div className={styles.body}>
        {activeTemplateKeys.length > 0 && (
          <div className={styles.mockRail}>
            {activeTemplateKeys.map((key) => (
              <div key={key}>{mockRuntimes[key].render()}</div>
            ))}
          </div>
        )}

        <div className={styles.main}>
          <div className={styles.playgroundTranscript} ref={transcriptRef}>
            {messages.length === 0 && (
              <p className={`sidebar-empty ${styles.playgroundEmpty}`}>Send a prompt to see how the agent responds.</p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`${styles.playgroundMsg} ${msgRoleClass[m.role]}`}>
                {(m.role === 'tool_call' || m.role === 'tool_query') && (
                  <span className={styles.playgroundMsgLabel}>{m.role === 'tool_call' ? 'tool call' : 'tool query'}</span>
                )}
                {m.role === 'error' && <span className={styles.playgroundMsgLabel}>error</span>}
                {m.role === 'fabricated' && <span className={styles.playgroundMsgLabel}>fabricated data</span>}
                <span className="playground-msg-text">{m.text}</span>
              </div>
            ))}
            {sending && <div className={`${styles.playgroundMsg} ${styles.playgroundMsgPending}`}>Thinking…</div>}
          </div>

          <form className={styles.playgroundInputRow} onSubmit={sendPrompt}>
            <input
              className={styles.playgroundInput}
              placeholder={
                connected ? 'Type a prompt…' : state === 'quotaExceeded' ? 'Out of tokens' : 'Connecting…'
              }
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

      <ToolCallDetailSheet
        open={selectedToolCallId !== null}
        onClose={() => setSelectedToolCallId(null)}
        toolCall={selectedToolCall}
      />
    </div>
  )
}
