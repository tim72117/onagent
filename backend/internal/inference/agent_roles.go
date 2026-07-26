package inference

import (
	"encoding/json"
	"fmt"

	"github.com/tim72117/onagent/internal/toolschema"
	"github.com/tim72117/want/pkg/agentreg"
	"github.com/tim72117/want/types"
)

// agentRoleFor returns the want agent role name for a given app: each app
// gets its own role (rather than one shared "platform-tools" role) so its
// Tools whitelist only ever contains that app's own tools, and its Thought
// can be customized independently — see RegisterPlatformTools. No
// backend/.agents/<role>.md file exists for any of these, so AgentLoader
// always falls back to the Go-defined built-in (see want
// internal/loader.go: disk definitions only take priority when the file is
// actually present).
func agentRoleFor(appID string) string {
	return "platform-tools:" + appID
}

// defaultThought is the want agent's system prompt for an app that hasn't
// set a custom toolschema.App.Thought.
const defaultThought = "You are a tool-selection assistant embedded in a web page. " +
	"The user is talking to the page, not to you directly. When their " +
	"message calls for an action the page can perform, call the single " +
	"matching tool with well-formed arguments; the page executes it, " +
	"not you. If nothing needs doing, just reply in plain text. Never " +
	"ask the user to wait or claim you performed an action yourself — " +
	"the tool call itself is the action."

// RegisterPlatformTools registers every app loaded at startup (see
// RegisterAppRole for what registration actually does and why it's
// per-app).
func RegisterPlatformTools(apps map[string]*toolschema.App) {
	for _, app := range apps {
		RegisterAppRole(app)
	}
}

// RegisterAppRole (re-)registers a want agent role scoped to exactly this
// app (agentRoleFor(app.AppID)): its tool-name whitelist and its Thought (or
// defaultThought if unset). Per-app roles — rather than one role shared by
// every app — are what keep app A's LLM from ever seeing or selecting app
// B's tools, and let each app's Thought be customized independently.
//
// Must be called after any change to WHICH tools an app has, or to its
// Thought — those are the only two things a role captures. want has no
// mechanism to unregister a role, but re-registering the same role name
// simply overwrites its AgentDefinition (a map write, not append-only), so
// calling this again for an existing app is exactly how a whitelist/Thought
// edit takes effect.
//
// Editing an EXISTING tool's own schema (description, parameters) does NOT
// require calling this again: appToolProvider (see toolProviderFor) reads
// tool declarations straight from toolschema.Registry fresh on every single
// inference call — not from any snapshot taken at registration time — so a
// schema edit is visible on the very next prompt. This is the fix for want
// v0.0.2's types.GlobalRegistry.Declarations being append-only (see
// docs/known-issues-want-dependency.md /
// docs/TODO-want-registry-append-only.md): want v0.1.0 removed that global
// registry entirely, so there is no stale copy left to keep in sync.
func RegisterAppRole(app *toolschema.App) {
	toolNames := make([]string, 0, len(app.Tools))
	for _, t := range app.Tools {
		toolNames = append(toolNames, t.Name)
	}

	thought := app.Thought
	if thought == "" {
		thought = defaultThought
	}

	agentreg.Register(agentreg.DefaultLoader(), agentRoleFor(app.AppID), &agentreg.AgentDefinition{
		Role:  agentRoleFor(app.AppID),
		Tools: toolNames,
		WhenToUse: "Selects and fills arguments for tools that a connected " +
			"web page has declared; it never executes them itself.",
		Thought: thought,
		// Replace want's default prompt assembly (agentreg.DefaultPromptBuilder,
		// which prepends generic environment info, tool-usage rules, etc.
		// around Thought) entirely: the final system prompt sent to the LLM
		// is exactly app.Thought (or defaultThought), nothing appended or
		// prepended. Same approach as shuttle's assistant_agent.go. This
		// gives a developer who sets a custom Thought full control over
		// what the model sees — but it's also now entirely on them to
		// mention the tool-selection behavior defaultThought used to
		// guarantee (e.g. "call the matching tool, don't claim you did it
		// yourself") if they want that preserved.
		PromptBuilder: agentreg.PromptBuilderFunc(func(a *agentreg.Agent, c *agentreg.ToolUseContext) string {
			return a.SystemPrompt
		}),
	})
}

