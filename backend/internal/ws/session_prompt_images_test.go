package ws

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"testing"

	"github.com/tim72117/onagent/internal/inference"
	"github.com/tim72117/onagent/internal/protocol"
	"github.com/tim72117/onagent/internal/toolschema"
	wanttypes "github.com/tim72117/want/types"
)

// capturingInference records the Request handlePrompt passed in, so a test
// can check which images actually reached inference and in what order.
type capturingInference struct {
	req    *inference.Request
	called bool
}

func (c *capturingInference) Complete(ctx context.Context, req inference.Request) (*inference.Result, error) {
	c.called = true
	c.req = &req
	return &inference.Result{AssistantMessage: "ok"}, nil
}

func (c *capturingInference) CloseSession(sessionID string) {}

// pngBase64 returns a real w×h PNG, base64-encoded — what the SDK sends.
// The size makes two images distinguishable by content.
func pngBase64(t *testing.T, w, h int) string {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func imagePrompt(t *testing.T, requestID, text string, imgs ...protocol.PromptImage) protocol.Envelope {
	t.Helper()
	payload, err := json.Marshal(protocol.PromptPayload{Text: text, Images: imgs})
	if err != nil {
		t.Fatalf("marshal prompt payload: %v", err)
	}
	return protocol.Envelope{Type: protocol.TypePrompt, RequestID: requestID, Payload: payload}
}

func errorCode(t *testing.T, env protocol.Envelope) string {
	t.Helper()
	if env.Type != protocol.TypeError {
		t.Fatalf("envelope Type = %q, want %q", env.Type, protocol.TypeError)
	}
	var p protocol.ErrorPayload
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("unmarshal ErrorPayload: %v", err)
	}
	return p.Code
}

func TestHandlePrompt_Images(t *testing.T) {
	setMaxPromptImagesEnv(t, "")
	small := protocol.PromptImage{MediaType: "image/png", Data: pngBase64(t, 1, 1)}
	other := protocol.PromptImage{MediaType: "image/png", Data: pngBase64(t, 2, 2)}

	rejections := []struct {
		name     string
		appLimit *int
		images   []protocol.PromptImage
		wantCode string
	}{
		{
			name:     "app without an image setting rejects any image",
			appLimit: nil,
			images:   []protocol.PromptImage{small},
			wantCode: protocol.CodeImagesNotAllowed,
		},
		{
			name:     "more images than the app allows",
			appLimit: intPtr(1),
			images:   []protocol.PromptImage{small, other},
			wantCode: protocol.CodeTooManyImages,
		},
		{
			name:     "app limit above the system cap is clamped to it",
			appLimit: intPtr(100),
			images:   []protocol.PromptImage{small, small, small, small, small},
			wantCode: protocol.CodeTooManyImages,
		},
		{
			name:     "unsupported media type",
			appLimit: intPtr(1),
			images:   []protocol.PromptImage{{MediaType: "image/svg+xml", Data: small.Data}},
			wantCode: protocol.CodeInvalidImage,
		},
		{
			name:     "data that is not base64",
			appLimit: intPtr(1),
			images:   []protocol.PromptImage{{MediaType: "image/png", Data: "not base64!"}},
			wantCode: protocol.CodeInvalidImage,
		},
		{
			name:     "bytes that are not the declared type",
			appLimit: intPtr(1),
			images:   []protocol.PromptImage{{MediaType: "image/jpeg", Data: small.Data}},
			wantCode: protocol.CodeInvalidImage,
		},
		{
			name:     "an invalid image among valid ones rejects the whole prompt",
			appLimit: intPtr(3),
			images:   []protocol.PromptImage{small, {MediaType: "image/png", Data: ""}, other},
			wantCode: protocol.CodeInvalidImage,
		},
	}
	for _, tc := range rejections {
		t.Run(tc.name, func(t *testing.T) {
			s, rec := newTestSession()
			infer := &capturingInference{}
			s.infer = infer
			s.app = &toolschema.App{AppID: "test-app", MaxPromptImages: tc.appLimit}

			s.handlePrompt(context.Background(), imagePrompt(t, "req", "what is this?", tc.images...))

			if infer.called {
				t.Fatal("rejected prompt reached inference")
			}
			if got := errorCode(t, rec.last(t)); got != tc.wantCode {
				t.Errorf("error Code = %q, want %q", got, tc.wantCode)
			}
		})
	}

	t.Run("accepted images reach inference in order", func(t *testing.T) {
		s, rec := newTestSession()
		infer := &capturingInference{}
		s.infer = infer
		s.app = &toolschema.App{AppID: "test-app", MaxPromptImages: intPtr(2)}

		s.handlePrompt(context.Background(), imagePrompt(t, "req", "compare these", small, other))

		if got := rec.last(t); got.Type != protocol.TypeAssistantMessage {
			t.Fatalf("envelope Type = %q, want %q", got.Type, protocol.TypeAssistantMessage)
		}
		want := []inference.Image{{MediaType: small.MediaType, Data: small.Data}, {MediaType: other.MediaType, Data: other.Data}}
		if infer.req == nil || len(infer.req.Images) != len(want) || infer.req.Images[0] != want[0] || infer.req.Images[1] != want[1] {
			t.Fatalf("inference got images %+v, want %+v", infer.req.Images, want)
		}
		if infer.req.Prompt != "compare these" {
			t.Errorf("inference got prompt %q, want %q", infer.req.Prompt, "compare these")
		}
	})

	t.Run("text-only prompt is untouched on an app without images", func(t *testing.T) {
		s, _ := newTestSession()
		infer := &capturingInference{}
		s.infer = infer
		s.app = &toolschema.App{AppID: "test-app"}

		s.handlePrompt(context.Background(), imagePrompt(t, "req", "hello"))

		if !infer.called || len(infer.req.Images) != 0 {
			t.Fatalf("text-only prompt: called=%t images=%v, want called with no images", infer.called, infer.req)
		}
	})
}

// TestInboundLimit: the larger frame/body cap applies only to a session
// whose app accepts images, and only after hello has bound that app.
func TestInboundLimit(t *testing.T) {
	setMaxPromptImagesEnv(t, "")
	perImage := int64(base64.StdEncoding.EncodedLen(int(wanttypes.MaxImageBytes)))

	s, _ := newTestSession()
	if got := s.inboundLimit(); got != maxInboundMessageBytes {
		t.Errorf("before hello: %d, want %d", got, maxInboundMessageBytes)
	}

	s.app = &toolschema.App{AppID: "test-app"}
	if got := s.inboundLimit(); got != maxInboundMessageBytes {
		t.Errorf("app without images: %d, want %d", got, maxInboundMessageBytes)
	}

	s.app = &toolschema.App{AppID: "test-app", MaxPromptImages: intPtr(2)}
	if got, want := s.inboundLimit(), maxInboundMessageBytes+2*perImage; got != want {
		t.Errorf("app with 2 images: %d, want %d", got, want)
	}

	// At the default system cap the largest prompt still fits Cloud Run's
	// 32MiB HTTP request limit, which bounds the SSE POST.
	s.app = &toolschema.App{AppID: "test-app", MaxPromptImages: intPtr(100)}
	if got := s.inboundLimit(); got >= 32<<20 {
		t.Errorf("app at the system cap: %d bytes, want under 32MiB", got)
	}
}

func intPtr(n int) *int { return &n }

func setMaxPromptImagesEnv(t *testing.T, value string) {
	t.Helper()
	t.Setenv("MAX_PROMPT_IMAGES", value)
}
