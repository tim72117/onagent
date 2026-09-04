package ws

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tim72117/onagent/internal/auth"
)

// fakeResolver is a test-only AppResolver whose ResolveApp result is fixed
// at construction — lets these tests exercise Handler.ServeHTTP's dispatch
// branches without a real auth.Store/toolschema.Registry/quota.Service,
// none of which have a fake/in-memory implementation in this codebase (see
// handler_integration_test.go for APIKeyResolver's own DB-backed behavior).
type fakeResolver struct {
	appID, sessionID string
	ok               bool
	msg              string
	code             int
	called           bool
}

func (f *fakeResolver) ResolveApp(r *http.Request) (appID, sessionID string, ok bool, msg string, code int) {
	f.called = true
	return f.appID, f.sessionID, f.ok, f.msg, f.code
}

func newTestHandler() *Handler {
	return &Handler{
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

// TestAPIKeyResolver_NilAuthOrLogFailsClosed covers the defense-in-depth
// guard at the top of ResolveApp: a misconstructed APIKeyResolver (nil Auth
// or Log — every real construction site in cmd/server/main.go sets both)
// must reject the handshake with a clear 503 rather than panicking on a nil
// receiver a few lines later (a.Auth.Verify / a.Log.Info). No database
// needed — the guard runs before either field is touched.
func TestAPIKeyResolver_NilAuthOrLogFailsClosed(t *testing.T) {
	cases := []struct {
		name     string
		resolver *APIKeyResolver
	}{
		{"nil Auth", &APIKeyResolver{Auth: nil, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}},
		{"nil Log", &APIKeyResolver{Auth: &auth.Store{}, Log: nil}},
		{"both nil", &APIKeyResolver{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/ws?token=irrelevant", nil)
			_, _, ok, _, code := tc.resolver.ResolveApp(req)
			if ok {
				t.Fatal("ResolveApp ok = true, want false")
			}
			if code != http.StatusServiceUnavailable {
				t.Errorf("ResolveApp code = %d, want %d", code, http.StatusServiceUnavailable)
			}
		})
	}
}

// TestServeHTTP_ResolverRejectionNeverUpgrades confirms a resolver that
// rejects the handshake produces exactly the HTTP status/body it returned,
// and never attempts the WebSocket upgrade — the upgrade would otherwise
// hijack the connection out from under httptest.NewRecorder with a
// confusing failure unrelated to auth.
func TestServeHTTP_ResolverRejectionNeverUpgrades(t *testing.T) {
	h := newTestHandler()
	resolver := &fakeResolver{ok: false, msg: "invalid or missing token", code: http.StatusUnauthorized}
	h.Resolver = resolver

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if !resolver.called {
		t.Fatal("expected ResolveApp to be called")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if got := rec.Body.String(); got != "invalid or missing token\n" {
		t.Errorf("body = %q, want %q", got, "invalid or missing token\n")
	}
}

// TestServeHTTP_ResolverRejectionPropagatesCode confirms the HTTP status
// code surfaced to the client always matches whatever the resolver
// returned (e.g. 403 for an origin mismatch, 429 for over-quota) rather
// than a single hardcoded code — the whole point of ResolveApp returning
// its own code.
func TestServeHTTP_ResolverRejectionPropagatesCode(t *testing.T) {
	cases := []struct {
		name string
		code int
	}{
		{"forbidden", http.StatusForbidden},
		{"tooManyRequests", http.StatusTooManyRequests},
		{"notFound", http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHandler()
			h.Resolver = &fakeResolver{ok: false, msg: "rejected", code: tc.code}

			req := httptest.NewRequest(http.MethodGet, "/ws", nil)
			rec := httptest.NewRecorder()

			h.ServeHTTP(rec, req)

			if rec.Code != tc.code {
				t.Errorf("status = %d, want %d", rec.Code, tc.code)
			}
		})
	}
}

// TestCheckOrigin_ResolverPresentAlwaysAllows confirms that once a Resolver
// is set, CheckOrigin itself always returns true — Origin enforcement for
// that path is understood to already have happened inside ResolveApp (see
// APIKeyResolver.ResolveApp's own Origin comparison). This is the behavior
// that lets a resolver whose "allowed origin" set depends on which appId it
// resolved (impossible for a single static OriginChecker to express) still
// gate the handshake correctly.
func TestCheckOrigin_ResolverPresentAlwaysAllows(t *testing.T) {
	h := NewHandler(nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)),
		func(string) bool { return false }, // would reject everything, to prove it's bypassed
		&fakeResolver{ok: true}, nil)

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.Header.Set("Origin", "https://evil.example")

	if !h.upgrader.CheckOrigin(req) {
		t.Error("CheckOrigin should always allow when a Resolver is set, regardless of AllowedOrigins")
	}
}

// TestCheckOrigin_NoResolverNoOriginHeaderAllowed confirms the dev/mock-mode
// fallback (no Resolver) still lets through non-browser clients (curl,
// server-to-server) that send no Origin header at all.
func TestCheckOrigin_NoResolverNoOriginHeaderAllowed(t *testing.T) {
	h := NewHandler(nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)),
		func(string) bool { return false }, // would reject everything if it were consulted
		nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)

	if !h.upgrader.CheckOrigin(req) {
		t.Error("CheckOrigin should allow a request with no Origin header when Resolver is nil")
	}
}

// TestCheckOrigin_NoResolverDelegatesToAllowedOrigins confirms the
// dev/mock-mode fallback defers to the configured AllowedOrigins checker
// when an Origin header is present.
func TestCheckOrigin_NoResolverDelegatesToAllowedOrigins(t *testing.T) {
	cases := []struct {
		name   string
		allow  bool
		origin string
		want   bool
	}{
		{"allowed", true, "https://good.example", true},
		{"rejected", false, "https://bad.example", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seenOrigin string
			h := NewHandler(nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)),
				func(origin string) bool { seenOrigin = origin; return tc.allow },
				nil, nil)

			req := httptest.NewRequest(http.MethodGet, "/ws", nil)
			req.Header.Set("Origin", tc.origin)

			if got := h.upgrader.CheckOrigin(req); got != tc.want {
				t.Errorf("CheckOrigin = %v, want %v", got, tc.want)
			}
			if seenOrigin != tc.origin {
				t.Errorf("AllowedOrigins was called with %q, want %q", seenOrigin, tc.origin)
			}
		})
	}
}
