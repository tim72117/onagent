package codegen

import "github.com/tim72117/agent/internal/toolschema"

// LLMTool is the shape most LLM tool-calling APIs (OpenAI, Anthropic)
// expect: a flat list of {name, description, input_schema}.
type LLMTool struct {
	Name        string                     `json:"name"`
	Description string                     `json:"description"`
	InputSchema toolschema.ParameterSchema `json:"input_schema"`
}

// ToLLMTools converts an app's developer-defined tools into the JSON shape
// handed to the inference service as its available tool set.
func ToLLMTools(app *toolschema.App) []LLMTool {
	out := make([]LLMTool, 0, len(app.Tools))
	for _, t := range app.Tools {
		out = append(out, LLMTool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.Parameters,
		})
	}
	return out
}
