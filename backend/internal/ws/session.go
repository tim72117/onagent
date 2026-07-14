// Package ws implements the WebSocket endpoint the Agent Bridge SDK
// connects to: one Session per browser tab, speaking the Envelope protocol
// defined in internal/protocol.
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tim72117/agent/internal/codegen"
	"github.com/tim72117/agent/internal/inference"
	"github.com/tim72117/agent/internal/protocol"
	"github.com/tim72117/agent/internal/toolschema"
)

const (
	writeTimeout = 10 * time.Second
	pongTimeout  = 60 * time.Second
	pingInterval = 30 * time.Second
)

// Session represents one connected browser tab.
type Session struct {
	id    string
	conn  *websocket.Conn
	apps  *toolschema.Registry
	infer inference.Service
	log   *slog.Logger
	// authAppID is the appId the WebSocket handshake was verified against
	// (ws.Handler.Auth), or "" if auth is disabled. When set, it overrides
	// whatever appId the client's hello message claims — see handleHello.
	authAppID string

	writeMu sync.Mutex

	mu           sync.Mutex
	app          *toolschema.App
	lastContext  json.RawMessage
	pendingCalls map[string]chan protocol.ToolResultPayload
}

// NewSession wires a freshly-upgraded connection into a Session and starts
// its read/write pumps. It blocks until the connection closes. authAppID is
// the server-verified appId from the handshake (empty when auth is
// disabled); see Session.authAppID.
func NewSession(ctx context.Context, conn *websocket.Conn, apps *toolschema.Registry, infer inference.Service, log *slog.Logger, authAppID string) {
	s := &Session{
		id:           randomID(),
		conn:         conn,
		apps:         apps,
		infer:        infer,
		log:          log,
		authAppID:    authAppID,
		pendingCalls: make(map[string]chan protocol.ToolResultPayload),
	}
	// Makes s reachable from a ToolKindQuery tool's Call, which runs inside
	// want's own goroutine with no reference to this Session — see
	// inference.RegisterAsker's doc comment for the full path back here.
	// Must be deregistered on close (in run's defer below): a lingering
	// entry would let a later query tool call reach a closed connection and
	// hang until want's own interaction timeout.
	inference.RegisterAsker(s.id, s)
	s.run(ctx)
}

func (s *Session) run(ctx context.Context) {
	defer s.conn.Close()
	defer inference.UnregisterAsker(s.id)

	s.conn.SetReadLimit(1 << 20) // 1MB: generous for page-state context payloads, bounded against abuse.
	_ = s.conn.SetReadDeadline(time.Now().Add(pongTimeout))
	s.conn.SetPongHandler(func(string) error {
		return s.conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})

	stopPing := s.startPingLoop()
	defer stopPing()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		_, raw, err := s.conn.ReadMessage()
		if err != nil {
			s.log.Info("ws session closed", "session", s.id, "err", err)
			return
		}

		var env protocol.Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			s.sendError("", "invalid envelope JSON")
			continue
		}

		s.handle(ctx, env)
	}
}

func (s *Session) startPingLoop() func() {
	ticker := time.NewTicker(pingInterval)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-ticker.C:
				s.writeMu.Lock()
				_ = s.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
				err := s.conn.WriteMessage(websocket.PingMessage, nil)
				s.writeMu.Unlock()
				if err != nil {
					return
				}
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()
	return func() { close(done) }
}

func (s *Session) handle(ctx context.Context, env protocol.Envelope) {
	switch env.Type {
	case protocol.TypeHello:
		s.handleHello(env)
	case protocol.TypeContext:
		s.handleContext(env)
	case protocol.TypePrompt:
		// Dispatched onto its own goroutine, unlike every other case here —
		// this is the one handler that can legitimately take a long time
		// (s.infer.Complete blocks for the whole inference turn, up to
		// completeTimeout). run's read loop must stay free to call
		// ReadMessage again while a prompt is in flight, specifically so it
		// can read a TypeToolResult answering a ToolKindQuery tool that
		// prompt's own inference call is blocked waiting on (see
		// AskInteraction) — otherwise the read loop can never read the
		// answer to a question the in-flight prompt is itself asking,
		// deadlocking (in practice: stalling) until AskInteraction's own
		// interactionTimeout gives up and unblocks Complete from the other
		// side. Every other message type here is fast/non-blocking already
		// (map/field writes, or itself just a channel send in
		// handleToolResult's case), so keeping them synchronous in the read
		// loop is fine and preserves their relative ordering — only prompt
		// needed to be pulled out.
		go s.handlePrompt(ctx, env)
	case protocol.TypeToolResult:
		s.handleToolResult(env)
	default:
		s.sendError(env.RequestID, "unknown message type: "+string(env.Type))
	}
}

func (s *Session) handleHello(env protocol.Envelope) {
	var p protocol.HelloPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		s.sendError(env.RequestID, "invalid hello payload")
		return
	}

	// The server-verified appId from the handshake token always wins over
	// the client-claimed one: trusting p.AppID here is exactly the
	// impersonation gap auth closes (see ws.Handler.ServeHTTP). Auth
	// disabled (authAppID == "") falls back to the old dev-mode behavior of
	// trusting the client.
	appID := p.AppID
	if s.authAppID != "" {
		appID = s.authAppID
	}

	app, ok := s.apps.Get(appID)
	if !ok {
		s.sendError(env.RequestID, "unknown appId: "+appID)
		return
	}

	s.mu.Lock()
	s.app = app
	s.mu.Unlock()

	names := make([]string, 0, len(app.Tools))
	for _, t := range app.Tools {
		names = append(names, t.Name)
	}

	s.send(protocol.TypeAck, env.RequestID, protocol.AckPayload{
		SessionID: s.id,
		ToolNames: names,
	})
}

