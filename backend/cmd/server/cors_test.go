package main

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

// fakeRegistrar stands in for console.Handler / adminconsole.Handler in
// mountCredentialedRoutes tests — those real handlers need a live Postgres
// to construct, but mountCredentialedRoutes only ever calls Register, so a
// trivial fake registering marker routes is enough to prove the mux wiring
// itself (not any handler's business logic) is correct. patterns mirrors how
// the real console.Handler.Register puts both /console/* and /auth/*
// patterns on the one mux it's given (see console.go's Register).
type fakeRegistrar struct {
	patterns []string
}

func (f fakeRegistrar) Register(mux *http.ServeMux) {
	for _, p := range f.patterns {
		mux.HandleFunc(p, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
	}
}

// corsMiddleware is bound to a single allowlist per call site — this test
// pins that a middleware built for this project's own console origin trusts
// exactly that origin, and rejects a third-party developer app's origin
// even though such an origin would be perfectly valid on the *other*
// allowlist (APP_ORIGINS, used only by /ws). The two must never merge — see
// corsMiddleware's doc comment for the incident this replaced (ALLOWED_ORIGIN
// used to be an anyOf() of both).
func TestCORSMiddleware_TrustsOnlyItsOwnAllowlist(t *testing.T) {
	const consoleOrigin = "https://onagent.shuttle.tools"
	const thirdPartyAppOrigin = "https://some-developer-app.example.com"

	mw := corsMiddleware(allowlistChecker([]string{consoleOrigin}))
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	t.Run("console origin is trusted", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/console/apps", nil)
		req.Header.Set("Origin", consoleOrigin)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != consoleOrigin {
			t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, consoleOrigin)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
			t.Errorf("Access-Control-Allow-Credentials = %q, want %q", got, "true")
		}
	})

	t.Run("third-party app origin is rejected even though it's a valid APP_ORIGINS-style origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/console/apps", nil)
		req.Header.Set("Origin", thirdPartyAppOrigin)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("Access-Control-Allow-Origin = %q, want no header (origin not on this allowlist)", got)
		}
		if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
			t.Errorf("Access-Control-Allow-Credentials = %q, want no header", got)
		}
	})
}

// publicCORS is the codegen endpoints' policy: unconditionally "*", since no
// cookie ever rides with these requests — a third-party app's own site is
// exactly who's expected to fetch /apps/{appId}/tools.json.
func TestPublicCORS_AllowsAnyOrigin(t *testing.T) {
	handler := publicCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/apps/some-app/tools.json", nil)
	req.Header.Set("Origin", "https://some-developer-app.example.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, "*")
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want no header (public endpoint never sends credentials)", got)
	}
}

// TestMountCredentialedRoutes_WiresEachPrefixToTheSameAllowlist is the
// routing-level counterpart to TestCORSMiddleware_TrustsOnlyItsOwnAllowlist:
// that test proves the middleware function is correct in isolation, this
// one proves /console/*, /auth/*, and /admin/* are actually wired to it by
// mountCredentialedRoutes — a mistake here (e.g. one prefix accidentally
// mounted with publicCORS, or bound to the wrong allowlist) would pass every
// middleware-only test while still shipping a real CORS hole, since nothing
// would catch the wiring itself being wrong.
func TestMountCredentialedRoutes_WiresEachPrefixToTheSameAllowlist(t *testing.T) {
	const siteOrigin = "https://onagent.shuttle.tools"
	const thirdPartyAppOrigin = "https://some-developer-app.example.com"

	// The admin fake registers under /admin/api/, not /admin/ — mirroring
	// adminconsole.Handler.Register's real routes, which are all under
	// /admin/api/*. mountCredentialedRoutes depends on staying strictly
	// more specific than the literal "/admin/" pattern mountAdmin (web.go)
	// separately registers for the admin SPA's static assets; reusing
	// "/admin/" here would pass this test while still panicking at real
	// startup (ServeMux forbids registering the same literal pattern
	// twice) — this app must register a mux we also mount at a distinct
	// prefix, so an /admin/-mounted fake would silently hide that bug.
	mux := http.NewServeMux()
	mountCredentialedRoutes(mux,
		fakeRegistrar{patterns: []string{"/console/ping", "/auth/ping"}},
		fakeRegistrar{patterns: []string{"/admin/api/ping"}},
		allowlistChecker([]string{siteOrigin}),
	)

	cases := []struct {
		name   string
		path   string
		origin string
		wantCC bool // want Access-Control-Allow-Origin echoed back
	}{
		{"console trusts site origin", "/console/ping", siteOrigin, true},
		{"console rejects third-party app origin", "/console/ping", thirdPartyAppOrigin, false},
		{"auth trusts site origin", "/auth/ping", siteOrigin, true},
		{"auth rejects third-party app origin", "/auth/ping", thirdPartyAppOrigin, false},
		{"admin trusts site origin", "/admin/api/ping", siteOrigin, true},
		{"admin rejects third-party app origin", "/admin/api/ping", thirdPartyAppOrigin, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			req.Header.Set("Origin", tc.origin)
			rec := httptest.NewRecorder()

			mux.ServeHTTP(rec, req)

			got := rec.Header().Get("Access-Control-Allow-Origin")
			if tc.wantCC && got != tc.origin {
				t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, tc.origin)
			}
			if !tc.wantCC && got != "" {
				t.Errorf("Access-Control-Allow-Origin = %q, want no header", got)
			}
		})
	}
}

// TestFullMuxAssembly_DoesNotPanic reproduces main()'s actual mux-building
// sequence — mountCredentialedRoutes followed by mountStatic — end to end.
// This is the only test that would have caught the real incident this
// file's other tests missed: mountCredentialedRoutes used to mount the
// admin sub-mux at the literal pattern "/admin/", which is also registered
// by mountAdmin (web.go) for the admin SPA's static assets. Go's ServeMux
// panics at registration time when the same literal pattern is registered
// twice — go build, go vet, and every other test in this file passed
// anyway, because none of them ever called mountCredentialedRoutes and
// mountStatic against the *same* mux the way main() actually does. Fixed by
// mounting the admin sub-mux at "/admin/api/" instead, matching
// adminconsole.Handler.Register's own routes and staying strictly more
// specific than "/admin/".
func TestFullMuxAssembly_DoesNotPanic(t *testing.T) {
	mux := http.NewServeMux()
	mountCredentialedRoutes(mux,
		fakeRegistrar{patterns: []string{"/console/ping", "/auth/ping"}},
		fakeRegistrar{patterns: []string{"/admin/api/ping"}},
		allowlistChecker([]string{"https://onagent.shuttle.tools"}),
	)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("mux assembly panicked (this is exactly how the real server fails to start): %v", r)
		}
	}()
	mountStatic(mux, slog.New(slog.NewTextHandler(t.Output(), nil)))
}
