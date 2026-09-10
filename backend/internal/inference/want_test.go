package inference

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/tim72117/want/config"
	"github.com/tim72117/want/orchestrator"
	"github.com/tim72117/want/types"
)

// writeEmptyScenario creates a minimal, valid mock-provider scenario file —
// just enough for orchestrator.InitializeWithConfig's Provider: "mock" case
// (want/orchestrator/init.go) to build a *provider.MockProvider
// successfully. These tests never call Complete()/Submit() — only
// getOrCreate/CloseSession — so the scenario's actual content (empty
// rounds) never matters; it only needs to parse.
func writeEmptyScenario(t *testing.T, path string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(`{"rounds":[]}`), 0644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

// TestGetOrCreate_DifferentSessionsGetDistinctOrchestrators is the core
// correctness guarantee behind swapping the old shared-orchestrator +
// mutex-guarded field-swapping design for per-session orchestrators: two
// different SessionIDs must never end up sharing one *orchestrator.Orchestrator,
// or they'd share one AgentID/Role/Toolbox/conversation history exactly the
// way this refactor set out to stop.
func TestGetOrCreate_DifferentSessionsGetDistinctOrchestrators(t *testing.T) {
	scenario := t.TempDir() + "/scenario.json"
	writeEmptyScenario(t, scenario)
	s := NewWant(&config.Settings{Provider: "mock", MockScenario: scenario}, nil, nil, nil)

	orchA, err := s.getOrCreate("session-a", "")
	if err != nil {
		t.Fatalf("getOrCreate(session-a): %v", err)
	}
	orchB, err := s.getOrCreate("session-b", "")
	if err != nil {
		t.Fatalf("getOrCreate(session-b): %v", err)
	}

	if orchA == orchB {
		t.Fatal("two different session ids resolved to the same *orchestrator.Orchestrator instance")
	}
	if orchA.AgentID == orchB.AgentID {
		t.Errorf("distinct sessions got the same AgentID %q; each session must have its own", orchA.AgentID)
	}
	if orchA.AgentID != "WS-session-a" {
		t.Errorf("orchA.AgentID = %q, want %q", orchA.AgentID, "WS-session-a")
	}
	if orchB.AgentID != "WS-session-b" {
		t.Errorf("orchB.AgentID = %q, want %q", orchB.AgentID, "WS-session-b")
	}
}

// TestGetOrCreate_SameSessionReturnsSameOrchestrator ensures a session's
// second (and later) Complete call reuses its existing orchestrator instead
// of silently building a new one each time — which would both leak the
// previous one's dispatch goroutine (nothing would ever call Stop() on it)
// and reset conversation history/AgentID on every single prompt.
func TestGetOrCreate_SameSessionReturnsSameOrchestrator(t *testing.T) {
	scenario := t.TempDir() + "/scenario.json"
	writeEmptyScenario(t, scenario)
	s := NewWant(&config.Settings{Provider: "mock", MockScenario: scenario}, nil, nil, nil)

	first, err := s.getOrCreate("session-a", "")
	if err != nil {
		t.Fatalf("getOrCreate first call: %v", err)
	}
	second, err := s.getOrCreate("session-a", "")
	if err != nil {
		t.Fatalf("getOrCreate second call: %v", err)
	}

	if first != second {
		t.Fatal("the same session id resolved to two different *orchestrator.Orchestrator instances")
	}
}

// TestCloseSession_ReleasesAndReclaimsGoroutine verifies CloseSession both
// removes the session from the map (a later call with the same id builds a
// fresh orchestrator rather than resurrecting the closed one) and actually
// lets its dispatch goroutine (want.Orchestrator.Start's background loop)
// exit — without this, every connection that ever completed a prompt would
// leak one goroutine for the life of the process, growing without bound as
// users connect and disconnect (see want.go's package doc comment).
func TestCloseSession_ReleasesAndReclaimsGoroutine(t *testing.T) {
	scenario := t.TempDir() + "/scenario.json"
	writeEmptyScenario(t, scenario)
	s := NewWant(&config.Settings{Provider: "mock", MockScenario: scenario}, nil, nil, nil)

	before := runtime.NumGoroutine()

	orch, err := s.getOrCreate("session-a", "")
	if err != nil {
		t.Fatalf("getOrCreate: %v", err)
	}
	_ = orch

	// Give Start()'s dispatch goroutine a moment to actually spin up before
	// measuring — it's launched synchronously inside Start(), but scheduling
	// the very first run of a newly spawned goroutine isn't instantaneous.
	waitForGoroutineCount(t, before+1, 2*time.Second)

	s.CloseSession("session-a")

	// Stop() closes activationQueue, which only unblocks the dispatch
	// goroutine's `for cmd := range activationQueue` on its next scheduler
	// turn — not synchronously within the Stop() call itself.
	waitForGoroutineCount(t, before, 2*time.Second)

	s.mu.Lock()
	_, stillPresent := s.sessions["session-a"]
	s.mu.Unlock()
	if stillPresent {
		t.Error("CloseSession did not remove the session from the sessions map")
	}

	// A later call with the same id must build a fresh orchestrator, not
	// resurrect the stopped one — Submit/Resume on a stopped orchestrator
	// return ErrOrchestratorStopped rather than working.
	rebuilt, err := s.getOrCreate("session-a", "")
	if err != nil {
		t.Fatalf("getOrCreate after CloseSession: %v", err)
	}
	if rebuilt == orch {
		t.Error("getOrCreate after CloseSession returned the same, now-stopped orchestrator instance")
	}
}

// TestGetOrCreate_ConcurrentSessionsAreRaceFree exercises the two things
// getOrCreate actually needs to protect against concurrent callers: (1)
// s.initOnce must run orchestrator.InitializeWithConfig exactly once even
// when many sessions' first Complete calls race to create it (see want.go's
// package doc comment on why calling it more than once per process is
// unsafe), and (2) s.mu must keep the sessions map's read-modify-write
// (lookup, then insert-if-missing) atomic across goroutines. Run with
// `go test -race` to have anything meaningful to check: without -race this
// test only proves no panic, not the absence of a data race.
func TestGetOrCreate_ConcurrentSessionsAreRaceFree(t *testing.T) {
	scenario := t.TempDir() + "/scenario.json"
	writeEmptyScenario(t, scenario)
	s := NewWant(&config.Settings{Provider: "mock", MockScenario: scenario}, nil, nil, nil)

	const n = 50
	var wg sync.WaitGroup
	errs := make([]error, n)
	orchs := make([]*orchestrator.Orchestrator, n)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			orch, err := s.getOrCreate(fmt.Sprintf("session-%d", i), "")
			errs[i] = err
			orchs[i] = orch
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("getOrCreate(session-%d): %v", i, err)
		}
	}
	seen := make(map[*orchestrator.Orchestrator]int, n)
	for i, orch := range orchs {
		if prev, ok := seen[orch]; ok {
			t.Errorf("session-%d and session-%d resolved to the same orchestrator instance", prev, i)
		}
		seen[orch] = i
	}
}

