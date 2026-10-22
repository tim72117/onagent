package ws

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/protocol"
)

// These cover the SSE transport itself — stream setup, the session event,
// POST origin binding, envelopes round-tripping through the shared
// Session — using fakeResolver (handler_test.go) and no database. They stay
// on paths that never reach toolschema.Registry (a prompt before any hello
// is rejected before the registry is consulted); the full hello → ack →
// prompt flow against a real Registry is in sse_integration_test.go.

const testOrigin = "https://site.example.com"

func newSSETestServer(t *testing.T, resolver AppResolver) *httptest.Server {
	t.Helper()
	h := NewSSEHandler(nil, inference.NewMock(), slog.New(slog.NewTextHandler(io.Discard, nil)), resolver, nil)
	mux := http.NewServeMux()
	h.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type sseEvent struct {
	name string // "" for a default (unnamed) event
	data string
}

// sseStream is a minimal EventSource stand-in: it opens GET /sse and parses
// events off the body onto a channel.
type sseStream struct {
	events chan sseEvent
	resp   *http.Response
	cancel context.CancelFunc
}

func openSSE(t *testing.T, srv *httptest.Server, origin string) *sseStream {
	t.Helper()
	return openSSEWithToken(t, srv, "k", origin)
}

func openSSEWithToken(t *testing.T, srv *httptest.Server, token, origin string) *sseStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/sse?token="+url.QueryEscape(token), nil)
	req.Header.Set("Origin", origin)
	resp, err := srv.Client().Do(req)
	if err != nil {
		cancel()
		t.Fatalf("GET /sse: %v", err)
	}
	st := &sseStream{events: make(chan sseEvent, 16), resp: resp, cancel: cancel}
	t.Cleanup(st.close)
	if resp.StatusCode != http.StatusOK {
		return st
	}
	go func() {
		defer close(st.events)
		sc := bufio.NewScanner(resp.Body)
		var ev sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if ev.data != "" {
					st.events <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, ":"):
			case strings.HasPrefix(line, "event: "):
				ev.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return st
}

func (st *sseStream) close() {
	st.cancel()
	st.resp.Body.Close()
}

func (st *sseStream) next(t *testing.T) sseEvent {
	t.Helper()
	select {
	case ev, ok := <-st.events:
		if !ok {
			t.Fatal("stream ended before the expected event")
		}
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for an SSE event")
	}
	return sseEvent{}
}

// sessionID reads the stream's first event, which must be the named
// "session" event.
func (st *sseStream) sessionID(t *testing.T) string {
	t.Helper()
	ev := st.next(t)
	if ev.name != "session" {
		t.Fatalf("first event = %q, want \"session\"", ev.name)
	}
	var p struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal([]byte(ev.data), &p); err != nil || p.SessionID == "" {
		t.Fatalf("session event data %q: no sessionId (%v)", ev.data, err)
	}
	return p.SessionID
}

func (st *sseStream) envelope(t *testing.T) protocol.Envelope {
	t.Helper()
	ev := st.next(t)
	if ev.name != "" {
		t.Fatalf("event name = %q, want a default (unnamed) envelope event", ev.name)
	}
	var env protocol.Envelope
	if err := json.Unmarshal([]byte(ev.data), &env); err != nil {
		t.Fatalf("envelope event data %q: %v", ev.data, err)
	}
	return env
}

func post(t *testing.T, srv *httptest.Server, method, sessionID, origin, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+"/sse/"+sessionID, strings.NewReader(body))
	req.Header.Set("Origin", origin)
	// Same as the SDK: text/plain keeps the POST a CORS simple request.
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("%s /sse/%s: %v", method, sessionID, err)
	}
	resp.Body.Close()
	return resp
}

func okResolver() *fakeResolver {
	return &fakeResolver{appID: "app", userID: 1, ok: true}
}

func TestSSE_ResolverRejectionNeverOpensStream(t *testing.T) {
	resolver := &fakeResolver{ok: false, msg: "origin not allowed for this app", code: http.StatusForbidden}
	srv := newSSETestServer(t, resolver)

	st := openSSE(t, srv, testOrigin)
	if st.resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want %d", st.resp.StatusCode, http.StatusForbidden)
	}
	if ct := st.resp.Header.Get("Content-Type"); strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("rejected request still got an event stream (Content-Type %q)", ct)
	}
}

