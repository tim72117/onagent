// Package inference: WantService adapts the want orchestrator (an
// asynchronous, event-driven agent runtime with its own tool-execution loop)
// to the synchronous Service interface this platform's WebSocket hub calls.
//
// want ships with built-in tools (Bash, Browser, Edit, ...) that execute for
// real on the backend — Browser literally drives a headless Chrome instance.
// Those must never run here: this platform's tools are meant to be executed
// by the connected web page, not by the backend. WantService therefore runs
// want under a per-app agent role (agentRoleFor in agent_roles.go), whose
// tool whitelist contains only that app's own declared tools; the built-ins
// are registered in want's global registry (we can't stop that) but are
// simply never selectable by any of these roles. Selecting one of an app's
// own tools doesn't execute it either — the tool's Call implementation
// (forwardingTool, in agent_roles.go) records the call and returns
// immediately; WantService.Complete reads it back out of the shared sink
// once the run reaches "idle".
//
// want.Orchestrator has one AgentID (and one Role) per orchestrator
// instance and dispatches every Submit() onto the same activation queue,
// processing one agent run at a time. WantService therefore serializes
// Complete() calls with a mutex: concurrent requests would otherwise race
// on the same AgentID/Role and the package-level callSink, each risking
// observing the other's output — this is also what makes it safe to swap
// AgentID/Role per call (see Complete) rather than needing one orchestrator
// per app/session.
package inference

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tim72117/onagent/internal/toolschema"
	"github.com/tim72117/want/config"
	"github.com/tim72117/want/orchestrator"
	"github.com/tim72117/want/ui"
)

// WantSettings configures the underlying want orchestrator. Mirrors
// want/config.Settings; kept as a separate type so callers of this package
// never need to import want directly.
type WantSettings struct {
	Provider        string
	Model           string
	OllamaURL       string
	VLLMBaseURL     string
	GoogleAPIKey    string
	AnthropicAPIKey string
	Workspace       string
	MockScenario    string
}

// idleSettleDelay gives text/tool-use events a window to arrive after the
// "idle" status event, since event ordering isn't guaranteed to put them
// first. Mirrors the same wait used in want_analyzer.go.
const idleSettleDelay = 1500 * time.Millisecond

// completeTimeout bounds how long a single Complete() call waits for want to
// reach "idle" before giving up.
const completeTimeout = 90 * time.Second

// WantService implements Service by delegating reasoning to a want
// orchestrator instance. RegisterPlatformTools must be called once before
// the first Complete call (see agent_roles.go).
type WantService struct {
	orch *orchestrator.Orchestrator
	apps *toolschema.Registry
	mu   sync.Mutex
}

// NewWant builds a want orchestrator from settings and starts its
// background dispatch loop. apps is the live tool registry Complete uses to
// build a per-app types.ToolProvider on every call (see toolProviderFor in
// agent_roles.go) — the same *toolschema.Registry internal/console writes
// through, so a saved tool edit is visible on the very next prompt with no
// extra step.
//
// The initial role AND toolbox passed to SetupWith are harmless
// placeholders — Complete sets both orch.Role and orch.Toolbox to the
// requesting app's own values on every call; before any app has been
// selected the orchestrator simply hasn't been asked to run yet.
func NewWant(settings WantSettings, apps *toolschema.Registry) *WantService {
	orch := orchestrator.SetupWith(&config.Settings{
		Provider:        settings.Provider,
		Model:           settings.Model,
		OllamaURL:       settings.OllamaURL,
		VLLMBaseURL:     settings.VLLMBaseURL,
		GoogleAPIKey:    settings.GoogleAPIKey,
		AnthropicAPIKey: settings.AnthropicAPIKey,
		Workspace:       settings.Workspace,
		MockScenario:    settings.MockScenario,
	}, toolProviderFor("", apps))
	return &WantService{orch: orch, apps: apps}
}

