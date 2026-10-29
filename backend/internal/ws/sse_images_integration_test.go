//go:build integration

package ws

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tim72117/onagent/internal/protocol"
)

// TestSSE_ImagePromptOverOneMegabyte: once hello binds an app that accepts
// images, a prompt larger than the base 1MB cap gets through the SSE POST
// and its image reaches inference; before that opt-in the same POST is 413.
func TestSSE_ImagePromptOverOneMegabyte(t *testing.T) {
	setMaxPromptImagesEnv(t, "")
	fx := newFlowFixture(t, 999821, "test-ws-sse-image-app")

	infer := &capturingInference{}
	h := NewSSEHandler(fx.apps, infer, testLogger(), fx.resolver, nil)
	mux := http.NewServeMux()
	h.Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	// Random pixels don't compress, so this PNG is ~1.4MB — over the base
	// cap on its own.
	img := image.NewRGBA(image.Rect(0, 0, 600, 600))
	rand.New(rand.NewSource(1)).Read(img.Pix)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	prompt, _ := json.Marshal(protocol.Envelope{
		Type:      protocol.TypePrompt,
		RequestID: "r1",
		Payload: mustJSON(t, protocol.PromptPayload{
			Text:   "what is this?",
			Images: []protocol.PromptImage{{MediaType: "image/png", Data: base64.StdEncoding.EncodeToString(buf.Bytes())}},
		}),
	})
	if len(prompt) <= maxInboundMessageBytes {
		t.Fatalf("test prompt is %d bytes, want it over the %d-byte base cap", len(prompt), maxInboundMessageBytes)
	}

	open := func() (*sseStream, string) {
		st := openSSEWithToken(t, srv, fx.key, testOrigin)
		id := st.sessionID(t)
		post(t, srv, http.MethodPost, id, testOrigin, `{"type":"hello","payload":{"appId":"`+fx.appID+`"}}`)
		if ack := st.envelope(t); ack.Type != protocol.TypeAck {
			t.Fatalf("after hello got %s, want ack", ack.Type)
		}
		return st, id
	}

	_, id := open()
	if resp := post(t, srv, http.MethodPost, id, testOrigin, string(prompt)); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("app without images: POST status = %d, want 413", resp.StatusCode)
	}

	one := 1
	if err := fx.apps.SetMaxPromptImages(fx.appID, &one); err != nil {
		t.Fatalf("SetMaxPromptImages: %v", err)
	}
	st, id := open()
	if resp := post(t, srv, http.MethodPost, id, testOrigin, string(prompt)); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("app with images: POST status = %d, want 202", resp.StatusCode)
	}
	if reply := st.envelope(t); reply.Type != protocol.TypeAssistantMessage {
		t.Fatalf("after image prompt got %s, want assistant_message", reply.Type)
	}
	if infer.req == nil || len(infer.req.Images) != 1 || infer.req.Images[0].MediaType != "image/png" {
		t.Fatalf("inference request = %+v, want one png image", infer.req)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	return b
}