// appLookup is the one method appToolProvider actually needs from
// *toolschema.Registry. Defined here (not in toolschema) so this package's
// tests can supply a trivial in-memory fake instead of a real, DB-backed
// Registry — production code still just passes a *toolschema.Registry,
// which already satisfies this.
type appLookup interface {
	Get(id string) (*toolschema.App, bool)
}

// appToolProvider implements want's types.ToolProvider by reading live from
// an appLookup — never from a copy captured at some earlier point. Both
// Declarations() and GetFactory() re-resolve appID's current tools on every
// call: want's own internal/run_agent.go calls toolbox.Declarations() fresh
// on every single RunAgent invocation (once per prompt), and
// agent_tool.go's DispatchToolCall calls toolbox.GetFactory() at the moment
// a tool is actually invoked — neither is cached anywhere in want. So a
// tool schema edit saved through the console takes effect on the very next
// prompt, with no re-registration step and no backend restart.
//
// Per-request, not shared: WantService.Complete constructs one of these
// scoped to req.AppID on every call and assigns it to orch.Toolbox (see
// want.go), the same per-call-override pattern already used for orch.Role.
// This is also what keeps app A's tool factories from ever being reachable
// while running app B's role — GetFactory only ever looks inside this
// provider's own appID.
type appToolProvider struct {
	appID string
	apps  appLookup
}

// toolProviderFor builds a types.ToolProvider scoped to appID's current
// tools, backed by apps (in production, the same live, DB-synced
// *toolschema.Registry internal/console writes through — see
// toolschema.Registry.Reload).
func toolProviderFor(appID string, apps appLookup) types.ToolProvider {
	return &appToolProvider{appID: appID, apps: apps}
}

func (p *appToolProvider) Declarations() []types.ToolDeclaration {
	app, ok := p.apps.Get(p.appID)
	if !ok {
		return nil
	}
	decls := make([]types.ToolDeclaration, 0, len(app.Tools))
	for _, t := range app.Tools {
		decls = append(decls, toolDeclarationFor(t))
	}
	return decls
}

func (p *appToolProvider) GetFactory(name string) (types.ToolFactory, bool) {
	app, ok := p.apps.Get(p.appID)
	if !ok {
		return nil, false
	}
	for _, t := range app.Tools {
		if t.Name != name {
			continue
		}
		return toolFactoryFor(t), true
	}
	return nil, false
}

// toolDeclarationFor converts one developer-defined tool into the schema
// shape want/the LLM expects.
func toolDeclarationFor(t toolschema.Tool) types.ToolDeclaration {
	return types.ToolDeclaration{
		Name:        t.Name,
		Description: t.Description,
		Type:        "sync",
		Parameters:  parameterSchemaToWant(t.Parameters),
	}
}

// toolFactoryFor chooses between the two Call behaviors toolschema.ToolKind
// selects — see forwardingTool and queryTool's own doc comments for what
// each does.
func toolFactoryFor(t toolschema.Tool) types.ToolFactory {
	if t.Kind == toolschema.ToolKindQuery {
		return func() types.ToolInterface {
			return &queryTool{name: t.Name}
		}
	}
	return func() types.ToolInterface {
		return &forwardingTool{name: t.Name}
	}
}

// forwardingTool blocks until the page actually executes the call and
// reports back — same askPage bridge queryTool uses (see queryTool's doc
// comment for why this doesn't go through want's own
// ToolContext.RequestInteraction) — but unlike queryTool, only the
// success/failure of that report ever reaches the LLM, never the page's
// actual returned data. An error return here (from askPage: the page
// reported failure, disconnected, or never answered within
// interactionTimeout) is itself the validation step: want only ever sees
// "done" once the page has actually confirmed it, not the instant the call
// was forwarded.
type forwardingTool struct {
	types.BaseToolConfig
	name string
}

func (f *forwardingTool) ValidateInput(types.ToolArguments, types.ToolContext) error { return nil }

func (f *forwardingTool) Call(args types.ToolArguments, ctx types.ToolContext) ([]types.ResultContentBlock, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, fmt.Errorf("marshal args for %s: %w", f.name, err)
	}

	if _, err := askPage(ctx.GetAgentID(), f.name, raw, toolschema.ToolKindAction); err != nil {
		return nil, fmt.Errorf("execute %s: %w", f.name, err)
	}

	msg := fmt.Sprintf("%q executed successfully.", f.name)
	ctx.EmitToolResult(map[string]interface{}{"message": msg})
	return []types.ResultContentBlock{types.TextBlock(msg)}, nil
}

