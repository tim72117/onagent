package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/quota"
	"github.com/tim72117/onagent/internal/toolschema"
)

// SSEHandler is the Server-Sent Events alternative to Handler, for clients
// where a WebSocket can't get through (proxies or networks that block the
// Upgrade). Same Session, same Envelope protocol, same resolver — only the
// transport differs:
//
//	GET  /sse?token=...      the downstream: server→client envelopes as SSE
//	                         "data:" events. Its first event is a named
//	                         "session" event carrying the sessionId.
//	POST /sse/{sessionId}    the upstream: one client→server envelope
//	                         (hello / prompt / tool_result) per request,
//	                         same JSON a WebSocket frame would carry.
//
// Session state lives in this process's memory (sessions map below), so a
// POST must reach the same instance holding that session's GET stream —
// there's no cross-instance routing. See
// docs/refactor-sse-transport-2026-10-22.md for that and the other known
// limits (no resume after reconnect, API-key path only, no Playground).
type SSEHandler struct {
	Apps      *toolschema.Registry
	Inference inference.Service
	Log       *slog.Logger
	// Resolver authorizes the GET exactly as it would a WebSocket handshake
	// (token, per-app origin, enabled flag, quota). Required — unlike
	// Handler there is no unauthenticated dev mode here.
	Resolver AppResolver
	Quota    *quota.Service

	mu       sync.Mutex
	sessions map[string]*sseSession
}

// sseSession is what a POST needs to find its stream: the Session itself,
// the stream's lifetime context (which every inbound message is dispatched
// under — see Session.handleRaw), and the Origin the stream was authorized
// for.
type sseSession struct {
	s      *Session
	ctx    context.Context
	origin string
}

func NewSSEHandler(apps *toolschema.Registry, infer inference.Service, log *slog.Logger, resolver AppResolver, quotaSvc *quota.Service) *SSEHandler {
	return &SSEHandler{
		Apps:      apps,
		Inference: infer,
		Log:       log,
		Resolver:  resolver,
		Quota:     quotaSvc,
		sessions:  make(map[string]*sseSession),
	}
}

// Register mounts the SSE routes on mux. There is no OPTIONS route: the SDK
// POSTs as text/plain, a CORS "simple" request the browser sends without a
// preflight. A client that sends a non-simple content type instead gets a
// 405 on its preflight and the POST never goes out.
func (h *SSEHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /sse", h.Stream)
	mux.HandleFunc("POST /sse/{sessionId}", h.Message)
}

// sseHeartbeatInterval keeps idle streams alive through proxies and load
// balancers that cut connections with no traffic, and is how a dead client
// is noticed: SSE has no ping/pong, so the only signal is this write
// failing. Same cadence as the WebSocket ping (pingInterval).
const sseHeartbeatInterval = pingInterval

