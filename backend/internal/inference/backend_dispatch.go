package inference

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/tim72117/onagent/internal/toolschema"
	"github.com/tim72117/want/types"
)

// defaultDispatchTimeout matches interactionTimeout (want.go's
// completeTimeout's sibling for the browser-dispatch path, see
// ws/session.go) so a BackendDispatch tool with no explicit TimeoutMS
// behaves similarly to today's default.
const defaultDispatchTimeout = 20 * time.Second

// backendDispatchTool routes a tool call to the developer's own backend over
// outbound HTTP instead of to the connected browser page — see
// toolschema.Tool.BackendDispatch's doc comment for what this deliberately
// doesn't implement yet (no request signing, no retry, no async/callback).
//
// Always blocks and feeds the response back into the LLM's context, the
// same as queryTool — a tool with no browser-side presence has nothing
// useful to report except the real data it fetched, so there's no
// forwardingTool-equivalent "fire and forget" mode for BackendDispatch.
type backendDispatchTool struct {
	types.BaseToolConfig
	name   string
	config *toolschema.BackendDispatch
}

func (b *backendDispatchTool) ValidateInput(types.ToolArguments, types.ToolContext) error {
	return nil
}

func (b *backendDispatchTool) Call(args types.ToolArguments, ctx types.ToolContext) ([]types.ResultContentBlock, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, fmt.Errorf("marshal args for %s: %w", b.name, err)
	}

	result, err := dispatchBackend(context.Background(), b.config, b.name, raw)
	if err != nil {
		return nil, fmt.Errorf("dispatch %s: %w", b.name, err)
	}

	var answer interface{}
	if err := json.Unmarshal(result, &answer); err != nil {
		answer = string(result) // not JSON — surface it as-is rather than failing the whole call
	}
	ctx.EmitToolResult(map[string]interface{}{"answer": answer})
	return []types.ResultContentBlock{types.TextBlock(string(result))}, nil
}

func (b *backendDispatchTool) RenderToolUse(args types.ToolArguments) string {
	return fmt.Sprintf("Calling backend for %s", b.name)
}

func (b *backendDispatchTool) RenderToolUseError(err error) string {
	return fmt.Sprintf("Failed to call backend for %s: %v", b.name, err)
}

func (b *backendDispatchTool) RenderToolResult(data map[string]interface{}) string {
	return fmt.Sprintf("Backend answered %s", b.name)
}

// dispatchRequest is the body POSTed to a BackendDispatch tool's Endpoint.
type dispatchRequest struct {
	ToolName string          `json:"toolName"`
	Args     json.RawMessage `json:"args"`
}

// dispatchResponse is the body a BackendDispatch endpoint is expected to
// return. PoC-scope contract only (see
// docs/backend-tool-dispatch-design-2026-08-08.md) — no FailureKind yet,
// so a "tool_error" (bad args, nothing retry would fix) and a
// "tool_unavailable" (transient, retry might help) both surface identically
// to the caller today.
type dispatchResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// dispatchBackend POSTs {toolName, args} to config.Endpoint and returns the
// response's result field. Deliberately unauthenticated (see
// toolschema.Tool.BackendDispatch's doc comment) — do not point this at an
// endpoint that isn't already trusted out of band.
func dispatchBackend(ctx context.Context, config *toolschema.BackendDispatch, toolName string, args json.RawMessage) (json.RawMessage, error) {
	timeout := defaultDispatchTimeout
	if config.TimeoutMS > 0 {
		timeout = time.Duration(config.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	body, err := json.Marshal(dispatchRequest{ToolName: toolName, Args: args})
	if err != nil {
		return nil, fmt.Errorf("marshal dispatch request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, config.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call %s: %w", config.Endpoint, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1MiB cap — a misbehaving endpoint shouldn't be able to exhaust memory
	if err != nil {
		return nil, fmt.Errorf("read response from %s: %w", config.Endpoint, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s returned HTTP %d: %s", config.Endpoint, resp.StatusCode, string(respBody))
	}

	var parsed dispatchResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("unmarshal response from %s: %w", config.Endpoint, err)
	}
	if !parsed.OK {
		return nil, fmt.Errorf("%s reported failure: %s", config.Endpoint, parsed.Error)
	}
	return parsed.Result, nil
}