func (s *Session) handleContext(env protocol.Envelope) {
	var p protocol.ContextPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		s.sendError(env.RequestID, "invalid context payload")
		return
	}
	s.mu.Lock()
	s.lastContext = p.Data
	s.mu.Unlock()
}

func (s *Session) handlePrompt(ctx context.Context, env protocol.Envelope) {
	var p protocol.PromptPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		s.sendError(env.RequestID, "invalid prompt payload")
		return
	}

	s.mu.Lock()
	app := s.app
	lastContext := s.lastContext
	s.mu.Unlock()

	if app == nil {
		s.sendError(env.RequestID, "no hello received yet; send hello before prompt")
		return
	}

	promptContext := p.Context
	if promptContext == nil {
		promptContext = lastContext
	}

	result, err := s.infer.Complete(ctx, inference.Request{
		Prompt:    p.Text,
		Context:   promptContext,
		Tools:     codegen.ToLLMTools(app),
		AppID:     app.AppID,
		SessionID: s.id,
	})
	if err != nil {
		s.sendError(env.RequestID, "inference error: "+err.Error())
		return
	}

	for _, tc := range result.ToolCalls {
		s.send(protocol.TypeToolCall, env.RequestID, protocol.ToolCallPayload{
			ToolName: tc.ToolName,
			Args:     tc.Args,
		})
	}

	if result.AssistantMessage != "" {
		s.send(protocol.TypeAssistantMessage, env.RequestID, protocol.AssistantMessagePayload{
			Text: result.AssistantMessage,
		})
	}
}

func (s *Session) handleToolResult(env protocol.Envelope) {
	var p protocol.ToolResultPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		s.sendError(env.RequestID, "invalid tool_result payload")
		return
	}

	s.mu.Lock()
	ch, ok := s.pendingCalls[env.RequestID]
	if ok {
		delete(s.pendingCalls, env.RequestID)
	}
	s.mu.Unlock()

	if ok {
		ch <- p
		close(ch)
		return
	}

	s.log.Info("tool_result with no pending caller", "session", s.id, "tool", p.ToolName, "ok", p.OK)
}

// interactionTimeout bounds how long AskInteraction waits for the browser to
// answer a TypeToolQuery before giving up. Deliberately shorter than want's
// own 60s RequestInteraction timeout (which this bypasses entirely — see
// queryTool's doc comment in internal/inference/agent_roles.go) and well
// under WantService's 90s completeTimeout, so a page that never answers
// fails with a clear "the page didn't answer in time" rather than the
// caller instead seeing whichever of those two unrelated timeouts happens
// to fire first.
const interactionTimeout = 20 * time.Second

// AskInteraction implements inference.InteractionAsker: sends toolName/args
// to the browser as a TypeToolQuery and blocks until it answers with a
// matching TypeToolResult (handleToolResult delivers it onto the channel
// this registers in s.pendingCalls, the same map/mechanism a regular
// TypeToolCall's eventual TypeToolResult would use — the two are
// distinguished only by which message type the client originally received,
// not by anything server-side), the request times out, or ctx representing
// this call is otherwise abandoned.
//
// Runs on whatever goroutine want's dispatch called queryTool.Call from —
// never the Session's own read loop — so it must not touch s.pendingCalls
// or s.app/s.lastContext without s.mu, same as every other Session method
// reachable from outside run's single-goroutine loop.
func (s *Session) AskInteraction(toolName string, args json.RawMessage) (json.RawMessage, error) {
	requestID := randomID()
	ch := make(chan protocol.ToolResultPayload, 1)

	s.mu.Lock()
	s.pendingCalls[requestID] = ch
	s.mu.Unlock()

	s.send(protocol.TypeToolQuery, requestID, protocol.ToolCallPayload{
		ToolName: toolName,
		Args:     args,
	})

	select {
	case result := <-ch:
		if !result.OK {
			if result.Error != "" {
				return nil, fmt.Errorf("page reported an error answering %q: %s", toolName, result.Error)
			}
			return nil, fmt.Errorf("page reported failure answering %q", toolName)
		}
		return result.Result, nil
	case <-time.After(interactionTimeout):
		s.mu.Lock()
		delete(s.pendingCalls, requestID)
		s.mu.Unlock()
		return nil, fmt.Errorf("page didn't answer %q within %s", toolName, interactionTimeout)
	}
}

func (s *Session) send(typ protocol.MessageType, requestID string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		s.log.Error("failed to marshal outgoing payload", "err", err)
		return
	}
	env := protocol.Envelope{Type: typ, RequestID: requestID, Payload: data}
	out, err := json.Marshal(env)
	if err != nil {
		s.log.Error("failed to marshal envelope", "err", err)
		return
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := s.conn.WriteMessage(websocket.TextMessage, out); err != nil {
		s.log.Info("write failed", "session", s.id, "err", err)
	}
}

func (s *Session) sendError(requestID, message string) {
	s.send(protocol.TypeError, requestID, protocol.ErrorPayload{Message: message})
}
