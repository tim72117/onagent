//go:build integration

// End-to-end HTTP test for the admin API against a live Postgres. Spins up
// the real handler with httptest, exercises login → authed call, and
// verifies the withAdmin gate is fail-closed. Run with:
//
//	go test -tags integration ./internal/adminconsole/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package adminconsole

import (
	"flag"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/adminauth"
	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/onagent/internal/quota"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

func TestAdminAPIEndToEnd(t *testing.T) {
	conn, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer conn.Close()

	const email = "admin-api-test@example.com"
	const password = "supersecret123"
	_, _ = conn.Exec(`DELETE FROM admin_users WHERE lower(email) = lower($1)`, email)
	t.Cleanup(func() { _, _ = conn.Exec(`DELETE FROM admin_users WHERE lower(email) = lower($1)`, email) })

	adminAuth := adminauth.New(conn, false)
	if _, err := adminAuth.Bootstrap(email, password); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}

	h := NewHandler(adminAuth, quota.New(conn))
	mux := http.NewServeMux()
	h.Register(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// 1. An unauthenticated call to a withAdmin route is rejected (401).
	//    This is the fail-closed core: no cookie ⇒ no access.
	if resp, err := http.Get(srv.URL + "/admin/api/users"); err != nil {
		t.Fatalf("unauth GET: %v", err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauth /admin/api/users = %d, want 401", resp.StatusCode)
		}
	}

	// 2. Wrong password does not log in.
	if resp, err := http.Post(srv.URL+"/admin/api/login", "application/json",
		strings.NewReader(`{"email":"`+email+`","password":"nope"}`)); err != nil {
		t.Fatalf("bad login: %v", err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("bad-password login = %d, want 401", resp.StatusCode)
		}
	}

	// 3. Correct login sets an admin_session cookie; a jar-backed client then
	//    reaches the authed route.
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	client := &http.Client{Jar: jar}
	resp, err := client.Post(srv.URL+"/admin/api/login", "application/json",
		strings.NewReader(`{"email":"`+email+`","password":"`+password+`"}`))
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login = %d, want 200", resp.StatusCode)
	}
	srvURL, _ := url.Parse(srv.URL)
	sawAdminCookie := false
	for _, c := range jar.Cookies(srvURL) {
		if c.Name == adminauth.CookieName {
			sawAdminCookie = true
		}
	}
	if !sawAdminCookie {
		t.Fatalf("login did not set the %q cookie", adminauth.CookieName)
	}

	// 4. Authed call now succeeds.
	if resp, err := client.Get(srv.URL + "/admin/api/users"); err != nil {
		t.Fatalf("authed GET: %v", err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("authed /admin/api/users = %d, want 200", resp.StatusCode)
		}
	}

	// 5. plans endpoint returns the free plan at least.
	if resp, err := client.Get(srv.URL + "/admin/api/plans"); err != nil {
		t.Fatalf("plans GET: %v", err)
	} else {
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("/admin/api/plans = %d, want 200", resp.StatusCode)
		}
	}
}
