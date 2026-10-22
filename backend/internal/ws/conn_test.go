package ws

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/protocol"
)

// These dial a real WebSocket through Handler — the runConn read loop,
// handleRaw dispatch, and teardown — rather than stubbing writeMessage the
// way session_test.go does. Like sse_test.go they stay on paths that never
// reach toolschema.Registry, so no database is needed; the full
// hello → ack → prompt → tool_query flow is in ws_flow_integration_test.go.

// closeRecordingInference records CloseSession calls, which Session.close()
// makes last — after UnregisterAsker — so seeing one means teardown ran.
type closeRecordingInference struct {
	inference.MockService
	closed chan string
}

func (c *closeRecordingInference) CloseSession(sessionID string) {
	c.closed <- sessionID
}

func newWSTestServer(t *testing.T, resolver AppResolver, infer inference.Service) *httptest.Server {
	t.Helper()
	h := NewHandler(nil, infer, slog.New(slog.NewTextHandler(io.Discard, nil)), AllowAllOrigins, resolver, nil)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

func dialWS(t *testing.T, srv *httptest.Server, token, origin string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws?token=" + token
	header := http.Header{}
	header.Set("Origin", origin)
	conn, resp, err := websocket.DefaultDialer.Dial(u, header)
	if conn != nil {
		t.Cleanup(func() { conn.Close() })
	}
	return conn, resp, err
}

func mustDialWS(t *testing.T, srv *httptest.Server, token, origin string) *websocket.Conn {
	t.Helper()
	conn, resp, err := dialWS(t, srv, token, origin)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial /ws: %v (status %d)", err, status)
	}
	return conn
}

func readEnvelope(t *testing.T, conn *websocket.Conn) protocol.Envelope {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var env protocol.Envelope
	if err := conn.ReadJSON(&env); err != nil {
		t.Fatalf("read envelope: %v", err)
	}
	return env
}

func TestWS_PromptBeforeHelloRoundTrips(t *testing.T) {
	srv := newWSTestServer(t, okResolver(), inference.NewMock())
	conn := mustDialWS(t, srv, "k", testOrigin)

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"prompt","requestId":"r1","payload":{"text":"hi"}}`)); err != nil {
		t.Fatalf("write: %v", err)
	}
	env := readEnvelope(t, conn)
	if env.Type != protocol.TypeError || env.RequestID != "r1" {
		t.Fatalf("got %s (requestId %q), want an error for r1", env.Type, env.RequestID)
	}
	var p protocol.ErrorPayload
	_ = json.Unmarshal(env.Payload, &p)
	if !strings.Contains(p.Message, "no hello") {
		t.Errorf("error message = %q, want the no-hello-yet rejection", p.Message)
	}
}

// TestWS_InvalidEnvelopeKeepsConnection checks a bad frame is reported and
// the read loop carries on, rather than ending the session.
func TestWS_InvalidEnvelopeKeepsConnection(t *testing.T) {
	srv := newWSTestServer(t, okResolver(), inference.NewMock())
	conn := mustDialWS(t, srv, "k", testOrigin)

	_ = conn.WriteMessage(websocket.TextMessage, []byte(`not json`))
	if env := readEnvelope(t, conn); env.Type != protocol.TypeError {
		t.Fatalf("got %s, want error", env.Type)
	}

	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"prompt","requestId":"r2","payload":{"text":"hi"}}`))
	if env := readEnvelope(t, conn); env.RequestID != "r2" {
		t.Errorf("after a bad frame got requestId %q, want r2 — the connection should still be serving", env.RequestID)
	}
}

func TestWS_ResolverRejectionNeverUpgrades(t *testing.T) {
	resolver := &fakeResolver{ok: false, msg: "origin not allowed for this app", code: http.StatusForbidden}
	srv := newWSTestServer(t, resolver, inference.NewMock())

	_, resp, err := dialWS(t, srv, "k", testOrigin)
	if err == nil {
		t.Fatal("dial succeeded, want the handshake refused")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %v, want 403", resp)
	}
}

// TestWS_SessionReleasedOnClose covers teardown through a real connection:
// a client hanging up must release the session's want orchestrator
// (CloseSession) — which leaks a goroutine per connection if skipped.
func TestWS_SessionReleasedOnClose(t *testing.T) {
	const sessionID = "ws-conn-test-session"
	resolver := &fakeResolver{appID: "app", sessionID: sessionID, userID: 1, ok: true}
	infer := &closeRecordingInference{closed: make(chan string, 1)}
	srv := newWSTestServer(t, resolver, infer)

	conn := mustDialWS(t, srv, "k", testOrigin)
	_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	select {
	case got := <-infer.closed:
		if got != sessionID {
			t.Errorf("CloseSession(%q), want %q", got, sessionID)
		}
	case <-ctx.Done():
		t.Fatal("CloseSession never called after the client closed the connection")
	}
}
