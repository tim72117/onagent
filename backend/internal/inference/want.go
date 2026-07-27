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
// WantService keeps one want.Orchestrator per SessionID (see the sessions
// map below), built lazily on that session's first Complete call — rather
// than one shared orchestrator with its AgentID/Role/Toolbox swapped per
// call, as this package used to do. That swap was safe (a mutex guaranteed
// no run was ever in flight while the fields changed) but serialized every
// user's every turn behind one lock, up to completeTimeout each.
//
// This does NOT give sessions independent LLM providers or independent
// concurrency limits, despite giving each one its own *orchestrator.Orchestrator:
// want (still true as of v0.2.0 — see internal/run_agent.go's package-level
// GlobalEngine) resolves every RunAgent call's provider by reading that one
// process-wide GlobalEngine, which orchestrator.InitializeWithConfig
// overwrites on every call. Calling it once per session (as SetupWith does
// internally) would race unsynchronized writes to GlobalEngine across
// concurrent session creations, and — since every session here uses
// identical WantSettings anyway (one Provider/Model/API key for the whole
// process, from environment variables) — would only ever replace it with an
// equivalent instance, never a meaningfully different one; the risk isn't
// worth taking for zero practical benefit. initEngineOnce below calls
// orchestrator.InitializeWithConfig exactly once for the process's whole
// lifetime; every session's Orchestrator is otherwise assembled by hand
// (mirroring what SetupWith does apart from that one call — see
// buildOrchestrator) and shares the same underlying provider and its
// concurrency=1 request queue. What per-session orchestrators DO provide:
// each session's own AgentID/Role/Toolbox/conversation history/dispatch
// goroutine, replacing the old design's global mutex + swapped-fields
// pattern with actual object-level isolation, and (via Orchestrator.Stop(),
// added in want v0.2.0) a way to release a session's resources when its
// connection closes instead of leaking its dispatch goroutine forever.
//
// A session's orchestrator is created once (with its AgentID, Role, and
// Toolbox fixed for the session's whole lifetime — see buildOrchestrator's
// doc comment on why that's safe) and reused by every subsequent Complete
// call carrying the same SessionID, until CloseSession releases it.
package inference

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tim72117/onagent/internal/toolschema"
	"github.com/tim72117/want/config"
	"github.com/tim72117/want/orchestrator"
	"github.com/tim72117/want/types"
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

// WantService implements Service by delegating reasoning to one want
// orchestrator per session. RegisterPlatformTools must be called once
// before the first Complete call (see agent_roles.go).
type WantService struct {
	settings WantSettings
	apps     *toolschema.Registry

	initOnce sync.Once // guards the one process-wide orchestrator.InitializeWithConfig call — see package doc comment
	initErr  error

	mu       sync.Mutex // guards sessions only — never held across a Submit/wait
	sessions map[string]*orchestrator.Orchestrator
}

// NewWant returns a WantService that builds one want orchestrator per
// session lazily, on that session's first Complete call — see
// buildOrchestrator. apps is the live tool registry each session's
// orchestrator reads from on every call (via toolProviderFor in
// agent_roles.go) — the same *toolschema.Registry internal/console writes
// through, so a saved tool edit is visible on the very next prompt with no
// extra step.
func NewWant(settings WantSettings, apps *toolschema.Registry) *WantService {
	return &WantService{
		settings: settings,
		apps:     apps,
		sessions: make(map[string]*orchestrator.Orchestrator),
	}
}