// noopTool is a synchronous, non-blocking types.ToolInterface — unlike
// agent_roles.go's forwardingTool/queryTool, which both block on askPage
// waiting for a connected page that doesn't exist in this test. Used only to
// give TestComplete_SumsUsageAcrossToolUseRounds' scenario a real tool to
// call, forcing want's internal query loop (want internal/query.go: a round
// containing tool_use keeps the loop going for another GenerateStream call)
// through a second real round-trip within one Submit.
type noopTool struct{ types.BaseToolConfig }

func (noopTool) Call(types.ToolArguments, types.ToolContext) ([]types.ResultContentBlock, error) {
	return []types.ResultContentBlock{types.TextBlock("done")}, nil
}
func (noopTool) ValidateInput(types.ToolArguments, types.ToolContext) error { return nil }
func (noopTool) RenderToolUse(types.ToolArguments) string                  { return "using noop" }
func (noopTool) RenderToolUseError(error) string                           { return "noop failed" }
func (noopTool) RenderToolResult(map[string]interface{}) string            { return "noop done" }

// noopToolProvider declares exactly one callable tool, "noop" — enough for
// the scenario's round 1 tool_use to resolve to a real, non-blocking
// factory via GetFactory (want internal/agent_tool.go's DispatchToolCall).
type noopToolProvider struct{}

