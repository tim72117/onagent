//go:build integration

// Integration test for GET /admin/api/schema-check against a live Postgres.
// Excluded from the default build; run with:
//
//	go test -tags integration ./internal/adminconsole/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package adminconsole

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/adminauth"
	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/onagent/internal/quota"
)

// TestSchemaCheckReportsOkAgainstTheRealSchema is the sanity check: against
// schema.sql as actually applied, every table's struct definitions must
// agree with the database — no missing/extra columns, no primary-key
// mismatch. A failure here means a GORM row struct and schema.sql have
// drifted apart somewhere in the codebase, which AutoMigrate (not used
// here) would never have caught either.
func TestSchemaCheckReportsOkAgainstTheRealSchema(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()

	const email = "schema-check-test@example.com"
	const password = "supersecret123"
	sqlDB, _ := database.DB()
	conn := sqlDB
	_, _ = conn.Exec(`DELETE FROM admin_users WHERE lower(email) = lower($1)`, email)
	t.Cleanup(func() { _, _ = conn.Exec(`DELETE FROM admin_users WHERE lower(email) = lower($1)`, email) })

	adminAuth := adminauth.New(database, false)
	if _, err := adminAuth.Bootstrap(email, password); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	h := NewHandler(adminAuth, quota.New(database), database)
	mux := http.NewServeMux()
	h.Register(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(srv.URL+"/admin/api/login", "application/json",
		strings.NewReader(`{"email":"`+email+`","password":"`+password+`"}`))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	loginResp.Body.Close()
	if loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login = %d, want 200", loginResp.StatusCode)
	}

	// Unauthenticated calls are rejected, same fail-closed gate as every
	// other withAdmin route.
	if resp, err := http.Get(srv.URL + "/admin/api/schema-check"); err != nil {
		t.Fatalf("unauth GET: %v", err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauth /admin/api/schema-check = %d, want 401", resp.StatusCode)
		}
	}

	resp, err := client.Get(srv.URL + "/admin/api/schema-check")
	if err != nil {
		t.Fatalf("authed GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/admin/api/schema-check = %d, want 200", resp.StatusCode)
	}

	var got schemaCheckResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	if !got.Ok {
		t.Errorf("schema-check ok = false, want true against the real schema")
	}
	wantTables := []string{
		"users", "sessions", "user_tokens", "cli_auth_sessions", "apps",
		"tools", "subscriptions", "usage_events", "admin_users", "admin_sessions",
	}
	if len(got.Tables) != len(wantTables) {
		t.Fatalf("schema-check returned %d tables, want %d: %+v", len(got.Tables), len(wantTables), got.Tables)
	}
	byTable := make(map[string]bool, len(got.Tables))
	for _, c := range got.Tables {
		byTable[c.Table] = true
		if !c.Ok {
			t.Errorf("table %s: ok=false, missing=%v extra=%v pkMismatch=%+v",
				c.Table, c.MissingColumns, c.ExtraColumns, c.PrimaryKeyMismatch)
		}
	}
	for _, table := range wantTables {
		if !byTable[table] {
			t.Errorf("schema-check response missing table %q", table)
		}
	}
}
