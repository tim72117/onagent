package inference

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tim72117/onagent/internal/toolschema"
)

// MockService is a placeholder Service used until the real inference
// backend is wired in. It does no actual reasoning: if the prompt
// mentions a known tool name it echoes a plausible tool call, otherwise it
// just replies with the prompt text. This is enough to exercise the full
// WebSocket -> tool_call -> tool_result loop end-to-end.
type MockService struct{}

func NewMock() *MockService { return &MockService{} }

func (m *MockService) Complete(_ context.Context, req Request) (*Result, error) {
	for _, tool := range req.Tools {
		if containsWord(req.Prompt, tool.Name) {
			return &Result{
				ToolCalls: []ToolCall{{
					ToolName: tool.Name,
					// Real inference would fill these from the model's
					// output; the mock synthesizes plausible placeholder
					// values from the tool's own parameter schema.
					Args: mockArgsFor(tool.InputSchema),
				}},
				AssistantMessage: fmt.Sprintf("(mock) calling tool %q with placeholder args", tool.Name),
			}, nil
		}
	}
	return &Result{
		AssistantMessage: fmt.Sprintf("(mock inference, no real LLM wired up yet) you said: %s", req.Prompt),
	}, nil
}

// mockArgsFor builds a JSON object filling each declared property with a
// plausible placeholder value, so the demo visibly reflects the tool call
// instead of receiving undefined/generic placeholders for every argument.
func mockArgsFor(schema toolschema.ParameterSchema) json.RawMessage {
	out := map[string]interface{}{}
	for name, prop := range schema.Properties {
		if prop == nil {
			continue
		}
		switch {
		case name == "clear":
			// A "clear"-style flag conventionally means "undo/reset instead
			// of act" — default it to false so the mock demonstrates the
			// act-on-real-data path rather than always resetting.
			out[name] = false
		case prop.Type == "string":
			out[name] = "mock " + name
		case prop.Type == "number" || prop.Type == "integer":
			out[name] = 1000
		case prop.Type == "boolean":
			out[name] = true
		case prop.Type == "array":
			out[name] = []interface{}{"mock " + name}
		default:
			out[name] = "mock " + name
		}
	}
	b, _ := json.Marshal(out)
	return b
}

func containsWord(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}
