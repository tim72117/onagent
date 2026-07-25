//go:build integration

// Integration test for the real schema against a live Postgres. Excluded
// from the default `go test` build (needs a database); run explicitly with:
//
//	go test -tags integration ./internal/db/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
//
// or rely on the default dev DSN below when the local dev Postgres is up.
package db

import (
	"database/sql"
	"flag"
	"testing"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN for the integration test")

// TestSchemaApplyIsIdempotent applies schema.sql twice (Open does it once
// per call) and verifies the second apply is a no-op, then confirms the
// quota tables/indexes exist and the (app_id, event_id) idempotency
// constraint actually collapses duplicate inserts to one row.
func TestSchemaApplyIsIdempotent(t *testing.T) {
	conn, err := Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	defer conn.Close()

	// Second apply must not error (every statement is CREATE ... IF NOT
	// EXISTS / ADD COLUMN IF NOT EXISTS).
	conn2, err := Open(*dsn)
	if err != nil {
		t.Fatalf("re-applying schema was not idempotent: %v", err)
	}
	conn2.Close()

	for _, c := range []struct {
		label string
		query string
	}{
		{"subscriptions table", `SELECT to_regclass('public.subscriptions') IS NOT NULL`},
		{"usage_events table", `SELECT to_regclass('public.usage_events') IS NOT NULL`},
		{"idempotency index", `SELECT count(*)=1 FROM pg_indexes WHERE indexname='usage_events_app_id_event_id_idx'`},
		{"lookup index", `SELECT count(*)=1 FROM pg_indexes WHERE indexname='usage_events_app_id_created_at_idx'`},
	} {
		var ok bool
		if err := conn.QueryRow(c.query).Scan(&ok); err != nil {
			t.Fatalf("%s check errored: %v", c.label, err)
		}
		if !ok {
			t.Errorf("%s: not present after schema apply", c.label)
		}
	}

	// Idempotency in practice: three inserts of the same (app_id, event_id)
	// must leave exactly one row. Uses throwaway user/app rows, cleaned up
	// via CASCADE at the end.
	mustExec(t, conn, `INSERT INTO users (id, email, password_hash) VALUES (999999, 'quotatest@example.com', 'x') ON CONFLICT DO NOTHING`)
	mustExec(t, conn, `INSERT INTO apps (app_id, owner_id) VALUES ('quota-verify-app', 999999) ON CONFLICT DO NOTHING`)
	mustExec(t, conn, `DELETE FROM usage_events WHERE app_id='quota-verify-app'`)
	for i := 0; i < 3; i++ {
		mustExec(t, conn, `INSERT INTO usage_events (app_id, event_id, kind) VALUES ('quota-verify-app','req-1','prompt') ON CONFLICT (app_id,event_id) DO NOTHING`)
	}
	var n int
	if err := conn.QueryRow(`SELECT count(*) FROM usage_events WHERE app_id='quota-verify-app'`).Scan(&n); err != nil {
		t.Fatalf("count usage_events: %v", err)
	}
	if n != 1 {
		t.Errorf("idempotency broken: 3 inserts of same event_id → count=%d, want 1", n)
	}

	// Clean up. Deleting the app no longer removes its usage rows (they're
	// ON DELETE SET NULL now — see TestDeletingAnAppKeepsItsUsageLedger), so
	// the ledger rows go with the user's own CASCADE instead.
	mustExec(t, conn, `DELETE FROM apps WHERE app_id='quota-verify-app'`)
	mustExec(t, conn, `DELETE FROM users WHERE id=999999`)
}

// TestDeletingAnAppKeepsItsUsageLedger pins the fix for a quota bypass:
// usage_events.app_id used to be ON DELETE CASCADE, and usage was counted by
// joining usage_events back to apps. Deleting an app therefore erased its
// billing history, so delete-app/recreate-app reset the month's usage to
// zero — self-service, unlimited, free.
//
// The ledger now carries its own owner_id and the FK is ON DELETE SET NULL,
// so the rows (and the count) survive the app they were recorded against.
func TestDeletingAnAppKeepsItsUsageLedger(t *testing.T) {
	conn, err := Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	defer conn.Close()

	// Dedicated ids so this never collides with real data or the other test.
	const userID = 999998
	const appID = "quota-delete-app"

	cleanup := func() {
		mustExec(t, conn, `DELETE FROM apps WHERE app_id='`+appID+`'`)
		mustExec(t, conn, `DELETE FROM users WHERE id=999998`)
	}
	cleanup()
	defer cleanup()

	mustExec(t, conn, `INSERT INTO users (id, email, password_hash) VALUES (999998, 'quotadelete@example.com', 'x')`)
	mustExec(t, conn, `INSERT INTO apps (app_id, owner_id) VALUES ('`+appID+`', 999998)`)

	// Record two prompts the way quota.Record does: owner_id resolved from
	// the app at write time, not joined back at read time.
	for _, ev := range []string{"req-a", "req-b"} {
		mustExec(t, conn, `
			INSERT INTO usage_events (app_id, owner_id, event_id, kind)
			SELECT '`+appID+`', a.owner_id, '`+ev+`', 'prompt'
			  FROM apps a WHERE a.app_id = '`+appID+`'
			ON CONFLICT (app_id, event_id) DO NOTHING`)
	}

	countForOwner := func() int {
		t.Helper()
		var n int
		if err := conn.QueryRow(
			`SELECT count(*) FROM usage_events WHERE owner_id=$1`, userID,
		).Scan(&n); err != nil {
			t.Fatalf("count usage for owner: %v", err)
		}
		return n
	}

	if got := countForOwner(); got != 2 {
		t.Fatalf("before delete: owner usage count=%d, want 2", got)
	}

	// The actual exploit: delete the app (a self-service action — see
	// console.Handler's DELETE /console/apps/{appId}).
	mustExec(t, conn, `DELETE FROM apps WHERE app_id='`+appID+`'`)

	if got := countForOwner(); got != 2 {
		t.Errorf("deleting the app reset billed usage: owner usage count=%d, want 2 — quota is bypassable by delete-and-recreate", got)
	}

	// The rows survive but are no longer attributed to a live app.
	var orphaned int
	if err := conn.QueryRow(
		`SELECT count(*) FROM usage_events WHERE owner_id=$1 AND app_id IS NULL`, userID,
	).Scan(&orphaned); err != nil {
		t.Fatalf("count orphaned rows: %v", err)
	}
	if orphaned != 2 {
		t.Errorf("app_id should be NULLed (not cascaded away) on app delete: got %d rows with NULL app_id, want 2", orphaned)
	}
}

func mustExec(t *testing.T, conn *sql.DB, q string) {
	t.Helper()
	if _, err := conn.Exec(q); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}