// buildOrchestrator constructs one session's Orchestrator by hand, mirroring
// orchestrator.SetupWith's own steps (NewOrchestrator -> set Toolbox ->
// resolve Workspace -> Start) apart from SetupWith's call to
// InitializeWithConfig, which s.initOnce has already made exactly once for
// the whole process (see package doc comment for why this must not run
// again per session).
//
// role and toolbox are fixed for the orchestrator's entire lifetime, not
// re-checked on every later Complete call the way the old shared-orchestrator
// design had to: a session's AppID cannot change mid-connection.
// ws.Session.s.app is set once from the connection's hello message and read
// unchanged by every later handlePrompt (backend/internal/ws/session.go),
// and the SDK (packages/bridge/src/client.ts) sends hello exactly once, on
// connect — so this orchestrator's Role/Toolbox stay correct without ever
// being written to again after creation.
func (s *WantService) buildOrchestrator(role string, toolbox types.ToolProvider) *orchestrator.Orchestrator {
	orch := orchestrator.NewOrchestrator(role)
	if toolbox != nil {
		orch.Toolbox = toolbox
	}

	// Mirrors SetupWith's own Workspace resolution: NewOrchestrator has
	// already set orch.Workspace to <initial working dir>/workspace by the
	// time this runs (want/internal/types.InitialWorkingDir, populated from
	// os.Getwd() on the process's first-ever NewOrchestrator call), so an
	// empty s.settings.Workspace needs no further action here — only a
	// non-empty override needs resolving, exactly as SetupWith does.
	if s.settings.Workspace != "" {
		if filepath.IsAbs(s.settings.Workspace) {
			orch.Workspace = s.settings.Workspace
		} else if wd, err := os.Getwd(); err == nil {
			orch.Workspace = filepath.Join(wd, s.settings.Workspace)
		}
	}

	orch.Start()
	return orch
}

// getOrCreate returns key's orchestrator, building one if this is its first
// call. key is req.SessionID normalized by sessionKeyFor — see that
// function for what an empty/invalid SessionID maps to.
func (s *WantService) getOrCreate(key string, appID string) (*orchestrator.Orchestrator, error) {
	s.initOnce.Do(func() {
		s.initErr = orchestrator.InitializeWithConfig(&config.Settings{
			Provider:        s.settings.Provider,
			Model:           s.settings.Model,
			OllamaURL:       s.settings.OllamaURL,
			VLLMBaseURL:     s.settings.VLLMBaseURL,
			GoogleAPIKey:    s.settings.GoogleAPIKey,
			AnthropicAPIKey: s.settings.AnthropicAPIKey,
			Workspace:       s.settings.Workspace,
			MockScenario:    s.settings.MockScenario,
		})
	})
	if s.initErr != nil {
		return nil, fmt.Errorf("want engine initialization failed: %w", s.initErr)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if orch, ok := s.sessions[key]; ok {
		return orch, nil
	}

	var role string
	if appID != "" {
		role = agentRoleFor(appID)
	}
	toolbox := toolProviderFor(appID, s.apps)

	orch := s.buildOrchestrator(role, toolbox)
	if key != "" {
		orch.AgentID = "WS-" + key
	}

	s.sessions[key] = orch
	return orch, nil
}

// CloseSession stops and releases key's orchestrator (see
// Service.CloseSession's doc comment on when callers invoke this). A no-op
// if key never completed a prompt (nothing was ever created for it).
func (s *WantService) CloseSession(sessionID string) {
	key := sessionKeyFor(sessionID)

	s.mu.Lock()
	orch, ok := s.sessions[key]
	if ok {
		delete(s.sessions, key)
	}
	s.mu.Unlock()

	if ok {
		orch.Stop()
	}
}

func (s *WantService) Complete(ctx context.Context, req Request) (*Result, error) {
	key := sessionKeyFor(req.SessionID)
	orch, err := s.getOrCreate(key, req.AppID)
	if err != nil {
		return nil, err
	}

	state := ui.NewCommonInferenceState()
	var textMu sync.Mutex
	var text strings.Builder

	done := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(done) }) }

	unsub := orch.Subscribe("agent.inference", func(payload interface{}) {
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
					defer func() {
						if r := recover(); r != nil {
							// An unrecovered panic on any goroutine kills
							// the whole process, taking every other
							// session's in-flight connection down with it.
							finish()
						}
					}()
					time.Sleep(idleSettleDelay)
					finish()
				}()
			}
		}
	})
	defer unsub()

	if _, err := orch.Submit(req.Prompt); err != nil {
		return nil, fmt.Errorf("want submit failed: %w", err)
	}

	select {
	case <-done:
	case <-ctx.Done():
		orch.Interrupt()
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

// sessionKeyFor normalizes req.SessionID into the sessions map key: id
// itself if it's safe to embed in want's session filename, or "" (a single
// shared orchestrator for every caller with no valid SessionID — mirrors
// the old design's "no isolation requested" behavior for single-caller/dev
// use, e.g. a direct API caller with no per-user session concept) otherwise.
func sessionKeyFor(id string) string {
	if sessionIDRE.MatchString(id) {
		return id
	}
	return ""
}
