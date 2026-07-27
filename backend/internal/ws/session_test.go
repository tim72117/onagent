package ws

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/protocol"
	"github.com/tim72117/onagent/internal/toolschema"
)

// newTestSession builds a Session with no real *websocket.Conn — writeMessage
// is stubbed instead (see Session.writeMessage's doc comment), so these tests
// exercise pendingCalls/AskInteraction/handleToolResult's correlation and
// timeout logic without a socket, an HTTP server, or any of NewSession's
// other dependencies (toolschema.Registry, quota.Service — both DB-backed).
func newTestSession() (*Session, *recordingWriter) {
	rec := &recordingWriter{}
	s := &Session{
		id:           "test-session",
		log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		pendingCalls: make(map[string]chan protocol.ToolResultPayload),
		writeMessage: rec.write,
	}
	return s, rec
}

// recordingWriter stands in for the real WebSocket connection: it captures
// every outbound envelope (so a test can recover the requestId AskInteraction
// generated internally — it's otherwise not returned to the caller) instead
// of writing bytes anywhere.
type recordingWriter struct {
	mu   sync.Mutex
	sent []protocol.Envelope
}

func (r *recordingWriter) write(data []byte) error {
	var env protocol.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("recordingWriter: %w", err)
	}
	r.mu.Lock()
	r.sent = append(r.sent, env)
	r.mu.Unlock()
	return nil
}

// last returns the most recently recorded envelope, or fails the test if
// none was ever sent.
func (r *recordingWriter) last(t *testing.T) protocol.Envelope {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.sent) == 0 {
		t.Fatal("no envelope was ever sent")
	}
	return r.sent[len(r.sent)-1]
}

// count returns how many envelopes have been recorded so far. Locked, unlike
// a bare len(r.sent) — every read of r.sent must go through r.mu, since
// write() (called from AskInteraction's goroutine) can run concurrently with
// a test's polling loop (see waitFor's callers).
func (r *recordingWriter) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sent)
}

// TestAskInteraction_DeliveredResultUnblocksWithTheAnswer is the golden
// path: the page answers before the timeout, and AskInteraction returns
// exactly the Result bytes handleToolResult delivered — this is the
// mechanism forwardingTool/queryTool depend on to relay a browser-executed
// tool's outcome back into want's blocked-on-it inference call (see
// internal/inference/agent_roles.go's askPage).
func TestAskInteraction_DeliveredResultUnblocksWithTheAnswer(t *testing.T) {
	s, rec := newTestSession()

	resultCh := make(chan struct {
		data []byte
		err  error
	}, 1)
	go func() {
		data, err := s.AskInteraction("get_page_title", nil, toolschema.ToolKindQuery)
		resultCh <- struct {
			data []byte
			err  error
		}{data, err}
	}()

	// AskInteraction generates its own requestId internally (randomID()) and
	// never returns it to the caller — the only way a test (playing the
	// browser's role) recovers it is by reading back what was actually sent,
	// exactly as a real client SDK would from the wire.
	var requestID string
	waitFor(t, 2*time.Second, func() bool {
		if rec.count() == 0 {
			return false
		}
		env := rec.last(t)
		if env.Type != protocol.TypeToolQuery {
			t.Fatalf("sent envelope type = %q, want %q", env.Type, protocol.TypeToolQuery)
		}
		requestID = env.RequestID
		return requestID != ""
	})

	s.handleToolResult(protocol.Envelope{
		Type:      protocol.TypeToolResult,
		RequestID: requestID,
		Payload:   mustMarshal(t, protocol.ToolResultPayload{ToolName: "get_page_title", OK: true, Result: json.RawMessage(`"hello"`)}),
	})

	select {
	case r := <-resultCh:
		if r.err != nil {
			t.Fatalf("AskInteraction returned error: %v", r.err)
		}
		if string(r.data) != `"hello"` {
			t.Errorf("AskInteraction result = %s, want %q", r.data, `"hello"`)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("AskInteraction never returned after handleToolResult delivered the answer")
	}
}

// TestAskInteraction_PageReportedFailure covers the other "delivered before
// timeout" outcome: the page ran the tool but it failed client-side (e.g.
// the DOM element wasn't found) — AskInteraction must surface that as an
// error, not silently return an empty/zero result the LLM would
// misinterpret as success.
func TestAskInteraction_PageReportedFailure(t *testing.T) {
	s, rec := newTestSession()

	errCh := make(chan error, 1)
	go func() {
		_, err := s.AskInteraction("click_button", nil, toolschema.ToolKindAction)
		errCh <- err
	}()

	var requestID string
	waitFor(t, 2*time.Second, func() bool {
		if rec.count() == 0 {
			return false
		}
		requestID = rec.last(t).RequestID
		return requestID != ""
	})

	s.handleToolResult(protocol.Envelope{
		Type:      protocol.TypeToolResult,
		RequestID: requestID,
		Payload:   mustMarshal(t, protocol.ToolResultPayload{ToolName: "click_button", OK: false, Error: "element not found"}),
	})

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("AskInteraction returned nil error for a page-reported failure")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("AskInteraction never returned")
	}
}