// Stream serves GET /sse: authorizes like a WebSocket handshake, opens the
// event stream, and holds it (and its Session) until the client goes away
// or a write fails.
func (h *SSEHandler) Stream(w http.ResponseWriter, r *http.Request) {
	if h.Resolver == nil {
		http.Error(w, "sse unavailable", http.StatusServiceUnavailable)
		return
	}
	// Every POST is bound to this stream's Origin (see lookup), and it's
	// echoed back as Access-Control-Allow-Origin below — so a stream with no
	// Origin could never be used, and must not be opened. Checked here
	// rather than left to the resolver: APIKeyResolver happens to reject an
	// empty Origin too, but a resolver that tolerates one (as the WebSocket
	// path does for non-browser clients) must not quietly produce sessions
	// whose POSTs can never match. In practice this is always a cross-origin
	// request from the developer's site, and browsers send Origin on those.
	origin := r.Header.Get("Origin")
	if origin == "" {
		http.Error(w, "missing Origin header", http.StatusForbidden)
		return
	}
	appID, sessionID, userID, ok, msg, code := h.Resolver.ResolveApp(r)
	if !ok {
		http.Error(w, msg, code)
		return
	}

	// Reserve the id before anything else uses it. The resolver may return
	// a stable sessionID rather than "" (the AppResolver contract allows it
	// — Playground's does), and a second live stream under the same id
	// would be a real conflict: newSession registers the inference asker
	// under that id, overwriting the first session's, and both streams'
	// POSTs would route to whichever map entry won. Refused instead.
	// Reserved with a nil placeholder (lookup treats it as absent) until the
	// session exists, so two concurrent requests can't both pass this check.
	id := resolveSessionID(sessionID)
	h.mu.Lock()
	if _, taken := h.sessions[id]; taken {
		h.mu.Unlock()
		http.Error(w, "session already open", http.StatusConflict)
		return
	}
	h.sessions[id] = nil
	h.mu.Unlock()
	var entry *sseSession
	defer func() {
		// Only ever removes this request's own reservation or entry.
		h.mu.Lock()
		if h.sessions[id] == entry {
			delete(h.sessions, id)
		}
		h.mu.Unlock()
	}()

	// The resolver has already matched Origin against the app's own
	// allowedOrigins (APIKeyResolver), so echoing it back is exactly as
	// permissive as the WebSocket path — no broader.
	setCORS(w, origin)

	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	// no-transform and X-Accel-Buffering stop intermediaries (compression,
	// nginx-style buffering) from holding events back until a buffer fills.
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if err := rc.Flush(); err != nil {
		h.Log.Error("sse: response writer can't stream", "err", err)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// closed guards against writing to w after this handler has returned
	// (undefined behavior for an http.ResponseWriter). handlePrompt runs on
	// its own goroutine and can finish after the client is gone; its send()
	// then lands here. Read and written only under s.writeMu, which send()
	// already holds around every writeMessage call.
	closed := false
	writeEvent := func(chunk string) error {
		if closed {
			return errors.New("sse stream closed")
		}
		_ = rc.SetWriteDeadline(time.Now().Add(writeTimeout))
		if _, err := io.WriteString(w, chunk); err != nil {
			cancel()
			return err
		}
		if err := rc.Flush(); err != nil {
			cancel()
			return err
		}
		return nil
	}

	// json.Marshal output never contains a raw newline, so each envelope is
	// always exactly one "data:" line.
	s := newSession(h.Apps, h.Inference, h.Log, appID, h.Quota, id, userID, func(data []byte) error {
		return writeEvent("data: " + string(data) + "\n\n")
	})
	defer s.close()

	h.mu.Lock()
	entry = &sseSession{s: s, ctx: ctx, origin: origin}
	h.sessions[id] = entry
	h.mu.Unlock()
	// Registered last so it runs first: unpublish the session and cancel its
	// context before s.close() releases it, so no POST can reach a session
	// that's already been torn down.
	defer func() {
		h.mu.Lock()
		if h.sessions[id] == entry {
			delete(h.sessions, id)
		}
		h.mu.Unlock()
		cancel()
		s.writeMu.Lock()
		closed = true
		s.writeMu.Unlock()
	}()

	sessionEvent, _ := json.Marshal(map[string]string{"sessionId": s.id})
	s.writeMu.Lock()
	err := writeEvent("event: session\ndata: " + string(sessionEvent) + "\n\n")
	s.writeMu.Unlock()
	if err != nil {
		return
	}

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			h.Log.Info("sse session closed", "session", s.id, "err", context.Cause(ctx))
			return
		case <-ticker.C:
			// An SSE comment line: ignored by EventSource, but real bytes
			// on the wire.
			s.writeMu.Lock()
			err := writeEvent(": ping\n\n")
			s.writeMu.Unlock()
			if err != nil {
				h.Log.Info("sse session closed", "session", s.id, "err", err)
				return
			}
		}
	}
}

// Message serves POST /sse/{sessionId}: one inbound envelope for an open
// stream.
//
// Authorization is the sessionId plus an Origin match. The sessionId is a
// 128-bit crypto/rand value (randomID) delivered only over a stream that
// already passed the full resolver check, so it is a capability for that
// stream — the same trust level as the api key it was minted under, which
// travels the same way (in a URL, so possibly in access logs). The Origin
// match keeps a browser on another site from driving a session whose id it
// somehow learned; like any Origin check it's not a defense against
// non-browser clients, exactly as on the WebSocket path.
func (h *SSEHandler) Message(w http.ResponseWriter, r *http.Request) {
	sess, ok := h.lookup(r)
	if !ok {
		// 404 for "no such session here" — the SDK treats this as a lost
		// stream: resends a prompt, reconnects. It can only do that if it can
		// read the status: without Access-Control-Allow-Origin the browser
		// hides this response and fetch() rejects as a network error, which
		// the SDK deliberately does NOT retry. So the caller's Origin is
		// echoed even here. That discloses nothing: an unknown session and a
		// wrong origin get the identical response.
		if origin := r.Header.Get("Origin"); origin != "" {
			setCORS(w, origin)
		}
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	setCORS(w, sess.origin)

	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, sess.s.inboundLimit()))
	if err != nil {
		// Only an actual size overflow is a 413 — the SDK treats any non-404
		// as "the server rejected this message, don't resend". Anything else
		// here is the client's own connection failing mid-body; 400, which
		// that client almost certainly never sees anyway.
		status := http.StatusBadRequest
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			status = http.StatusRequestEntityTooLarge
		}
		http.Error(w, fmt.Sprintf("read body: %v", err), status)
		return
	}
	if sess.ctx.Err() != nil {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	// Responses (ack, tool_call, errors — including "invalid envelope
	// JSON") go out over the stream, not this response; 202 only means
	// "handed to the session".
	sess.s.handleRaw(sess.ctx, raw)
	w.WriteHeader(http.StatusAccepted)
}

// lookup finds the open stream r's {sessionId} names, requiring r's Origin
// to match the one that stream was authorized for. A wrong origin looks
// identical to an unknown session, and so does an id that's only reserved
// (nil — see Stream) and not yet a live session.
func (h *SSEHandler) lookup(r *http.Request) (*sseSession, bool) {
	h.mu.Lock()
	sess := h.sessions[r.PathValue("sessionId")]
	h.mu.Unlock()
	if sess == nil || r.Header.Get("Origin") != sess.origin {
		return nil, false
	}
	return sess, true
}

func setCORS(w http.ResponseWriter, origin string) {
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Add("Vary", "Origin")
}
