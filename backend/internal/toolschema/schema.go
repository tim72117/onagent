// Package toolschema defines the developer-facing tool definition format
// and loads it from YAML files under backend/tools/.
//
// A Tool describes one capability the front-end exposes to the LLM: its
// name, a JSON-Schema-style parameter definition (for the inference
// service), and metadata used to generate a matching TypeScript handler
// stub for the Agent Bridge SDK.
package toolschema

// Tool is one developer-defined capability exposed to the LLM.
type Tool struct {
	// Name is the tool's identifier as seen by the LLM. Must be unique
	// within an app and match ^[a-zA-Z_][a-zA-Z0-9_]*$.
	Name string `yaml:"name" json:"name"`

	// Description explains to the LLM when/why to call this tool.
	Description string `yaml:"description" json:"description"`

	// Parameters is a JSON-Schema "object" definition of the tool's
	// arguments, in the same shape OpenAI/Anthropic tool calling expects.
	Parameters ParameterSchema `yaml:"parameters" json:"parameters"`

	// Returns optionally documents the shape of the tool_result payload
	// the front-end sends back after executing this tool. It is not sent
	// to the LLM as part of the tool schema, but is used for TS codegen.
	// For a Kind == ToolKindQuery tool, this is also the shape the
	// frontend's answer is expected in — that answer is fed back into the
	// LLM's reasoning, not just used for codegen (see Kind's doc comment).
	Returns *ParameterSchema `yaml:"returns,omitempty" json:"returns,omitempty"`

	// Kind selects what happens after this tool is called. Empty/
	// ToolKindAction (the default, and the only behavior that existed
	// before this field) is fire-and-forget: the call is forwarded to the
	// page to execute, and want considers it done immediately — nothing
	// the page sends back ever reaches the LLM.
	//
	// ToolKindQuery blocks the in-flight want call (see
	// internal/inference's queryTool/askPage) until the frontend answers a
	// "tool_query" message with a matching tool_result, then feeds that
	// answer back into the LLM's context so it can reason about real data
	// the backend doesn't have (e.g. "what's currently on screen"). Use
	// this sparingly — the blocking wait holds want's single shared
	// orchestrator lock for as long as the frontend takes to respond (see
	// WantService.Complete's doc comment), so a slow/unresponsive page
	// stalls every other user of every app on this backend, not just this
	// one request.
	Kind ToolKind `yaml:"kind,omitempty" json:"kind,omitempty"`
}

// ToolKind distinguishes the two tool-call flows a developer can declare.
// See Tool.Kind for the behavioral difference.
type ToolKind string

const (
	ToolKindAction ToolKind = "action"
	ToolKindQuery  ToolKind = "query"
)

// ParameterSchema is a (deliberately small) subset of JSON Schema, enough to
// describe LLM tool parameters and generate matching TypeScript types.
type ParameterSchema struct {
	Type        string                      `yaml:"type" json:"type"`
	Description string                      `yaml:"description,omitempty" json:"description,omitempty"`
	Properties  map[string]*ParameterSchema `yaml:"properties,omitempty" json:"properties,omitempty"`
	Items       *ParameterSchema            `yaml:"items,omitempty" json:"items,omitempty"`
	Required    []string                    `yaml:"required,omitempty" json:"required,omitempty"`
	Enum        []string                    `yaml:"enum,omitempty" json:"enum,omitempty"`
}

// App groups the tools that belong to one developer application (one
// AppID), loaded from a single YAML file.
type App struct {
	AppID string `yaml:"appId" json:"appId"`
	Tools []Tool `yaml:"tools" json:"tools"`

	// Thought is this app's custom instructions for the want agent that
	// selects its tools — tone, domain knowledge, or app-specific rules a
	// developer wants the LLM to follow beyond "call the matching tool."
	// Empty means the platform default applies (see
	// internal/inference/agent_roles.go's defaultThought). Not part of the
	// LLM tool schema itself (codegen.ToLLMTools doesn't touch it) — it
	// only affects the want agent role's system prompt.
	Thought string `yaml:"thought,omitempty" json:"thought,omitempty"`
}
