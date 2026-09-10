//go:build integration

// Integration test for WantService.Complete's per-round-trip billing (see
// want.go's quota field doc comment and the "Recorded here" comment inside
// Complete's "agent.inference" subscription): usage must be recorded the
// instant each round-trip's usage event arrives, not only once at the end
// of a successful Complete call — a prompt whose connection is interrupted
// mid-run (ctx canceled while a later round-trip is still in flight) must
// not lose the tokens already spent on the round-trips that did complete.
// This can only be exercised against a real quota.Service (backed by
// Postgres), unlike want_test.go's other Complete tests, which pass a nil
// quota and never touch the database — see quota.New's doc comment on
// quota.Service having no interface seam to mock around its *gorm.DB.
//
// Run with:
//
//	go test -tags integration ./internal/inference/ \
//	  -args -dsn "postgres://onagent:onagent@localhost:5433/onagent?sslmode=disable"
package inference

import (
	"context"
	"database/sql"
	"flag"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/onagent/internal/quota"
	"github.com/tim72117/want/config"
	"github.com/tim72117/want/types"
)

var dsn = flag.String("dsn", "postgres://onagent:onagent@localhost:5433/onagent?sslmode=disable", "Postgres DSN")

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	sqlDB, err := database.DB()
	if err != nil {
		t.Fatalf("underlying *sql.DB: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return sqlDB
}

func makeTestUser(t *testing.T, conn *sql.DB, id int64, email string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
		id, email,
	); err != nil {
		t.Fatalf("insert test user %d: %v", id, err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup user %d: %v", id, err)
		}
	})
}

