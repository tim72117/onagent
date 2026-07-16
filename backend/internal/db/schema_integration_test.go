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

	// Clean up (apps CASCADE removes usage_events; then the user).
	mustExec(t, conn, `DELETE FROM apps WHERE app_id='quota-verify-app'`)
	mustExec(t, conn, `DELETE FROM users WHERE id=999999`)
}

func mustExec(t *testing.T, conn *sql.DB, q string) {
	t.Helper()
	if _, err := conn.Exec(q); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}
