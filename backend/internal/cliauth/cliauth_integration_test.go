//go:build integration

// Integration tests for cliauth against a live Postgres. This package is
// the security core of the CLI device-flow login (see cliauth.go's package
// doc): Approve and Exchange each rely on a single conditional UPDATE/SELECT
// pair, not a check-then-write pattern, to guarantee single-use semantics.
// These tests exist to catch a regression where a future rewrite (e.g. to
// GORM) replaces that conditional statement with a "Find then Save" style
// that reopens the race window it was built to close.
//
// Excluded from the default build; run with:
//
//	go test -tags integration ./internal/cliauth/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package cliauth

import (
	"flag"
	"sync"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/db"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

func TestCLIAuthFlow(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()
	sqlDB, _ := database.DB()
	conn := sqlDB
	store := New(database)

	cleanupIDs := func(ids ...string) {
		for _, id := range ids {
			_, _ = conn.Exec(`DELETE FROM cli_auth_sessions WHERE id = $1`, id)
		}
	}

	t.Run("basic flow: Start, NameFor, Approve, Exchange", func(t *testing.T) {
		id, err := store.Start("http://localhost:5555/callback", "my-test-cli")
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		t.Cleanup(func() { cleanupIDs(id) })

		name, ok := store.NameFor(id)
		if !ok {
			t.Fatal("NameFor: ok = false, want true for a freshly started session")
		}
		if name != "my-test-cli" {
			t.Errorf("NameFor: name = %q, want %q", name, "my-test-cli")
		}

		const token = "test-token-abc123"
		redirectURI, ok := store.Approve(id, token)
		if !ok {
			t.Fatal("Approve: ok = false on first call, want true")
		}
		if redirectURI != "http://localhost:5555/callback" {
			t.Errorf("Approve: redirectURI = %q, want %q", redirectURI, "http://localhost:5555/callback")
		}

		got, ok := store.Exchange(id)
		if !ok {
			t.Fatal("Exchange: ok = false, want true after Approve")
		}
		if got != token {
			t.Errorf("Exchange: token = %q, want %q", got, token)
		}
	})

	t.Run("Approve is single-use: second Approve on same id must fail", func(t *testing.T) {
		id, err := store.Start("http://127.0.0.1:6000/cb", "single-use-test")
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		t.Cleanup(func() { cleanupIDs(id) })

		if _, ok := store.Approve(id, "first-token"); !ok {
			t.Fatal("first Approve: ok = false, want true")
		}

		// SECURITY-CRITICAL: a second Approve on the same session must be
		// rejected. If this ever starts returning ok=true, the conditional
		// UPDATE's "approved = false" guard has been lost (e.g. rewritten
		// as a naive Find-then-Save), and a session could be re-approved to
		// capture a second token.
		redirectURI, ok := store.Approve(id, "second-token")
		if ok {
			t.Fatalf("SECURITY REGRESSION: second Approve on an already-approved session succeeded (redirectURI=%q); single-use guarantee is broken", redirectURI)
		}

		// The originally approved token must still be the one on record,
		// untouched by the rejected second Approve.
		got, ok := store.Exchange(id)
		if !ok {
			t.Fatal("Exchange after rejected re-approve: ok = false, want true")
		}
		if got != "first-token" {
			t.Errorf("Exchange after rejected re-approve: token = %q, want %q (must not have been overwritten)", got, "first-token")
		}
	})

	t.Run("expired session cannot be Approved", func(t *testing.T) {
		// Start() always sets a future expires_at, so an expired row is
		// inserted directly here via raw SQL — this is test infrastructure,
		// not a change to cliauth.go itself.
		id := "expired-test-" + randomIDMustSucceed(t)
		_, err := conn.Exec(
			`INSERT INTO cli_auth_sessions (id, redirect_uri, name, expires_at) VALUES ($1, $2, $3, $4)`,
			id, "http://localhost:7000/cb", "expired-test", time.Now().Add(-time.Minute),
		)
		if err != nil {
			t.Fatalf("insert expired row: %v", err)
		}
		t.Cleanup(func() { cleanupIDs(id) })

		if _, ok := store.Approve(id, "should-not-work"); ok {
			t.Fatal("Approve on an expired session returned ok = true, want false")
		}
	})

	t.Run("Exchange is single-use: second Exchange on same id must fail", func(t *testing.T) {
		id, err := store.Start("http://localhost:8000/cb", "exchange-once-test")
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		t.Cleanup(func() { cleanupIDs(id) })

		if _, ok := store.Approve(id, "replay-test-token"); !ok {
			t.Fatal("Approve: ok = false, want true")
		}

		got, ok := store.Exchange(id)
		if !ok {
			t.Fatal("first Exchange: ok = false, want true")
		}
		if got != "replay-test-token" {
			t.Errorf("first Exchange: token = %q, want %q", got, "replay-test-token")
		}

		// SECURITY-CRITICAL: replaying Exchange on the same id must fail,
		// since the token column was cleared to NULL on first collection.
		if got2, ok := store.Exchange(id); ok {
			t.Fatalf("SECURITY REGRESSION: second Exchange on the same session succeeded (token=%q); replay guarantee is broken", got2)
		}
	})

	t.Run("unapproved session cannot be Exchanged", func(t *testing.T) {
		id, err := store.Start("http://localhost:9000/cb", "never-approved-test")
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		t.Cleanup(func() { cleanupIDs(id) })

		if token, ok := store.Exchange(id); ok {
			t.Fatalf("Exchange on an unapproved session succeeded (token=%q), want ok = false", token)
		}
	})

	t.Run("concurrent Approve calls: exactly one of two must succeed", func(t *testing.T) {
		id, err := store.Start("http://localhost:9100/cb", "concurrent-test")
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
		t.Cleanup(func() { cleanupIDs(id) })

		var wg sync.WaitGroup
		results := make([]bool, 2)
		wg.Add(2)
		for i := 0; i < 2; i++ {
			go func(i int) {
				defer wg.Done()
				_, ok := store.Approve(id, "concurrent-token")
				results[i] = ok
			}(i)
		}
		wg.Wait()

		successes := 0
		for _, ok := range results {
			if ok {
				successes++
			}
		}
		if successes != 1 {
			t.Fatalf("SECURITY REGRESSION: %d of 2 concurrent Approve calls succeeded, want exactly 1 (single-use guarantee relies on the DB-level conditional UPDATE, not application-level locking)", successes)
		}
	})
}

func randomIDMustSucceed(t *testing.T) string {
	t.Helper()
	id, err := randomID()
	if err != nil {
		t.Fatalf("randomID: %v", err)
	}
	return id
}
