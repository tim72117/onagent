//go:build integration

// Integration test for Store against a live Postgres, mirroring
// internal/db's schema_integration_test.go pattern (skip, don't fail, when
// no database is reachable). Run explicitly with:
//
//	go test -tags integration ./internal/sessionstore/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package sessionstore

import (
	"flag"
	"testing"

	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/want/types"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN for the integration test")

// openTestStore returns the raw, unscoped *Store — tests call .ForApp
// themselves so a test that needs two different apps' views (the
// cross-app-isolation tests below) can build both from the same underlying
// connection.
func openTestStore(t *testing.T) *Store {
	t.Helper()
	conn, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	t.Cleanup(func() {
		if sqlDB, err := conn.DB(); err == nil {
			sqlDB.Close()
		}
	})
	return New(conn)
}

// TestAppendAndLoad_RoundTripsInOrder is the store's core contract: what
// goes in via Append comes back out via Load, in the same order, with the
// same field values — since this is what lets want reconstruct a session's
// conversation across a process restart.
func TestAppendAndLoad_RoundTripsInOrder(t *testing.T) {
	s := openTestStore(t).ForApp("test-app")
	sessionID := "test-session-round-trip"
	t.Cleanup(func() { s.(types.SessionStoreDeleter).DeleteSession(sessionID) })
	s.(types.SessionStoreDeleter).DeleteSession(sessionID) // in case a prior failed run left rows behind

	first := types.Experience{Role: "user", Content: []types.Content{types.NewTextContent("hello")}}
	second := types.Experience{Role: "assistant", Content: []types.Content{types.NewTextContent("hi there")}}

	if err := s.Append(sessionID, first, "exp-1"); err != nil {
		t.Fatalf("Append(exp-1): %v", err)
	}
	if err := s.Append(sessionID, second, "exp-2"); err != nil {
		t.Fatalf("Append(exp-2): %v", err)
	}

	got, err := s.Load(sessionID)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("Load returned %d experiences, want 2", len(got))
	}
	if got[0].Role != "user" || got[1].Role != "assistant" {
		t.Errorf("Load order/roles = [%q, %q], want [user, assistant]", got[0].Role, got[1].Role)
	}
	if len(got[0].Content) != 1 || got[0].Content[0].Text != "hello" {
		t.Errorf("first experience content = %+v, want text %q", got[0].Content, "hello")
	}
}

// TestAppend_DuplicateIDIsNoOp verifies a repeated id for the same session
// doesn't duplicate the row — the guide leaves dedup to the implementer,
// and want's own callers may retry an Append after an ambiguous failure.
func TestAppend_DuplicateIDIsNoOp(t *testing.T) {
	s := openTestStore(t).ForApp("test-app")
	sessionID := "test-session-dup"
	deleter := s.(types.SessionStoreDeleter)
	t.Cleanup(func() { deleter.DeleteSession(sessionID) })
	deleter.DeleteSession(sessionID)

	exp := types.Experience{Role: "user", Content: []types.Content{types.NewTextContent("retry me")}}
	if err := s.Append(sessionID, exp, "exp-dup"); err != nil {
		t.Fatalf("first Append: %v", err)
	}
	if err := s.Append(sessionID, exp, "exp-dup"); err != nil {
		t.Fatalf("second Append (same id): %v", err)
	}

	got, err := s.Load(sessionID)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("Load returned %d experiences after duplicate Append, want 1", len(got))
	}
}

