package console

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tim72117/onagent/internal/codegen"
	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/session"
	"github.com/tim72117/onagent/internal/toolschema"
)

// Package playground: lets a developer test-drive their app's agent from
// inside the console itself, without a real front-end site to talk to.
//
// This is deliberately a separate, simpler protocol from internal/ws — the
// one AgentBridge and real developer sites speak — rather than reusing that
// package's ws.Session:
//
//   - Auth is the developer's own session cookie (internal/session), not an
//     API key. A console session is already proof the caller owns the app
//     (see withOwnedApp), so there's no reason to make them mint and paste
//     in a real key just to try a prompt — and the console never even holds
//     a plaintext key to use for this (KeyModal shows it exactly once).
//   - No Origin/allowedOrigin check: this endpoint is reached from the
//     console's own origin, not the developer's site, so ws.Handler's
//     per-app origin binding (see that package's ServeHTTP) doesn't apply
//     here at all — enforcing it would require the console's own origin to
//     be the app's configured one, which is nonsensical.
//   - A tool_call still has no real page to run on, but the console itself
//     mocks a subset of templated tools (see ToolWizard.tsx's TEMPLATES and
//     Playground.tsx's toolHandlersRef) and answers with a tool_result the
//     same way a real page would — see playgroundSession.AskInteraction.
//     Templates with no mock handler yet get no answer at all, which
//     surfaces to the LLM exactly like a real page failing to respond
//     (interactionTimeout below), not as a fabricated success.
//
// The wire format still mirrors internal/protocol's shape (type/requestId/
// payload) for familiarity, but is intentionally a distinct, smaller type
// set (playgroundEnvelope et al.) rather than importing internal/protocol,
// since the two are allowed to diverge (e.g. this has no hello/context
// messages).

const (
	playgroundWriteTimeout = 10 * time.Second
	playgroundPongTimeout  = 60 * time.Second
	playgroundPingInterval = 30 * time.Second
)

type playgroundEnvelope struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type playgroundPromptPayload struct {
	Text string `json:"text"`
}

type playgroundToolCallPayload struct {
	ToolName string          `json:"toolName"`
	Args     json.RawMessage `json:"args"`
}

type playgroundAssistantMessagePayload struct {
	Text string `json:"text"`
}

type playgroundErrorPayload struct {
	Message string `json:"message"`
}

