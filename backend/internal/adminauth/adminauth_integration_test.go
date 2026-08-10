//go:build integration

// Integration tests for adminauth against a live Postgres. Excluded from
// the default build; run with:
//
//	go test -tags integration ./internal/adminauth/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package adminauth

import (
	"flag"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/db"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

func TestBootstrapAndLogin(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()
	sqlDB, _ := database.DB()
	conn := sqlDB

	// Clean slate for the test's bootstrap email.
	const email = "admin-integ-test@example.com"
	const password = "supersecret123"
	if _, err := conn.Exec(`DELETE FROM admin_users WHERE lower(email) = lower($1)`, email); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	t.Cleanup(func() {
		_, _ = conn.Exec(`DELETE FROM admin_users WHERE lower(email) = lower($1)`, email)
	})

	store := New(database, false)

	// Blank config is a no-op (no bootstrap requested).
	if created, err := store.Bootstrap("", ""); err != nil || created {
		t.Fatalf("blank bootstrap: created=%v err=%v, want false/nil", created, err)
	}

	// First real bootstrap creates the admin.
	created, err := store.Bootstrap(email, password)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if !created {
		t.Fatal("first bootstrap should have created the admin")
	}

	// Idempotent: a second bootstrap with the same email does NOT create
	// again and does NOT error (safe to run on every startup).
	created2, err := store.Bootstrap(email, password)
	if err != nil {
		t.Fatalf("second bootstrap: %v", err)
	}
	if created2 {
		t.Fatal("second bootstrap must not create a duplicate admin")
	}

	// Case-insensitivity: bootstrapping the same address with different
	// casing also must not create a duplicate — the unique index is on
	// lower(email), and the ON CONFLICT clause it backs is raw SQL under
	// GORM (see Bootstrap's comment) precisely to keep this guarantee.
	created3, err := store.Bootstrap(strings.ToUpper(email), password)
	if err != nil {
		t.Fatalf("differently-cased bootstrap: %v", err)
	}
	if created3 {
		t.Fatal("differently-cased email must collide with the existing admin, not create a second one")
	}
	var dupeCount int
	if err := conn.QueryRow(`SELECT count(*) FROM admin_users WHERE lower(email) = lower($1)`, email).Scan(&dupeCount); err != nil {
		t.Fatalf("count admins for %s: %v", email, err)
	}
	if dupeCount != 1 {
		t.Fatalf("admin rows for %s after case-variant bootstrap = %d, want 1", email, dupeCount)
	}

	// Correct credentials log in.
	admin, err := store.Login(email, password)
	if err != nil {
		t.Fatalf("login with correct password failed: %v", err)
	}
	if admin.Email != email {
		t.Errorf("logged-in admin email = %q, want %q", admin.Email, email)
	}

	// Wrong password is rejected with the opaque error (not a different one
	// that would let a prober distinguish wrong-password from unknown-email).
	if _, err := store.Login(email, "wrong-password"); err != ErrInvalidCredentials {
		t.Errorf("wrong password: got %v, want ErrInvalidCredentials", err)
	}

	// Unknown email is rejected identically.
	if _, err := store.Login("nobody@example.com", password); err != ErrInvalidCredentials {
		t.Errorf("unknown email: got %v, want ErrInvalidCredentials", err)
	}

	// Bootstrap must not RESET an existing admin's password: after a second
	// bootstrap attempt with a *different* password, the original still works
	// and the new one does not. This guards the "safe to run on every
	// startup" promise — a restart with a changed env var must not silently
	// reset a password that was later rotated through other means.
	if _, err := store.Bootstrap(email, "a-different-password-9999"); err != nil {
		t.Fatalf("re-bootstrap: %v", err)
	}
	if _, err := store.Login(email, password); err != nil {
		t.Errorf("original password stopped working after re-bootstrap: %v", err)
	}
	if _, err := store.Login(email, "a-different-password-9999"); err != ErrInvalidCredentials {
		t.Errorf("re-bootstrap wrongly changed the password")
	}
}
