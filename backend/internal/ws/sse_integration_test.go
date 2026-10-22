//go:build integration

package ws

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tim72117/onagent/internal/protocol"
)

// TestSSE_FullFlowAgainstRealResolver drives the shared scenario
// (transport_integration_test.go) over SSE: the stream for downstream
// envelopes, one POST per upstream envelope.
func TestSSE_FullFlowAgainstRealResolver(t *testing.T) {
	fx := newFlowFixture(t, 999820, "test-ws-sse-flow-app")

	h := NewSSEHandler(fx.apps, askingInference{}, testLogger(), fx.resolver, nil)
	mux := http.NewServeMux()
	h.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	if st := openSSEWithToken(t, srv, fx.key, "https://other.example.com"); st.resp.StatusCode != http.StatusForbidden {
		t.Errorf("stream from a non-allowed origin: status %d, want 403", st.resp.StatusCode)
	}

	st := openSSEWithToken(t, srv, fx.key, testOrigin)
	if st.resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /sse status = %d, want 200", st.resp.StatusCode)
	}
	id := st.sessionID(t)

	post(t, srv, http.MethodPost, id, testOrigin, `{"type":"hello","payload":{"appId":"`+fx.appID+`"}}`)
	ack := st.envelope(t)
	if ack.Type != protocol.TypeAck {
		t.Fatalf("after hello got %s, want ack", ack.Type)
	}
	var ackP protocol.AckPayload
	_ = json.Unmarshal(ack.Payload, &ackP)
	if ackP.SessionID != id || len(ackP.ToolNames) != 1 || ackP.ToolNames[0] != "get_title" {
		t.Errorf("ack = %+v, want sessionId %q and toolNames [get_title]", ackP, id)
	}

	post(t, srv, http.MethodPost, id, testOrigin, `{"type":"prompt","requestId":"r1","payload":{"text":"what's the title?"}}`)
	query := st.envelope(t)
	if query.Type != protocol.TypeToolQuery {
		t.Fatalf("after prompt got %s, want tool_query", query.Type)
	}

	post(t, srv, http.MethodPost, id, testOrigin,
		`{"type":"tool_result","requestId":"`+query.RequestID+`","payload":{"toolName":"get_title","ok":true,"result":"Hello"}}`)
	reply := st.envelope(t)
	if reply.Type != protocol.TypeAssistantMessage || reply.RequestID != "r1" {
		t.Fatalf("after tool_result got %s (requestId %q), want assistant_message for r1", reply.Type, reply.RequestID)
	}
	var msg protocol.AssistantMessagePayload
	_ = json.Unmarshal(reply.Payload, &msg)
	if msg.Text != `title is "Hello"` {
		t.Errorf("assistant text = %q, want %q", msg.Text, `title is "Hello"`)
	}
}