// TestAskInteraction_TimesOutWhenPageNeverAnswers is the failure mode
// AskInteraction exists to bound: a disconnected or unresponsive page must
// not hang the LLM's inference turn forever. Shrinks the package-level
// interactionTimeout var for the duration of the test rather than waiting
// the real 20s.
func TestAskInteraction_TimesOutWhenPageNeverAnswers(t *testing.T) {
	old := interactionTimeout
	interactionTimeout = 50 * time.Millisecond
	t.Cleanup(func() { interactionTimeout = old })

	s, _ := newTestSession()

	_, err := s.AskInteraction("get_page_title", nil, toolschema.ToolKindQuery)
	if err == nil {
		t.Fatal("want a timeout error, got nil")
	}

	// The pending entry must be cleaned up on timeout — otherwise a
	// same-requestId tool_result arriving late (or never) leaves a
	// permanently dangling map entry, and a genuinely late answer would
	// panic on a send to nothing listening if it ever raced back in without
	// this cleanup (see AskInteraction's timeout branch deleting the entry
	// under s.mu).
	s.mu.Lock()
	pendingCount := len(s.pendingCalls)
	s.mu.Unlock()
	if pendingCount != 0 {
		t.Errorf("pendingCalls still has %d entries after timeout, want 0", pendingCount)
	}
}

// TestHandleToolResult_UnknownRequestIDIsLoggedNotPanicked covers a
// tool_result whose requestId doesn't match anything AskInteraction is
// still waiting on — e.g. the page answered twice, or answered after this
// session already gave up and deleted the entry (see the timeout test
// above). This must be a harmless, logged no-op: the alternative (a nil map
// write or a panic) would crash the whole process on a single malformed or
// late client message.
func TestHandleToolResult_UnknownRequestIDIsLoggedNotPanicked(t *testing.T) {
	s, _ := newTestSession()

	s.handleToolResult(protocol.Envelope{
		Type:      protocol.TypeToolResult,
		RequestID: "no-such-request",
		Payload:   mustMarshal(t, protocol.ToolResultPayload{ToolName: "whatever", OK: true}),
	})
	// No panic reaching here is the assertion.
}

// TestHandleToolResult_RaceWithTimeout exercises the exact race the s.mu
// lock around pendingCalls' lookup+delete exists to prevent: a tool_result
// arriving at (almost) the same moment AskInteraction's own timeout fires.
// Exactly one side must win — AskInteraction must return either the
// delivered answer or a timeout error, never both, and never panic on a
// double-close or a send to an already-closed channel.
func TestHandleToolResult_RaceWithTimeout(t *testing.T) {
	old := interactionTimeout
	interactionTimeout = 30 * time.Millisecond
	t.Cleanup(func() { interactionTimeout = old })

	for i := 0; i < 50; i++ {
		s, rec := newTestSession()

		resultCh := make(chan error, 1)
		go func() {
			_, err := s.AskInteraction("racey_tool", nil, toolschema.ToolKindQuery)
			resultCh <- err
		}()

		var requestID string
		waitFor(t, 2*time.Second, func() bool {
			if rec.count() == 0 {
				return false
			}
			requestID = rec.last(t).RequestID
			return requestID != ""
		})

		// Deliver right around when the timeout is expected to fire —
		// deliberately racing the two, not synchronizing them, since the
		// point is to prove s.mu makes whichever order happens safe.
		go s.handleToolResult(protocol.Envelope{
			Type:      protocol.TypeToolResult,
			RequestID: requestID,
			Payload:   mustMarshal(t, protocol.ToolResultPayload{ToolName: "racey_tool", OK: true, Result: json.RawMessage(`"ok"`)}),
		})

		select {
		case <-resultCh: // either outcome is acceptable; not panicking is the test
		case <-time.After(2 * time.Second):
			t.Fatal("AskInteraction never returned")
		}
	}
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if cond() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("condition never became true (timed out waiting)")
		}
		time.Sleep(2 * time.Millisecond)
	}
}