func makeTestApp(t *testing.T, conn *sql.DB, appID string, ownerID int64) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO apps (app_id, owner_id) VALUES ($1, $2)`,
		appID, ownerID,
	); err != nil {
		t.Fatalf("insert test app %s: %v", appID, err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID); err != nil {
			t.Errorf("cleanup app %s: %v", appID, err)
		}
	})
}

// blockingTool never returns on its own — it blocks until the test itself
// closes release, simulating "the second round-trip's tool call is still in
// flight" for as long as the test needs to hold that state before canceling
// ctx out from under Complete. Unlike noopTool (want_test.go), which exists
// to let a round finish immediately, this exists to let one deliberately
// not finish.
type blockingTool struct {
	types.BaseToolConfig
	release <-chan struct{}
}

func (b blockingTool) Call(types.ToolArguments, types.ToolContext) ([]types.ResultContentBlock, error) {
	<-b.release
	return []types.ResultContentBlock{types.TextBlock("done")}, nil
}
func (blockingTool) ValidateInput(types.ToolArguments, types.ToolContext) error { return nil }
func (blockingTool) RenderToolUse(types.ToolArguments) string                  { return "blocking" }
func (blockingTool) RenderToolUseError(error) string                           { return "blocking failed" }
func (blockingTool) RenderToolResult(map[string]interface{}) string            { return "blocking done" }

type blockingToolProvider struct{ release <-chan struct{} }

func (p blockingToolProvider) Declarations() []types.ToolDeclaration {
	return []types.ToolDeclaration{{Name: "block", Type: "sync", Parameters: map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}}}
}

func (p blockingToolProvider) GetFactory(name string) (types.ToolFactory, bool) {
	if name != "block" {
		return nil, false
	}
	return func() types.ToolInterface { return blockingTool{release: p.release} }, true
}

// TestComplete_RecordsUsagePerRoundTripEvenWhenCtxIsCanceledMidRun is the
// regression test for the bug fixed alongside per-request token usage
// tracking (see want.go's "Recorded here" comment): a two-round-trip
// prompt where round 1 completes (its usage event fires, want.go's
// subscription records it immediately) and round 2's tool call blocks
// indefinitely. Canceling ctx while round 2 is still in flight makes
// Complete return ctx.Err() — but round 1's tokens, already spent against
// the real LLM before the cancellation, must still be in usage_events.
// Before this fix, Record only ran once, after Complete returned
// successfully — a canceled Complete recorded nothing at all, silently
// losing round 1's real, billable cost.
func TestComplete_RecordsUsagePerRoundTripEvenWhenCtxIsCanceledMidRun(t *testing.T) {
	conn := openTestDB(t)
	database, err := db.Open(*dsn)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	quotaSvc := quota.New(database)

	const userID = 999910
	const appID = "want-billing-test-app"
	makeTestUser(t, conn, userID, "want-billing-test@example.com")
	makeTestApp(t, conn, appID, userID)
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM usage_events WHERE app_id = $1`, appID); err != nil {
			t.Errorf("cleanup usage_events for %s: %v", appID, err)
		}
	})

	scenario := t.TempDir() + "/scenario.json"
	// Round 1 finishes normally (with usage) and calls "block" — a
	// tool_use in a round keeps want's query loop going for a second
	// GenerateStream call (want internal/query.go), which is round 2 here.
	// Round 2 never gets a chance to report its own usage: blockingTool
	// hangs before returning a result, so want never reaches the point of
	// asking the mock provider for round 2's response at all.
	const scenarioJSON = `{"rounds":[
		{"contents":[{"type":"tool_use","tool_use":{"name":"block","input":{}}}],
		 "usage":{"prompt_tokens":500,"completion_tokens":25,"total_tokens":525}}
	]}`
	if err := os.WriteFile(scenario, []byte(scenarioJSON), 0644); err != nil {
		t.Fatalf("write scenario: %v", err)
	}

	s := NewWant(&config.Settings{Provider: "mock", MockScenario: scenario}, nil, nil, quotaSvc)
	const sessionID = "session-billing-interrupted"
	t.Cleanup(func() { s.CloseSession(sessionID) })

	orch, err := s.getOrCreate(sessionID, "")
	if err != nil {
		t.Fatalf("getOrCreate: %v", err)
	}
	release := make(chan struct{})
	orch.Toolbox = blockingToolProvider{release: release}
	t.Cleanup(func() {
		var once sync.Once
		once.Do(func() { close(release) }) // let the goroutine still inside blockingTool.Call exit, if any
	})

	ctx, cancel := context.WithCancel(context.Background())

	// completeErr/completeResult are only ever written by the goroutine
	// below and only ever read after <-completeDone, so no separate lock
	// is needed for them.
	var completeErr error
	completeDone := make(chan struct{})
	go func() {
		defer close(completeDone)
		_, completeErr = s.Complete(ctx, Request{
			Prompt: "go", SessionID: sessionID, AppID: appID, UserID: userID, RequestID: "req-interrupted-1",
		})
	}()

	// Give round 1 a real window to reach the mock provider, get its
	// usage event recorded, and block on "block" — this is inherently
	// timing-based (there's no synchronous hook into want's internal event
	// loop from here), but 2s is generous against a mock provider with no
	// real network calls in the round-trip preceding the block.
	deadline := time.Now().Add(2 * time.Second)
	var recordedTotal sql.NullInt64
	for time.Now().Before(deadline) {
		if err := conn.QueryRow(
			`SELECT total_tokens FROM usage_events WHERE app_id = $1 AND event_id = $2`,
			appID, "req-interrupted-1",
		).Scan(&recordedTotal); err == nil && recordedTotal.Valid {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !recordedTotal.Valid {
		t.Fatal("round 1's usage was never recorded within the timeout — either Complete never reached the tool call, or per-round-trip Record isn't firing")
	}
	if recordedTotal.Int64 != 525 {
		t.Errorf("round 1's recorded total_tokens = %d, want 525", recordedTotal.Int64)
	}

	// Now interrupt the connection — the caller's WebSocket closing while
	// round 2's tool call is still outstanding is exactly what cancels ctx
	// in the real ws.Session.handlePrompt path.
	cancel()

	select {
	case <-completeDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Complete did not return after ctx was canceled")
	}
	if completeErr == nil {
		t.Error("Complete returned no error after ctx was canceled — want ctx.Err()")
	}

	// The actual regression check: round 1's row must still be there after
	// Complete has returned its cancellation error — the fix under test is
	// that recording happens per-round-trip, independent of whether
	// Complete itself ever reaches a successful return.
	var total int
	if err := conn.QueryRow(
		`SELECT count(*) FROM usage_events WHERE app_id = $1 AND event_id = $2`,
		appID, "req-interrupted-1",
	).Scan(&total); err != nil {
		t.Fatalf("count usage_events: %v", err)
	}
	if total != 1 {
		t.Errorf("usage_events rows for the interrupted request = %d, want 1 (round 1's usage, recorded before the cancellation)", total)
	}
}