func TestSSE_StreamHeadersAndSessionEvent(t *testing.T) {
	srv := newSSETestServer(t, okResolver())
	st := openSSE(t, srv, testOrigin)

	if ct := st.resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
	if got := st.resp.Header.Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, testOrigin)
	}
	st.sessionID(t)
}

// TestSSE_PostRoundTripsThroughSession sends one envelope up via POST and
// expects the Session's answer down the stream — the core of the transport.
func TestSSE_PostRoundTripsThroughSession(t *testing.T) {
	srv := newSSETestServer(t, okResolver())
	st := openSSE(t, srv, testOrigin)
	id := st.sessionID(t)

	resp := post(t, srv, http.MethodPost, id, testOrigin, `{"type":"prompt","requestId":"r1","payload":{"text":"hi"}}`)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST status = %d, want 202", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Errorf("POST Access-Control-Allow-Origin = %q, want %q", got, testOrigin)
	}

	env := st.envelope(t)
	if env.Type != protocol.TypeError || env.RequestID != "r1" {
		t.Fatalf("got %s (requestId %q), want an error for r1", env.Type, env.RequestID)
	}
	var p protocol.ErrorPayload
	_ = json.Unmarshal(env.Payload, &p)
	if !strings.Contains(p.Message, "no hello") {
		t.Errorf("error message = %q, want the no-hello-yet rejection", p.Message)
	}
}

func TestSSE_InvalidEnvelopeReportedOnStream(t *testing.T) {
	srv := newSSETestServer(t, okResolver())
	st := openSSE(t, srv, testOrigin)
	id := st.sessionID(t)

	if resp := post(t, srv, http.MethodPost, id, testOrigin, `not json`); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("POST status = %d, want 202", resp.StatusCode)
	}
	if env := st.envelope(t); env.Type != protocol.TypeError {
		t.Errorf("got %s, want error", env.Type)
	}
}

// postFull is post that also returns the body, for comparing responses.
func postFull(t *testing.T, srv *httptest.Server, sessionID, origin, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/sse/"+sessionID, strings.NewReader(body))
	req.Header.Set("Origin", origin)
	req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /sse/%s: %v", sessionID, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

// TestSSE_PostFromAnotherOriginLooksLikeUnknownSession covers the origin
// binding: knowing a live sessionId isn't enough from a different site. The
// rejection must be indistinguishable from an unknown session — same
// status, body and headers — so it confirms nothing about the id; and the
// message must never reach the session.
func TestSSE_PostFromAnotherOriginLooksLikeUnknownSession(t *testing.T) {
	const evil = "https://evil.example.com"
	srv := newSSETestServer(t, okResolver())
	st := openSSE(t, srv, testOrigin)
	id := st.sessionID(t)

	live, liveBody := postFull(t, srv, id, evil, `{"type":"prompt","requestId":"evil","payload":{"text":"hi"}}`)
	gone, goneBody := postFull(t, srv, "no-such-session", evil, `{}`)
	if live.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", live.StatusCode)
	}
	if live.StatusCode != gone.StatusCode || liveBody != goneBody ||
		live.Header.Get("Access-Control-Allow-Origin") != gone.Header.Get("Access-Control-Allow-Origin") {
		t.Errorf("wrong-origin response (%d %q, ACAO %q) differs from unknown-session response (%d %q, ACAO %q)",
			live.StatusCode, liveBody, live.Header.Get("Access-Control-Allow-Origin"),
			gone.StatusCode, goneBody, gone.Header.Get("Access-Control-Allow-Origin"))
	}

	// The next thing on the stream must be the answer to the legitimate
	// prompt below, not to the rejected one above.
	post(t, srv, http.MethodPost, id, testOrigin, `{"type":"prompt","requestId":"legit","payload":{"text":"hi"}}`)
	if env := st.envelope(t); env.RequestID != "legit" {
		t.Errorf("first envelope on the stream answers %q, want legit — the wrong-origin POST reached the session", env.RequestID)
	}
}

