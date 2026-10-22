//go:build integration

package ws

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/protocol"
)

// TestWS_FullFlowAgainstRealResolver drives the shared scenario
// (transport_integration_test.go) over a real WebSocket. The tool_result is
// read by the same runConn loop while the prompt that asked for it is still
// blocked inside Complete — the reason handlePrompt runs on its own
// goroutine. If that ever regressed, this test would stall until
// AskInteraction's own timeout instead of answering.
func TestWS_FullFlowAgainstRealResolver(t *testing.T) {
	fx := newFlowFixture(t, 999821, "test-ws-ws-flow-app")

	h := NewHandler(fx.apps, askingInference{}, testLogger(), AllowAllOrigins, fx.resolver, nil)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)

	if _, resp, err := dialWS(t, srv, fx.key, "https://other.example.com"); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("dial from a non-allowed origin: err=%v resp=%v, want a 403 refusal", err, resp)
	}

	conn := mustDialWS(t, srv, fx.key, testOrigin)
	write := func(raw string) {
		t.Helper()
		if err := conn.WriteMessage(websocket.TextMessage, []byte(raw)); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	write(`{"type":"hello","payload":{"appId":"` + fx.appID + `"}}`)
	ack := readEnvelope(t, conn)
	if ack.Type != protocol.TypeAck {
		t.Fatalf("after hello got %s, want ack", ack.Type)
	}
	var ackP protocol.AckPayload
	_ = json.Unmarshal(ack.Payload, &ackP)
	if ackP.SessionID == "" || len(ackP.ToolNames) != 1 || ackP.ToolNames[0] != "get_title" {
		t.Errorf("ack = %+v, want a sessionId and toolNames [get_title]", ackP)
	}

	write(`{"type":"prompt","requestId":"r1","payload":{"text":"what's the title?"}}`)
	query := readEnvelope(t, conn)
	if query.Type != protocol.TypeToolQuery {
		t.Fatalf("after prompt got %s, want tool_query", query.Type)
	}

	write(`{"type":"tool_result","requestId":"` + query.RequestID + `","payload":{"toolName":"get_title","ok":true,"result":"Hello"}}`)
	reply := readEnvelope(t, conn)
	if reply.Type != protocol.TypeAssistantMessage || reply.RequestID != "r1" {
		t.Fatalf("after tool_result got %s (requestId %q), want assistant_message for r1", reply.Type, reply.RequestID)
	}
	var msg protocol.AssistantMessagePayload
	_ = json.Unmarshal(reply.Payload, &msg)
	if msg.Text != `title is "Hello"` {
		t.Errorf("assistant text = %q, want %q", msg.Text, `title is "Hello"`)
	}

	// Teardown through the real connection: once the client hangs up, the
	// session's asker must be unregistered, or a later query tool call
	// would reach a dead connection and hang.
	conn.Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, still := inference.LookupAskerForTest(ackP.SessionID); !still {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("session's asker still registered after the client closed the connection")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