func (noopToolProvider) Declarations() []types.ToolDeclaration {
	return []types.ToolDeclaration{{Name: "noop", Type: "sync", Parameters: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}}}
}

func (noopToolProvider) GetFactory(name string) (types.ToolFactory, bool) {
	if name != "noop" {
		return nil, false
	}
	return func() types.ToolInterface { return noopTool{} }, true
}

// writeToolUseThenTextScenario creates a mock-provider scenario with two
// rounds, each carrying its own usage: round 1 calls the "noop" tool (which
// keeps want's query loop going for a second round — see noopTool's doc
// comment), round 2 replies with plain text (no tool_use, which ends the
// loop). This is what actually drives two real provider round-trips inside
// one Submit call, unlike two independent Complete calls, which build no
// evidence about summation within a single turn.
func writeToolUseThenTextScenario(t *testing.T, path string) {
	t.Helper()
	const scenario = `{"rounds":[
		{"contents":[{"type":"tool_use","tool_use":{"name":"noop","input":{}}}],
		 "usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}},
		{"contents":[{"type":"text","text":"done"}],
		 "usage":{"prompt_tokens":140,"completion_tokens":10,"total_tokens":150}}
	]}`
	if err := os.WriteFile(path, []byte(scenario), 0644); err != nil {
		t.Fatalf("WriteFile(%q): %v", path, err)
	}
}

// TestComplete_SumsUsageAcrossToolUseRounds is the acceptance check for the
// token-usage feature added to Result/want.go: a single Complete call whose
// want run makes two real provider round-trips (a tool-use round, then the
// reply that follows it) must return their usage SUMMED via types.Usage.Add
// — see inference.go's Result.Usage doc comment — not just the last round's
// numbers, and not nil despite two separate usage events arriving on the
// "agent.inference" topic.
func TestComplete_SumsUsageAcrossToolUseRounds(t *testing.T) {
	scenario := t.TempDir() + "/scenario.json"
	writeToolUseThenTextScenario(t, scenario)
	s := NewWant(&config.Settings{Provider: "mock", MockScenario: scenario}, nil, nil, nil)
	t.Cleanup(func() { s.CloseSession("session-usage") })

	orch, err := s.getOrCreate("session-usage", "")
	if err != nil {
		t.Fatalf("getOrCreate: %v", err)
	}
	orch.Toolbox = noopToolProvider{}

	result, err := s.Complete(context.Background(), Request{Prompt: "go", SessionID: "session-usage"})
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if result.Usage == nil {
		t.Fatal("Result.Usage is nil, want the two rounds' usage summed")
	}
	wantUsage := types.Usage{PromptTokens: 240, CompletionTokens: 30, TotalTokens: 270}
	if *result.Usage != wantUsage {
		t.Errorf("Result.Usage = %+v, want %+v (sum of both rounds' usage, not just the last one)", *result.Usage, wantUsage)
	}
}

// waitForGoroutineCount polls runtime.NumGoroutine() until it reaches want,
// or fails the test after timeout. Goroutine counts are inherently
// non-deterministic to check synchronously (GC workers, scheduler
// housekeeping), so this tolerates the count settling a moment after the
// triggering call returns, rather than asserting it immediately.
func waitForGoroutineCount(t *testing.T, want int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if got := runtime.NumGoroutine(); got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("runtime.NumGoroutine() = %d, want %d (timed out waiting)", runtime.NumGoroutine(), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
