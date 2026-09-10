// Package inference defines the boundary between this platform and the
// actual LLM inference/reasoning service. A real implementation will be
// plugged in later; for now MockService lets the rest of the system
// (WebSocket hub, SDK, demo app) be built and tested end-to-end.
package inference

import (
	"context"
	"encoding/json"

	"github.com/tim72117/onagent/internal/codegen"
	"github.com/tim72117/want/types"
)

// ToolCall is one tool invocation the inference service wants the front-end
// to execute.
type ToolCall struct {
	ToolName string
	Args     json.RawMessage
}

// Result is what the inference service produces in response to a prompt:
// zero or more tool calls to run on the front-end, plus an optional
// natural-language message to show the user.
type Result struct {
	ToolCalls        []ToolCall
	AssistantMessage string

	// Usage is the LLM provider's own token accounting for this Complete
	// call, summed across every inference turn want ran to produce it (a
	// single prompt can trigger several provider round-trips — tool-use
	// loops, multi-agent handoffs — each carrying its own usage event on
	// want's "agent.inference" topic; see WantService.Complete). Nil for
	// implementations that don't report usage (MockService) or if want
	// never emitted a usage event for this turn.
	Usage *types.Usage
}

// Request bundles everything the inference service needs to reason about
// one prompt: the user's text and the tool set available for this session's
// app.
type Request struct {
	Prompt string
	Tools  []codegen.LLMTool

	// AppID identifies which developer app this prompt belongs to.
	// Implementations use it to select app-specific reasoning behavior
	// (see WantService's per-app agent role, driven by
	// toolschema.App.Thought) — distinct from SessionID, which scopes
	// per-user conversation history within that app.
	AppID string

	// SessionID identifies the end-user connection this prompt belongs to
	// (the WebSocket session id). Implementations use it to isolate
	// conversation state between users: two prompts share LLM conversation
	// history if and only if they carry the same SessionID. Empty means "no
	// isolation requested" (single-caller/dev use).
	SessionID string

	// RequestID is the client-supplied id for this one prompt (ws.Session
	// passes its protocol.Envelope.RequestID through unchanged). WantService
	// uses it as quota.Service.Record's event_id, so every usage row recorded
	// per-provider-round-trip during Complete (see WantService.Complete's
	// "agent.inference" subscription) carries the same event_id. event_id is
	// NOT a dedup key — quota.Record has no ON CONFLICT clause, so a caller
	// that retries the same RequestID (e.g. after a dropped/ambiguous
	// response) gets a second row inserted and summed into usageSince's
	// total, not a no-op; see quota.Record's own doc comment for why that
	// tradeoff was chosen deliberately. Empty is valid (e.g. tests, callers
	// with no per-prompt id) and simply skips in-Complete recording, same as
	// a nil quota.Service does.
	RequestID string

	// UserID is who this prompt's usage is billed to — the connection's
	// actual operator, resolved once at WebSocket handshake time by
	// ws.AppResolver.ResolveApp and carried on ws.Session for the
	// connection's whole life (see Session.userID). WantService.Complete
	// passes it straight through to quota.Service.Record's userID parameter;
	// see that doc comment for why this is no longer derived from appID's
	// owner. Zero is valid (quota disabled, or a caller with no user concept
	// — e.g. tests) and simply means Record bills to user id 0, which is
	// harmless since Record itself is skipped whenever RequestID is empty or
	// quota is nil (see WantService.Complete).
	UserID int64
}

// Service is the boundary this platform depends on. Swap MockService for a
// real client (HTTP/gRPC to the actual inference backend) without touching
// the WebSocket hub or SDK.
type Service interface {
	Complete(ctx context.Context, req Request) (*Result, error)

	// CloseSession releases any per-session resources SessionID's prompts
	// have accumulated (see WantService, which keeps one want orchestrator
	// per SessionID). Callers whose connection has a clear end-of-life
	// (ws.Session, the Playground handler) call this exactly once when that
	// connection closes. A no-op for implementations with no per-session
	// state to release, and safe to call with a SessionID that never
	// completed a prompt (nothing to release).
	CloseSession(sessionID string)
}
