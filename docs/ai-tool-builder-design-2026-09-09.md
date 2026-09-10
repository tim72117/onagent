# AI-assisted tool builder — app + tool definition

Design for the "describe what you want, let the LLM propose a tool" feature
(mobile console, next to "+ New tool" / "Build one step by step"). This
document defines the *content* — the onagent app and its one tool — that
the feature runs on. Runtime wiring (how/when this app gets created, how the
console talks to it) is discussed at the bottom — the frontend/protocol side
is implemented; per-user provisioning of the `tool-builder` app itself is
not (see "Runtime notes").

## Why an onagent app, not a custom backend call

`internal/inference.WantService` (the `want` orchestrator wrapper) has no
one-shot "text in, JSON out" API — its only exported surface is the full
session/toolbox/tool-calling-loop machinery, the same thing
`internal/console/playground.go` already exposes over WebSocket for
Playground. Rather than reimplementing provider calls by hand, this feature
reuses that existing machinery as-is: a dedicated onagent app whose only tool
is `propose_tool`, talked to exactly like any other app's Playground session
— the LLM's tool-calling decision *is* the "structured output," with no new
inference code needed at all.

## The app

The YAML below is checked into the repo verbatim as
`backend/internal/console/tool-builder-tools.yaml` — the source of truth for
`onagent save-tools tool-builder backend/internal/console/tool-builder-tools.yaml`
whenever this app needs to be (re-)provisioned. Keep the two in sync if either
changes.

```yaml
appId: tool-builder      # see "Runtime notes" below on how this is actually provisioned per user
thought: |
  You help a developer design one new tool for their own app on the onagent
  platform. The developer describes, in plain language, what they want their
  new tool to do — you turn that into a complete, valid tool definition and
  call propose_tool with it. Call propose_tool exactly once, as soon as you
  have enough information to fill in every field reasonably — do not ask
  clarifying questions unless the description is genuinely too vague to
  proceed at all (e.g. just "a tool" with no hint of purpose).

  Guidelines for filling in propose_tool's fields:
  - name: snake_case, short, verb-first (e.g. fill_search_form,
    get_cart_total, highlight_element). Must match ^[a-zA-Z_][a-zA-Z0-9_]*$.
  - description: written for another LLM deciding whether to call this tool
    mid-conversation — say what it does and when to call it, not how it's
    implemented.
  - parameters: a JSON Schema "object" describing exactly the arguments this
    tool needs from the LLM to do its job — no more, no fewer. Omit
    parameters entirely (empty properties) for a tool that takes no
    arguments (e.g. "scroll to the top of the page").
  - returns: only include this if the tool's caller (the web page) would
    send back data the LLM needs to reason about afterwards (e.g. "how many
    results were found"). Leave it unset for a fire-and-forget action tool
    (e.g. "click the submit button").
tools:
  - name: propose_tool
    description: >
      Call this once with a complete tool definition for the new tool the
      developer described. This is the only tool available in this
      conversation — always respond by calling it, never with plain text.
    kind: query
    parameters:
      type: object
      required: [name, description, parameters]
      properties:
        name:
          type: string
          description: >
            The tool's identifier as the LLM will call it. snake_case,
            starting with a letter or underscore — must match
            ^[a-zA-Z_][a-zA-Z0-9_]*$.
        description:
          type: string
          description: >
            Explains to an LLM when and why to call this tool. Written for
            that LLM's benefit, not the developer's.
        parameters:
          type: object
          description: >
            A JSON Schema "object" describing this tool's own arguments —
            the same shape OpenAI/Anthropic tool-calling parameters use.
            Always type "object" at the top level. properties is a map of
            argument name -> a nested schema ({type, description, and for
            "array" an items sub-schema}); required lists which of those
            argument names must always be present. An empty properties map
            means the tool takes no arguments at all.
        returns:
          type: object
          description: >
            Optional. Only include this field if the web page sends back
            data after running this tool that the conversation should
            reason about afterwards (a "query" tool) — omit it entirely for
            a fire-and-forget action. Same JSON Schema "object" shape as
            parameters above.
```

Notes on this shape:

- `propose_tool` itself is declared `kind: query` (see `toolschema.Tool.Kind`)
  so the console can block on its `tool_result` and know the turn is
  genuinely finished — see "Runtime notes" below.
- `parameters`/`returns` inside `propose_tool`'s own schema are typed as
  `object` with a **prose description** of the nested shape, rather than a
  fully recursive JSON Schema meta-schema. `ParameterSchema` (this codebase's
  own type) doesn't need a formal `$schema`-style definition here — the
  `thought` prompt above already teaches the model the concrete shape
  (`type`/`description`/`properties`/`items`/`required`), and a fully
  recursive schema-of-a-schema would add real prompt complexity for a case
  (models emitting slightly-wrong nested JSON Schema) that's already headed
  for a review screen (`ToolEditSheet`) before anything is saved.

## Example turn

**User prompt** (from the console's new "描述功能" input):

> 幫我做一個工具，可以把搜尋框填入指定文字並送出搜尋

**Expected `propose_tool` call**:

```json
{
  "name": "fill_search_form",
  "description": "Fills the page's search input with the given query and submits the search. Call this when the user asks to search for something.",
  "parameters": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": { "type": "string", "description": "The text to search for." }
    }
  }
}
```

No `returns` — this is a fire-and-forget UI action, matching the
`fill_search_form` example already used elsewhere in this codebase's own
docs/comments.

## Runtime notes (remaining items — not yet implemented)

- **Ownership**: `internal/console/playground.go`'s `ResolveApp` requires
  the connecting user to *own* the app (`ownedAppOrNotFound`). Apps are
  globally unique by `app_id` with no per-user namespace, so a single shared
  `tool-builder` app can't be opened via Playground by more than one user.
  Plan: lazily provision one `tool-builder` app **per user** on first use
  (a reserved, non-colliding appId — e.g. derived from the user's own id),
  owned by them, exactly like any other app they created — then open it via
  the existing Playground WebSocket exactly as `Playground.tsx` already
  does for a real app.
- **Hiding it from the normal app list**: a per-user `tool-builder` app
  would otherwise show up in `AppPickerSheet`/`Sidebar` next to the user's
  real apps. Needs a way to mark it "internal" so app-listing UI can filter
  it out — not designed yet.
- **Quota**: Playground's handshake-time quota check
  (`playgroundResolver.ResolveApp`) and `ws.Session.handlePrompt`'s
  per-prompt check both apply unchanged to this app like any other — a
  tool-builder conversation counts against the same monthly quota as the
  user's real apps' traffic. Worth flagging to the user in the UI ("this
  uses your plan's quota") rather than silently surprising them, but not a
  blocker.

Frontend wiring (WebSocket protocol handling, minimal generate UI,
`propose_tool` argument handoff into `ToolEditSheet`) is implemented as
`AiToolGeneratorSheet.tsx`/`aiToolGenerator.ts` — `propose_tool` is
`kind: query`, so the backend sends `TypeToolQuery`, not `TypeToolCall`
(see `protocol/message.go`'s doc comment on the distinction); the first
implementation listened only for `tool_call` and so never saw the actual
`tool_query` message, always timing out after 30s — now fixed.