// TestSSE_PostToUnknownSessionIsReadableCrossOrigin: the SDK's whole
// "session gone → resend the prompt, reconnect" path hinges on reading this
// 404. A cross-origin fetch can only read it if it carries
// Access-Control-Allow-Origin; without it the browser reports a network
// error, which the SDK deliberately doesn't retry.
func TestSSE_PostToUnknownSessionIsReadableCrossOrigin(t *testing.T) {
	srv := newSSETestServer(t, okResolver())
	resp := post(t, srv, http.MethodPost, "nope", testOrigin, `{}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != testOrigin {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q so the browser lets the SDK see the 404", got, testOrigin)
	}
}

// TestSSE_StableSessionIDIsNotShared: a resolver may return a fixed
// sessionID. A second stream under a live id is refused rather than
// silently taking over the first one's routing and inference asker.
func TestSSE_StableSessionIDIsNotShared(t *testing.T) {
	resolver := &fakeResolver{appID: "app", sessionID: "fixed-id", userID: 1, ok: true}
	srv := newSSETestServer(t, resolver)
	first := openSSE(t, srv, testOrigin)
	if id := first.sessionID(t); id != "fixed-id" {
		t.Fatalf("session id = %q, want fixed-id", id)
	}

	second := openSSE(t, srv, testOrigin)
	if second.resp.StatusCode != http.StatusConflict {
		t.Fatalf("second stream status = %d, want 409", second.resp.StatusCode)
	}

	// The first stream is untouched by the refused second one.
	post(t, srv, http.MethodPost, "fixed-id", testOrigin, `{"type":"prompt","requestId":"r1","payload":{"text":"hi"}}`)
	if env := first.envelope(t); env.RequestID != "r1" {
		t.Errorf("first stream got requestId %q, want r1", env.RequestID)
	}
}

func TestSSE_OversizedBodyIs413(t *testing.T) {
	srv := newSSETestServer(t, okResolver())
	st := openSSE(t, srv, testOrigin)
	id := st.sessionID(t)

	resp := post(t, srv, http.MethodPost, id, testOrigin, strings.Repeat("x", maxInboundMessageBytes+1))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", resp.StatusCode)
	}
}

// TestSSE_BrokenBodyIsNot413: a body read failing for any reason other than
// the size limit (the client's connection dropping mid-send) must not be
// reported as 413 — the SDK reads any non-404 as "rejected, don't resend".
func TestSSE_BrokenBodyIsNot413(t *testing.T) {
	h := NewSSEHandler(nil, inference.NewMock(), slog.New(slog.NewTextHandler(io.Discard, nil)), okResolver(), nil)
	mux := http.NewServeMux()
	h.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	st := openSSE(t, srv, testOrigin)
	id := st.sessionID(t)

	req := httptest.NewRequest(http.MethodPost, "/sse/"+id, io.NopCloser(failingReader{}))
	req.SetPathValue("sessionId", id)
	req.Header.Set("Origin", testOrigin)
	rec := httptest.NewRecorder()
	h.Message(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

// TestSSE_MissingOriginNeverOpensStream: every POST is bound to the
// stream's Origin, so a stream without one could never be used. Rejected
// even when the resolver itself would have let it through — fakeResolver
// here accepts anything.
func TestSSE_MissingOriginNeverOpensStream(t *testing.T) {
	resolver := okResolver()
	srv := newSSETestServer(t, resolver)

	st := openSSE(t, srv, "")
	if st.resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", st.resp.StatusCode)
	}
	if resolver.called {
		t.Error("resolver ran for a request with no Origin; want it rejected first")
	}
}

// TestSSE_SessionReleasedWhenStreamCloses checks the stream's lifetime owns
// the session: once the client disconnects, its sessionId stops working.
func TestSSE_SessionReleasedWhenStreamCloses(t *testing.T) {
	srv := newSSETestServer(t, okResolver())
	st := openSSE(t, srv, testOrigin)
	id := st.sessionID(t)
	st.close()

	deadline := time.Now().Add(3 * time.Second)
	for {
		resp := post(t, srv, http.MethodPost, id, testOrigin, `{"type":"prompt","payload":{"text":"hi"}}`)
		if resp.StatusCode == http.StatusNotFound {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("session still accepting POSTs after its stream closed (status %d)", resp.StatusCode)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