func (s *WantService) Complete(ctx context.Context, req Request) (*Result, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Per-user conversation isolation. want keys an agent's conversation
	// history (sessions/session_<AgentID>.jsonl, loaded into the LLM's
	// context on every run) by orch.AgentID — and reads that public field
	// on each Submit. With a single process-wide orchestrator, every user
	// of every app would otherwise share one transcript: user B's prompt
	// would carry user A's conversation as prior turns. Swapping AgentID
	// to the caller's session id before each Submit gives every WebSocket
	// connection its own transcript while keeping multi-turn memory within
	// a connection. Safe because this mutex guarantees no run is in flight
	// while the field changes.
	if id := sanitizeSessionID(req.SessionID); id != "" {
		s.orch.AgentID = "WS-" + id
	}

	// Per-app agent selection: orch.Role picks which want agent definition
	// (Tools whitelist + Thought) LoadToolUseContext resolves for this run
	// — see agent_roles.go's registerAppRole, which registered one such
	// definition per app at startup. Without this, every app would share
	// whatever role the orchestrator happened to be constructed with,
	// meaning app A's LLM could see app B's tools (or B's custom Thought).
	//
	// orch.Toolbox is set the same way, same reason: it scopes
	// Declarations()/GetFactory() to exactly this app's own tools (see
	// appToolProvider in agent_roles.go), read live from s.apps on every
	// call — not a snapshot taken at registration time. want has no
	// fallback for a nil Toolbox (an unset one fails the run outright, see
	// want internal/run_agent.go's RunAgent), so this must be set on every
	// call that has an AppID, mirroring orch.Role exactly.
	if req.AppID != "" {
		s.orch.Role = agentRoleFor(req.AppID)
		s.orch.Toolbox = toolProviderFor(req.AppID, s.apps)
	}

	state := ui.NewCommonInferenceState()
	var textMu sync.Mutex
	var text strings.Builder

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }

	unsub := s.orch.Subscribe("agent.inference", func(payload interface{}) {
		result, handled := ui.HandleInferenceMessage(payload, state)
		if !handled || result == nil {
			return
		}
		switch vm := result.(type) {
		case ui.TextViewModel:
			if vm.Content != "" {
				textMu.Lock()
				text.WriteString(vm.Content)
				textMu.Unlock()
			}
		case ui.StatusViewModel:
			if vm.Status == "idle" {
				// Tool-use/text events for this turn may still be in
				// flight; give them a window to land before finishing.
				go func() {
					time.Sleep(idleSettleDelay)
					finish()
				}()
			}
		}
	})
	defer unsub()

	s.orch.Submit(req.Prompt)

	select {
	case <-done:
	case <-ctx.Done():
		s.orch.Interrupt()
		return nil, ctx.Err()
	case <-time.After(completeTimeout):
		return nil, fmt.Errorf("want inference timed out after %s", completeTimeout)
	}

	textMu.Lock()
	assistantMessage := text.String()
	textMu.Unlock()

	// ToolCalls stays empty here on purpose: forwardingTool/queryTool
	// (agent_roles.go) both now report their call to the browser directly
	// via askPage/AskInteraction, immediately and synchronously, rather
	// than being collected here and relayed after the whole turn finishes
	// — see ws.Session.AskInteraction. MockService.Complete is the only
	// remaining populator of Result.ToolCalls, for its own simpler,
	// non-blocking simulation.
	return &Result{AssistantMessage: assistantMessage}, nil
}

// sessionIDRE matches what ws.randomID produces (hex), with room for other
// simple id schemes. The id becomes part of a filename want writes
// (sessions/session_WS-<id>.jsonl), so anything outside this set — path
// separators, dots, spaces — is rejected outright rather than escaped.
var sessionIDRE = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

// sanitizeSessionID returns id if it's safe to embed in want's session
// filename, or "" (meaning: don't switch agents, keep the orchestrator's
// own AgentID) otherwise.
func sanitizeSessionID(id string) string {
	if sessionIDRE.MatchString(id) {
		return id
	}
	return ""
}
