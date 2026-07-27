package inference

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/tim72117/want/orchestrator"
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
	s := NewWant(WantSettings{Provider: "mock", MockScenario: scenario}, nil)

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
	s := NewWant(WantSettings{Provider: "mock", MockScenario: scenario}, nil)

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
	s := NewWant(WantSettings{Provider: "mock", MockScenario: scenario}, nil)

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
	s := NewWant(WantSettings{Provider: "mock", MockScenario: scenario}, nil)

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