func (f *forwardingTool) RenderToolUse(args types.ToolArguments) string {
	return fmt.Sprintf("Calling %s", f.name)
}

func (f *forwardingTool) RenderToolUseError(err error) string {
	return fmt.Sprintf("Failed to call %s: %v", f.name, err)
}

func (f *forwardingTool) RenderToolResult(data map[string]interface{}) string {
	if msg, ok := data["message"].(string); ok {
		return msg
	}
	return "Executed on the page"
}

// queryTool is the ToolKindQuery counterpart to forwardingTool: both block
// until the page answers (see forwardingTool's doc comment), but where
// forwardingTool only surfaces success/failure to the LLM, queryTool feeds
// the page's actual answer data back into its reasoning.
//
// This deliberately does NOT go through want's own
// ToolContext.RequestInteraction/orch.ResolveInteraction machinery — that
// exists for want's own UI (e.g. a CLI or web frontend want ships) to ask
// *want's own user* something mid-run, which isn't what's happening here:
// there is no want UI in this platform at all, want runs headless behind
// this backend. Routing through it would mean building this exact same
// "reach the WS session and block" bridge a second time, just relayed
// through want's EventBus first for no benefit. askPage (interaction.go) is
// that bridge directly: it resolves ctx.GetAgentID() back to the raw WS
// session id and calls the session's own AskInteraction, registered via
// RegisterAsker when the session started.
type queryTool struct {
	types.BaseToolConfig
	name string
}

func (q *queryTool) ValidateInput(types.ToolArguments, types.ToolContext) error { return nil }

func (q *queryTool) Call(args types.ToolArguments, ctx types.ToolContext) ([]types.ResultContentBlock, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, fmt.Errorf("marshal args for %s: %w", q.name, err)
	}

	answerJSON, err := askPage(ctx.GetAgentID(), q.name, raw, toolschema.ToolKindQuery)
	if err != nil {
		return nil, fmt.Errorf("query %s: %w", q.name, err)
	}

	var answer interface{}
	if err := json.Unmarshal(answerJSON, &answer); err != nil {
		answer = string(answerJSON) // not JSON — surface it as-is rather than failing the whole call
	}
	ctx.EmitToolResult(map[string]interface{}{"answer": answer})
	return []types.ResultContentBlock{types.TextBlock(string(answerJSON))}, nil
}

func (q *queryTool) RenderToolUse(args types.ToolArguments) string {
	return fmt.Sprintf("Asking the page: %s", q.name)
}

func (q *queryTool) RenderToolUseError(err error) string {
	return fmt.Sprintf("Failed to query %s: %v", q.name, err)
}

func (q *queryTool) RenderToolResult(data map[string]interface{}) string {
	return fmt.Sprintf("Page answered %s", q.name)
}

// parameterSchemaToWant converts our JSON-Schema subset into the
// map[string]interface{} shape want's ToolDeclaration.Parameters expects
// (mirrors the OpenAI/Anthropic tool schema convention want's providers
// speak — see shuttle's wanttools for the same hand-built shape).
func parameterSchemaToWant(p toolschema.ParameterSchema) map[string]interface{} {
	out := map[string]interface{}{
		"type": p.Type,
	}
	if p.Description != "" {
		out["description"] = p.Description
	}
	// Always emit "properties" for an object type, even when there are none
	// (e.g. a ToolKindQuery tool that just asks a yes/no question with no
	// arguments) — omitting the key entirely for an empty map produces
	// {"type":"object"} with no properties, which is valid JSON Schema but
	// confused google/gemma-4-12b-it (via vLLM) into returning an
	// unparseable null response instead of calling the tool with {}. Every
	// other tool in this project happened to have at least one property
	// until the first ToolKindQuery tool with zero parameters surfaced
	// this. An explicit {} is unambiguous either way.
	if p.Type == "object" {
		props := make(map[string]interface{}, len(p.Properties))
		for name, sub := range p.Properties {
			if sub == nil {
				continue
			}
			props[name] = parameterSchemaToWant(*sub)
		}
		out["properties"] = props
	}
	if p.Items != nil {
		out["items"] = parameterSchemaToWant(*p.Items)
	}
	if len(p.Required) > 0 {
		out["required"] = p.Required
	}
	if len(p.Enum) > 0 {
		out["enum"] = p.Enum
	}
	return out
}