// playgroundToolResultPayload is the Payload of an inbound "tool_result"
// message — the console's mocked answer to a "tool_call" this session sent
// out, in the same shape protocol.ToolResultPayload uses for a real page
// (see ws.Session.handleToolResult), kept as a separate type per this
// package's own wire format (see the package doc comment above).
type playgroundToolResultPayload struct {
	ToolName string          `json:"toolName"`
	OK       bool            `json:"ok"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
}

// playgroundInteractionTimeout bounds how long AskInteraction waits for the
// console to answer a tool_call/tool_query with a matching tool_result.
// var, not const, so a test can shrink it — mirrors ws.Session's
// interactionTimeout.
var playgroundInteractionTimeout = 20 * time.Second

// playgroundSession implements inference.InteractionAsker so a
// ToolKindAction/ToolKindQuery tool called from this playground run blocks
// on and receives the console's mocked answer, the same bridge a real
// ws.Session provides for an app's actual connected page (see
// inference.RegisterAsker's doc comment). Without this, forwardingTool/
// queryTool's askPage always failed with "no connected page for session" —
// correct for a query (there's no real page data to return) but misleading
// for an action tool the console can plausibly mock (e.g. ToolWizard's
// click_button), which read back to the LLM as a fabricated disconnect
// error rather than the mock succeeding.
type playgroundSession struct {
	send func(env playgroundEnvelope)

	mu           sync.Mutex
	pendingCalls map[string]chan playgroundToolResultPayload
}

func newPlaygroundSession(send func(env playgroundEnvelope)) *playgroundSession {
	return &playgroundSession{
		send:         send,
		pendingCalls: make(map[string]chan playgroundToolResultPayload),
	}
}

func (p *playgroundSession) AskInteraction(toolName string, args json.RawMessage, kind toolschema.ToolKind) (json.RawMessage, error) {
	requestID := fmt.Sprintf("%p-%d", p, time.Now().UnixNano())
	ch := make(chan playgroundToolResultPayload, 1)

	p.mu.Lock()
	p.pendingCalls[requestID] = ch
	p.mu.Unlock()

	payload, _ := json.Marshal(playgroundToolCallPayload{ToolName: toolName, Args: args})
	p.send(playgroundEnvelope{Type: "tool_call", RequestID: requestID, Payload: payload})

	select {
	case result := <-ch:
		if !result.OK {
			if result.Error != "" {
				return nil, fmt.Errorf("page reported an error answering %q: %s", toolName, result.Error)
			}
			return nil, fmt.Errorf("page reported failure answering %q", toolName)
		}
		return result.Result, nil
	case <-time.After(playgroundInteractionTimeout):
		p.mu.Lock()
		delete(p.pendingCalls, requestID)
		p.mu.Unlock()
		return nil, fmt.Errorf("page didn't answer %q within %s", toolName, playgroundInteractionTimeout)
	}
}

// handleToolResult delivers an inbound tool_result to whichever
// AskInteraction call is waiting on its requestID — see
// ws.Session.handleToolResult, which this mirrors. A requestID with no
// pending caller (already timed out, or a stray/duplicate message) is
// silently ignored, matching that same behavior.
func (p *playgroundSession) handleToolResult(env playgroundEnvelope) {
	var result playgroundToolResultPayload
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		return
	}

	p.mu.Lock()
	ch, ok := p.pendingCalls[env.RequestID]
	if ok {
		delete(p.pendingCalls, env.RequestID)
	}
	p.mu.Unlock()

	if ok {
		ch <- result
		close(ch)
	}
}

var playgroundUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// gorilla/websocket's default CheckOrigin rejects any request whose
	// Origin header doesn't exactly match the request's own Host — i.e.
	// literal same-origin, not "same site" or "trusted browser tab". The
	// console frontend and this backend are two separate servers (different
	// ports even in dev, different hosts in any real deployment), so that
	// default rejects every legitimate Playground connection. CheckOrigin is
	// set per-request in playgroundWS below (it needs the Handler's
	// ConsoleOrigins, not available at package-init time).
}

// originAllowed reports whether r's Origin header matches one of allowed
// exactly. A missing Origin header (e.g. a non-browser client) is allowed,
// matching gorilla/websocket's own default behavior for that case.
func originAllowed(r *http.Request, allowed []string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	return false
}

// playgroundWS upgrades the connection and runs the session loop. Reached
// only through withOwnedApp (see Register), so the caller's ownership of
// r.PathValue("appId") is already confirmed by the time this runs.
func (h *Handler) playgroundWS(w http.ResponseWriter, r *http.Request, user *session.User) {
	appID := r.PathValue("appId")
	app, ok := h.Apps.Get(appID)
	if !ok {
		http.Error(w, "unknown appId", http.StatusNotFound)
		return
	}

	upgrader := playgroundUpgrader
	upgrader.CheckOrigin = func(r *http.Request) bool { return originAllowed(r, h.ConsoleOrigins) }

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// PG-<userID>-<appID> gives this playground run its own want
	// conversation transcript (see WantService.Complete's AgentID
	// switching), isolated both from the app's real end-user sessions and
	// from other developers' playground runs against the same app.
	sessionID := fmt.Sprintf("PG-%d-%s", user.ID, appID)
	// Releases this run's want orchestrator (see inference.WantService) —
	// without this, every playground run that ever completed a prompt would
	// leak its orchestrator's dispatch goroutine for the life of the
	// process.
	defer h.Inference.CloseSession(sessionID)
	var writeMu sync.Mutex
	send := func(env playgroundEnvelope) {
		data, err := json.Marshal(env)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(playgroundWriteTimeout))
		_ = conn.WriteMessage(websocket.TextMessage, data)
	}
	sendError := func(requestID, message string) {
		payload, _ := json.Marshal(playgroundErrorPayload{Message: message})
		send(playgroundEnvelope{Type: "error", RequestID: requestID, Payload: payload})
	}

	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(playgroundPongTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(playgroundPongTimeout))
	})

	pingDone := make(chan struct{})
	go func() {
		// An unrecovered panic on any goroutine kills the whole process,
		// taking every other user's session down with it — a plain http
		// middleware's recover() can't reach a goroutine spawned like this
		// one, so it needs its own.
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic recovered in playground ping loop", "err", r, "stack", string(debug.Stack()))
			}
		}()
		ticker := time.NewTicker(playgroundPingInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				writeMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(playgroundWriteTimeout))
				err := conn.WriteMessage(websocket.PingMessage, nil)
				writeMu.Unlock()
				if err != nil {
					return
				}
			case <-pingDone:
				return
			}
		}
	}()
	defer close(pingDone)

	ctx := r.Context()
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var env playgroundEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			sendError("", "invalid message")
			continue
		}
		if env.Type != "prompt" {
			sendError(env.RequestID, "unknown message type: "+env.Type)
			continue
		}

		var p playgroundPromptPayload
		if err := json.Unmarshal(env.Payload, &p); err != nil {
			sendError(env.RequestID, "invalid prompt payload")
			continue
		}

		// Playground prompts count against the owner's quota like real
		// traffic: an owner testing their own app is still driving real
		// inference cost. Check before the paid call; a DB error here is
		// fail-open (fall through and allow), matching ws.Session — a
		// database blip must not block an owner from testing. The event_id
		// is namespaced by sessionID ("PG-<userID>-<appID>") so a playground
		// prompt and a real end-user prompt that happen to share a RequestID
		// don't collide with each other.
		if dec, err := h.Quota.Check(ctx, app.AppID); err != nil {
			slog.Error("playground: quota check failed, allowing (fail-open)", "err", err, "appID", app.AppID, "sessionID", sessionID)
		} else if !dec.Allowed {
			sendError(env.RequestID, "monthly prompt quota exceeded for this app's plan")
			continue
		}

		result, err := h.Inference.Complete(ctx, inference.Request{
			Prompt:    p.Text,
			Tools:     codegen.ToLLMTools(app),
			AppID:     app.AppID,
			SessionID: sessionID,
		})
		if err != nil {
			sendError(env.RequestID, "inference error: "+err.Error())
			continue
		}

		// Best-effort: an uncounted playground prompt (record failed) favors
		// the user and never blocks the response that already happened.
		eventID := sessionID + ":" + env.RequestID
		if err := h.Quota.Record(ctx, app.AppID, eventID); err != nil {
			slog.Error("playground: failed to record usage event", "err", err, "appID", app.AppID, "sessionID", sessionID, "eventID", eventID)
		}

		for _, tc := range result.ToolCalls {
			payload, _ := json.Marshal(playgroundToolCallPayload{ToolName: tc.ToolName, Args: tc.Args})
			send(playgroundEnvelope{Type: "tool_call", RequestID: env.RequestID, Payload: payload})
		}
		if result.AssistantMessage != "" {
			payload, _ := json.Marshal(playgroundAssistantMessagePayload{Text: result.AssistantMessage})
			send(playgroundEnvelope{Type: "assistant_message", RequestID: env.RequestID, Payload: payload})
		}
	}
}