// TestLoad_UnknownSessionReturnsEmptyNotError confirms "no history yet" is a
// normal starting state (an empty slice), not a failure a caller needs to
// special-case.
func TestLoad_UnknownSessionReturnsEmptyNotError(t *testing.T) {
	s := openTestStore(t).ForApp("test-app")

	got, err := s.Load("test-session-never-seen")
	if err != nil {
		t.Fatalf("Load on unknown session: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("Load on unknown session returned %d experiences, want 0", len(got))
	}
}

// TestDeleteSession_RemovesOnlyThatSessionsRows confirms DeleteSession
// (the optional SessionStoreDeleter method) scopes correctly and doesn't
// clear other sessions' history.
func TestDeleteSession_RemovesOnlyThatSessionsRows(t *testing.T) {
	s := openTestStore(t).ForApp("test-app")
	deleter := s.(types.SessionStoreDeleter)
	target := "test-session-delete-target"
	other := "test-session-delete-other"
	t.Cleanup(func() { deleter.DeleteSession(target); deleter.DeleteSession(other) })
	deleter.DeleteSession(target)
	deleter.DeleteSession(other)

	exp := types.Experience{Role: "user", Content: []types.Content{types.NewTextContent("x")}}
	if err := s.Append(target, exp, "exp-1"); err != nil {
		t.Fatalf("Append(target): %v", err)
	}
	if err := s.Append(other, exp, "exp-1"); err != nil {
		t.Fatalf("Append(other): %v", err)
	}

	if err := deleter.DeleteSession(target); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	gotTarget, err := s.Load(target)
	if err != nil {
		t.Fatalf("Load(target): %v", err)
	}
	if len(gotTarget) != 0 {
		t.Errorf("Load(target) after DeleteSession returned %d rows, want 0", len(gotTarget))
	}

	gotOther, err := s.Load(other)
	if err != nil {
		t.Fatalf("Load(other): %v", err)
	}
	if len(gotOther) != 1 {
		t.Errorf("Load(other) after deleting target returned %d rows, want 1 (untouched)", len(gotOther))
	}
}

// TestFlush_IsANoOp confirms Flush never errors — every Append is already
// synchronous, so there's no buffer for it to drain.
func TestFlush_IsANoOp(t *testing.T) {
	s := openTestStore(t).ForApp("test-app")
	if err := s.Flush("any-session-id"); err != nil {
		t.Errorf("Flush returned an error: %v, want nil", err)
	}
}

// TestForApp_LoadDoesNotCrossAppBoundary is the actual security property
// docs/sessionstore-architecture-review-2026-08-14.md's #1/#3 exist to fix:
// two different apps' scoped stores, given the exact same sessionID, must
// never see each other's history — even a caller with no valid SessionID
// (want.go's sessionKeyFor "" fallback, shared by every such caller) is
// still isolated by appID.
func TestForApp_LoadDoesNotCrossAppBoundary(t *testing.T) {
	raw := openTestStore(t)
	appA := raw.ForApp("test-app-a")
	appB := raw.ForApp("test-app-b")
	sessionID := "test-session-shared-id" // deliberately the same for both apps

	deleterA := appA.(types.SessionStoreDeleter)
	deleterB := appB.(types.SessionStoreDeleter)
	t.Cleanup(func() { deleterA.DeleteSession(sessionID); deleterB.DeleteSession(sessionID) })
	deleterA.DeleteSession(sessionID)
	deleterB.DeleteSession(sessionID)

	expA := types.Experience{Role: "user", Content: []types.Content{types.NewTextContent("app A's secret")}}
	if err := appA.Append(sessionID, expA, "exp-a-1"); err != nil {
		t.Fatalf("Append(appA): %v", err)
	}

	gotB, err := appB.Load(sessionID)
	if err != nil {
		t.Fatalf("Load(appB): %v", err)
	}
	if len(gotB) != 0 {
		t.Fatalf("app B's Load(%q) returned %d rows from app A's history, want 0 — cross-app leak", sessionID, len(gotB))
	}

	gotA, err := appA.Load(sessionID)
	if err != nil {
		t.Fatalf("Load(appA): %v", err)
	}
	if len(gotA) != 1 {
		t.Fatalf("app A's own Load(%q) returned %d rows, want 1 (its own write)", sessionID, len(gotA))
	}

	// DeleteSession must be equally scoped: app B deleting this sessionID
	// must not touch app A's rows recorded under the same id.
	if err := deleterB.DeleteSession(sessionID); err != nil {
		t.Fatalf("DeleteSession(appB): %v", err)
	}
	gotAAfter, err := appA.Load(sessionID)
	if err != nil {
		t.Fatalf("Load(appA) after appB's DeleteSession: %v", err)
	}
	if len(gotAAfter) != 1 {
		t.Errorf("app B's DeleteSession removed app A's row: got %d, want 1 (untouched)", len(gotAAfter))
	}
}
