// Package protocol defines the WebSocket message envelope exchanged between
// the browser-side Agent Bridge SDK and this backend.
package protocol

import "encoding/json"

// MessageType identifies the shape of Payload in an Envelope.
type MessageType string

const (
	// Client (browser) -> Server

	// TypeHello is sent once when a session connects. It carries the
	// developer's app/site identifier and optional initial page context.
	TypeHello MessageType = "hello"

	// TypePrompt sends a user-initiated (or automatic) request for the
	// inference service to reason about.
	TypePrompt MessageType = "prompt"

	// TypeToolResult returns the outcome of a tool call the client executed
	// in the DOM (e.g. "filled form field", "navigated to /checkout").
	TypeToolResult MessageType = "tool_result"

	// Server -> Client

	// TypeAck acknowledges a Hello and returns the resolved tool set for
	// the session (already-registered tools for this app ID).
	TypeAck MessageType = "ack"

	// TypeToolCall instructs the client to execute a named tool with
	// arguments produced by the inference service. Fire-and-forget from the
	// inference service's perspective: whatever the client does locally
	// (fill a form, navigate) never flows back into the conversation — see
	// toolschema.ToolKindAction.
	TypeToolCall MessageType = "tool_call"

	// TypeToolQuery instructs the client to run a named tool's handler and
	// report its return value back via TypeToolResult — unlike
	// TypeToolCall, the inference service is actually blocked waiting for
	// that TypeToolResult and feeds the answer back into the LLM's
	// reasoning. See toolschema.ToolKindQuery and internal/inference's
	// queryTool/askPage for the server-side half of this round trip.
	TypeToolQuery MessageType = "tool_query"

	// TypeAssistantMessage carries a natural-language message meant for
	// display to the end user (no DOM side effect).
	TypeAssistantMessage MessageType = "assistant_message"

	// TypeError reports a protocol- or inference-level error tied to a
	// specific request (by RequestID) or the connection as a whole.
	TypeError MessageType = "error"
)

// Envelope is the single message shape sent over the WebSocket connection in
// both directions. Payload is decoded based on Type.
type Envelope struct {
	Type      MessageType     `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// HelloPayload is the Payload of a TypeHello message.
type HelloPayload struct {
	AppID       string          `json:"appId"`
	SDKVersion  string          `json:"sdkVersion,omitempty"`
	PageURL     string          `json:"pageUrl,omitempty"`
	InitialData json.RawMessage `json:"initialData,omitempty"`
}

// AckPayload is the Payload of a TypeAck message.
type AckPayload struct {
	SessionID string   `json:"sessionId"`
	ToolNames []string `json:"toolNames"`
}

// PromptPayload is the Payload of a TypePrompt message.
type PromptPayload struct {
	Text string `json:"text"`
}

// ToolCallPayload is the Payload of a TypeToolCall message.
type ToolCallPayload struct {
	ToolName string          `json:"toolName"`
	Args     json.RawMessage `json:"args"`
}

// ToolResultPayload is the Payload of a TypeToolResult message.
type ToolResultPayload struct {
	ToolName string          `json:"toolName"`
	OK       bool            `json:"ok"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
}

// AssistantMessagePayload is the Payload of a TypeAssistantMessage message.
type AssistantMessagePayload struct {
	Text string `json:"text"`
}

// ErrorPayload is the Payload of a TypeError message.
type ErrorPayload struct {
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

// Error codes for ErrorPayload.Code. Most errors leave Code empty (a
// human-readable Message is enough); a code is set only when the client SDK
// is expected to branch on the reason programmatically rather than parse
// Message text.
const (
	// CodeQuotaExceeded means the app owner has used their whole prompt
	// allowance for the current billing period. The connection stays open —
	// the user can upgrade and keep using the same session — so this is
	// reported per rejected prompt, not by closing the socket. See
	// internal/quota and docs/subscription-usage-quota-design.md.
	CodeQuotaExceeded = "quota_exceeded"
)
