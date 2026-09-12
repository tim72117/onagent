package ws

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/protocol"
	"github.com/tim72117/onagent/internal/toolschema"
)

// fakeInferenceService is a minimal inference.Service that never actually
// reasons about anything — enough to prove handlePrompt reached (or didn't
// reach) the inference call, which is the only thing these tests care
// about.
type fakeInferenceService struct {
	called bool
}

func (f *fakeInferenceService) Complete(ctx context.Context, req inference.Request) (*inference.Result, error) {
	f.called = true
	return &inference.Result{AssistantMessage: "ok"}, nil
}

func (f *fakeInferenceService) CloseSession(sessionID string) {}

// TestHandlePrompt_RejectsPromptOverAppLimit confirms handlePrompt's
// character-count gate (session.go, right before the inference.Service.
// Complete call) rejects an oversized prompt with protocol.CodePromptTooLong
// and never reaches inference — the whole point of checking before the
// costly call, not after.
func TestHandlePrompt_RejectsPromptOverAppLimit(t *testing.T) {
	s, rec := newTestSession()
	infer := &fakeInferenceService{}
	s.infer = infer
	limit := 10
	s.app = &toolschema.App{AppID: "test-app", MaxPromptLength: &limit}

	env := protocol.Envelope{
		Type:      protocol.TypePrompt,
		RequestID: "req-1",
		Payload:   []byte(`{"text":"this text is definitely longer than ten characters"}`),
	}
	s.handlePrompt(context.Background(), env)

	if infer.called {
		t.Fatal("handlePrompt called inference.Service.Complete for an oversized prompt, want it rejected before that call")
	}

	got := rec.last(t)
	if got.Type != protocol.TypeError {
		t.Fatalf("envelope Type = %q, want %q", got.Type, protocol.TypeError)
	}
	var payload protocol.ErrorPayload
	if err := json.Unmarshal(got.Payload, &payload); err != nil {
		t.Fatalf("unmarshal ErrorPayload: %v", err)
	}
	if payload.Code != protocol.CodePromptTooLong {
		t.Errorf("error Code = %q, want %q", payload.Code, protocol.CodePromptTooLong)
	}
}

// TestHandlePrompt_AllowsPromptWithinAppLimit confirms a prompt at or under
// the app's effective limit reaches inference normally — the gate rejects
// only what's actually over the limit, not everything.
func TestHandlePrompt_AllowsPromptWithinAppLimit(t *testing.T) {
	s, rec := newTestSession()
	infer := &fakeInferenceService{}
	s.infer = infer
	limit := 500
	s.app = &toolschema.App{AppID: "test-app", MaxPromptLength: &limit}

	env := protocol.Envelope{
		Type:      protocol.TypePrompt,
		RequestID: "req-2",
		Payload:   []byte(`{"text":"short prompt"}`),
	}
	s.handlePrompt(context.Background(), env)

	if !infer.called {
		t.Fatal("handlePrompt did not call inference.Service.Complete for an in-limit prompt")
	}

	got := rec.last(t)
	if got.Type != protocol.TypeAssistantMessage {
		t.Fatalf("envelope Type = %q, want %q", got.Type, protocol.TypeAssistantMessage)
	}
}

// TestHandlePrompt_CountsCharactersNotBytes confirms the length gate counts
// runes (characters), not UTF-8 bytes — a regression test for a real bug
// where len(p.Text) (byte length) was compared against a character limit,
// wrongly rejecting multi-byte-script prompts (Chinese/Japanese/Korean,
// emoji) well under their actual character count. 100 CJK characters here
// are 300 bytes (3 bytes/char), comfortably over a 200-byte threshold but
// well under the 250-character limit — this must be allowed through.
func TestHandlePrompt_CountsCharactersNotBytes(t *testing.T) {
	s, rec := newTestSession()
	infer := &fakeInferenceService{}
	s.infer = infer
	limit := 250
	s.app = &toolschema.App{AppID: "test-app", MaxPromptLength: &limit}

	text := strings.Repeat("測", 100) // 100 runes, 300 bytes
	payload, err := json.Marshal(protocol.PromptPayload{Text: text})
	if err != nil {
		t.Fatalf("marshal prompt payload: %v", err)
	}
	env := protocol.Envelope{
		Type:      protocol.TypePrompt,
		RequestID: "req-3",
		Payload:   payload,
	}
	s.handlePrompt(context.Background(), env)

	if !infer.called {
		t.Fatal("handlePrompt rejected a 100-character CJK prompt against a 250-character limit — the gate is counting bytes, not characters")
	}

	got := rec.last(t)
	if got.Type != protocol.TypeAssistantMessage {
		t.Fatalf("envelope Type = %q, want %q", got.Type, protocol.TypeAssistantMessage)
	}
}
