package main

// Tests that a CLI command's parsed arguments actually compose the HTTP
// request the console API expects — method, path (including appId
// escaping), body shape, and auth header. This is the layer above
// dispatch_test.go's pure argument-parsing tests: those prove "app origin
// set foo bar" resolves to runAppOrigin(["foo","bar"]); these prove that
// runAppOrigin's underlying apiClient call then produces the exact
// PUT /console/apps/foo/origin request with body {"origins":["bar"]} the
// backend's setOriginRequest struct actually decodes — see setOrigin's own
// doc comment on why a CLI/backend field-shape mismatch is a real,
// previously-shipped bug (the allowed-origins list quietly emptying out)
// rather than a theoretical one.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/toolschema"
)

// capturedRequest is what recordingServer saves for each request it
// receives, decoded just enough for assertions without each test having to
// re-parse method/path/body/auth by hand.
type capturedRequest struct {
	method  string
	path    string // r.URL.Path — decoded (%2F becomes a literal "/")
	rawPath string // r.URL.RawPath / r.URL.EscapedPath() — as sent on the wire, before decoding
	auth    string
	body    []byte
}

// recordingServer returns an httptest.Server that answers every request
// with status and a JSON body (already-marshaled), while saving the
// request it received so the test can assert on how the CLI built it.
// Handlers that need to answer differently per call (e.g. login's cookie)
// should use httptest.NewServer directly instead.
func recordingServer(t *testing.T, status int, responseBody string) (*httptest.Server, *capturedRequest) {
	t.Helper()
	captured := &capturedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		captured.method = r.Method
		captured.path = r.URL.Path
		captured.rawPath = r.URL.EscapedPath()
		captured.auth = r.Header.Get("Authorization")
		captured.body = body
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(responseBody))
	}))
	t.Cleanup(srv.Close)
	return srv, captured
}

// decodeBody unmarshals captured.body into a map for loose field-shape
// assertions — loose on purpose: these tests care whether the JSON has the
// right top-level field names/types (what the backend's json.Decoder with
// DisallowUnknownFields actually checks), not full struct equality.
func decodeBody(t *testing.T, body []byte) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("body is not a JSON object: %v (body: %s)", err, body)
	}
	return m
}

func TestApiClient_CreateApp_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusCreated, `{"appId":"myapp","toolCount":0,"hasKey":false}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if _, err := c.createApp("myapp"); err != nil {
		t.Fatalf("createApp: %v", err)
	}

	if captured.method != http.MethodPost {
		t.Errorf("method = %q, want POST", captured.method)
	}
	if captured.path != "/console/apps" {
		t.Errorf("path = %q, want /console/apps", captured.path)
	}
	if captured.auth != "Bearer tok-123" {
		t.Errorf("Authorization = %q, want %q", captured.auth, "Bearer tok-123")
	}
	body := decodeBody(t, captured.body)
	if body["appId"] != "myapp" {
		t.Errorf("body[appId] = %v, want %q", body["appId"], "myapp")
	}
	if len(body) != 1 {
		t.Errorf("body has extra fields: %v, want only appId", body)
	}
}

// TestApiClient_SetOrigin_RequestShape pins the exact bug set-origin
// shipped with once: the CLI sending a JSON shape the backend's
// setOriginRequest{Origins []string `json:"origins"`} struct had no field
// for, which silently decoded to an empty slice and wiped the app's
// allowed origins while the CLI reported success. Asserting the field is
// named "origins" (plural) and holds an array — not "origin" or a bare
// string — is what would have caught that regression before it shipped.
func TestApiClient_SetOrigin_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"appId":"myapp","toolCount":0,"hasKey":false}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if _, err := c.setOrigin("myapp", "https://example.com"); err != nil {
		t.Fatalf("setOrigin: %v", err)
	}

	if captured.method != http.MethodPut {
		t.Errorf("method = %q, want PUT", captured.method)
	}
	if captured.path != "/console/apps/myapp/origin" {
		t.Errorf("path = %q, want /console/apps/myapp/origin", captured.path)
	}
	body := decodeBody(t, captured.body)
	origins, ok := body["origins"].([]interface{})
	if !ok {
		t.Fatalf("body[origins] = %v (%T), want a JSON array", body["origins"], body["origins"])
	}
	if len(origins) != 1 || origins[0] != "https://example.com" {
		t.Errorf("body[origins] = %v, want [%q]", origins, "https://example.com")
	}
	if _, hasSingular := body["origin"]; hasSingular {
		t.Error(`body has a singular "origin" field — the backend's setOriginRequest only reads "origins" (plural)`)
	}
}

func TestApiClient_SetThought_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"appId":"myapp","toolCount":0,"hasKey":false}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if _, err := c.setThought("myapp", "Be terse."); err != nil {
		t.Fatalf("setThought: %v", err)
	}

	if captured.method != http.MethodPut {
		t.Errorf("method = %q, want PUT", captured.method)
	}
	if captured.path != "/console/apps/myapp/thought" {
		t.Errorf("path = %q, want /console/apps/myapp/thought", captured.path)
	}
	body := decodeBody(t, captured.body)
	if body["thought"] != "Be terse." {
		t.Errorf("body[thought] = %v, want %q", body["thought"], "Be terse.")
	}
}

// TestApiClient_SetThought_EmptyStringClearsIt confirms an empty thought
// is sent as an explicit "" field, not omitted — setThoughtRequest has no
// omitempty, and the backend's doc comment on that struct says an empty
// string is the documented way to clear a thought back to the platform
// default (see runAppThought's own "Cleared ... thought" vs "Set ...
// thought" branching on this). If the CLI ever started omitting an empty
// value, "clear the thought" would silently stop working.
func TestApiClient_SetThought_EmptyStringClearsIt(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"appId":"myapp","toolCount":0,"hasKey":false}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if _, err := c.setThought("myapp", ""); err != nil {
		t.Fatalf("setThought: %v", err)
	}

	body := decodeBody(t, captured.body)
	thought, present := body["thought"]
	if !present {
		t.Fatal(`body is missing the "thought" field entirely — clearing a thought requires sending thought:""`)
	}
	if thought != "" {
		t.Errorf("body[thought] = %v, want empty string", thought)
	}
}

func TestApiClient_IssueKey_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"apiKey":"secret-key-value"}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	key, err := c.issueKey("myapp")
	if err != nil {
		t.Fatalf("issueKey: %v", err)
	}
	if key != "secret-key-value" {
		t.Errorf("issueKey returned %q, want %q", key, "secret-key-value")
	}
	if captured.method != http.MethodPost {
		t.Errorf("method = %q, want POST", captured.method)
	}
	if captured.path != "/console/apps/myapp/key" {
		t.Errorf("path = %q, want /console/apps/myapp/key", captured.path)
	}
}

func TestApiClient_ListApps_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `[{"appId":"a","toolCount":1,"hasKey":true},{"appId":"b","toolCount":0,"hasKey":false}]`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	apps, err := c.listApps()
	if err != nil {
		t.Fatalf("listApps: %v", err)
	}
	if captured.method != http.MethodGet {
		t.Errorf("method = %q, want GET", captured.method)
	}
	if captured.path != "/console/apps" {
		t.Errorf("path = %q, want /console/apps", captured.path)
	}
	if len(captured.body) != 0 {
		t.Errorf("GET request had a non-empty body: %s", captured.body)
	}
	if len(apps) != 2 || apps[0].AppID != "a" || apps[1].AppID != "b" {
		t.Errorf("listApps() = %+v, want [a b]", apps)
	}
}

func TestApiClient_GetApp_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"appId":"myapp","tools":[]}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if _, err := c.getApp("myapp"); err != nil {
		t.Fatalf("getApp: %v", err)
	}
	if captured.method != http.MethodGet {
		t.Errorf("method = %q, want GET", captured.method)
	}
	if captured.path != "/console/apps/myapp" {
		t.Errorf("path = %q, want /console/apps/myapp", captured.path)
	}
}

// TestApiClient_SaveTool_RequestShape asserts saveTool PUTs to
// .../tools/{toolName} (the tool's own name in the URL, matching the
// backend's per-tool upsert route — see console.saveTool's doc comment on
// why the URL and body names must agree) with the tool itself as a bare
// JSON object body, not wrapped or sent as an array — the old flat
// save-tools command sent a JSON array of every tool on the app; this
// single-tool upsert replaced it (see git history) specifically so neither
// the CLI nor the console editor needs the app's whole tool list in hand
// just to add or edit one.
func TestApiClient_SaveTool_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"appId":"myapp","toolCount":1,"hasKey":false}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	tool := toolschema.Tool{Name: "my_tool", Description: "does a thing"}
	if _, err := c.saveTool("myapp", tool); err != nil {
		t.Fatalf("saveTool: %v", err)
	}

	if captured.method != http.MethodPut {
		t.Errorf("method = %q, want PUT", captured.method)
	}
	if captured.path != "/console/apps/myapp/tools/my_tool" {
		t.Errorf("path = %q, want /console/apps/myapp/tools/my_tool", captured.path)
	}
	body := decodeBody(t, captured.body)
	if body["name"] != "my_tool" {
		t.Errorf("body[name] = %v, want %q", body["name"], "my_tool")
	}
	if body["description"] != "does a thing" {
		t.Errorf("body[description] = %v, want %q", body["description"], "does a thing")
	}
}

// TestApiClient_AppIDWithSlash_IsPathEscaped confirms an appId containing
// "/" can't smuggle an extra path segment into the URL — pathEscape's own
// doc comment notes valid appIds never need escaping (toolschema.ValidAppID
// already constrains the character set) and this guards the malformed-input
// case, not a normal one.
func TestApiClient_AppIDWithSlash_IsPathEscaped(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"appId":"a/b","toolCount":0,"hasKey":false}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if _, err := c.setThought("a/b", "x"); err != nil {
		t.Fatalf("setThought: %v", err)
	}
	// r.URL.Path is Go's *decoded* path — %2F round-trips back to a literal
	// "/" once parsed, same as any other percent-escaped character. What
	// pathEscape actually defends against is visible one level lower, on
	// the wire: RawPath preserves the original %2F rather than a bare "/",
	// which is what stops "a/b" from being interpreted as two path
	// segments by any intermediary (proxy, router) that splits on literal
	// "/" before decoding — Go's own ServeMux is one such router, and this
	// is the difference between it seeing one segment ("a/b") or two
	// ("a", "b").
	if captured.path != "/console/apps/a/b/thought" {
		t.Errorf("decoded path = %q, want /console/apps/a/b/thought (%%2F decodes back to a literal slash)", captured.path)
	}
	if captured.rawPath != "/console/apps/a%2Fb/thought" {
		t.Errorf("raw (wire) path = %q, want the slash kept percent-escaped so routers splitting on literal \"/\" see one segment, not two", captured.rawPath)
	}
}

// TestApiClient_ErrorResponse_SurfacesBody confirms a non-2xx response's
// body (the backend's http.Error plaintext) reaches the caller as the
// error message, not swallowed or replaced by a generic "request failed" —
// this is what lets runAppOrigin etc. show the actual backend rejection
// reason (e.g. an invalid appId) instead of just "400 Bad Request".
func TestApiClient_ErrorResponse_SurfacesBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "appId already taken", http.StatusConflict)
	}))
	t.Cleanup(srv.Close)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	_, err := c.createApp("myapp")
	if err == nil {
		t.Fatal("createApp returned nil error for a 409 response")
	}
	if got := err.Error(); !strings.Contains(got, "appId already taken") {
		t.Errorf("error = %q, want it to contain the backend's message %q", got, "appId already taken")
	}
}

// TestApiClient_DeleteTool_RequestShape confirms DELETE .../tools/{toolName}
// carries no body and returns without error on the backend's 200+appSummary
// response — the delete counterpart to TestApiClient_SaveTool_RequestShape's
// upsert.
func TestApiClient_DeleteTool_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusOK, `{"appId":"myapp","toolCount":1,"hasKey":false}`)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	summary, err := c.deleteTool("myapp", "my_tool")
	if err != nil {
		t.Fatalf("deleteTool: %v", err)
	}
	if summary.ToolCount != 1 {
		t.Errorf("deleteTool returned ToolCount = %d, want 1 (the backend's post-delete count)", summary.ToolCount)
	}

	if captured.method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", captured.method)
	}
	if captured.path != "/console/apps/myapp/tools/my_tool" {
		t.Errorf("path = %q, want /console/apps/myapp/tools/my_tool", captured.path)
	}
	if len(captured.body) != 0 {
		t.Errorf("DELETE request had a non-empty body: %s", captured.body)
	}
}

// TestApiClient_DeleteApp_RequestShape confirms DELETE /console/apps/
// {appId} carries no body and tolerates the backend's 204-with-no-body
// response (unlike deleteTool/saveTool, there's nothing left to decode —
// see deleteApp's own doc comment on why this returns only an error, no
// appSummary).
func TestApiClient_DeleteApp_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusNoContent, "")
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if err := c.deleteApp("myapp"); err != nil {
		t.Fatalf("deleteApp: %v", err)
	}

	if captured.method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", captured.method)
	}
	if captured.path != "/console/apps/myapp" {
		t.Errorf("path = %q, want /console/apps/myapp", captured.path)
	}
	if len(captured.body) != 0 {
		t.Errorf("DELETE request had a non-empty body: %s", captured.body)
	}
}

// TestApiClient_RevokeKey_RequestShape confirms DELETE /console/apps/
// {appId}/key carries no body and tolerates a 204-with-no-body response,
// same as deleteApp.
func TestApiClient_RevokeKey_RequestShape(t *testing.T) {
	srv, captured := recordingServer(t, http.StatusNoContent, "")
	c := &apiClient{base: srv.URL, token: "tok-123"}

	if err := c.revokeKey("myapp"); err != nil {
		t.Fatalf("revokeKey: %v", err)
	}

	if captured.method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", captured.method)
	}
	if captured.path != "/console/apps/myapp/key" {
		t.Errorf("path = %q, want /console/apps/myapp/key", captured.path)
	}
	if len(captured.body) != 0 {
		t.Errorf("DELETE request had a non-empty body: %s", captured.body)
	}
}

// TestApiClient_DeleteApp_ErrorResponse_SurfacesBody confirms deleteApp
// (which has no response body to decode on success) still surfaces the
// backend's error message on failure — the same error path
// TestApiClient_ErrorResponse_SurfacesBody pins for createApp, exercised
// here since deleteApp's success path never touches res.Body at all and
// could plausibly have dropped this along the way.
func TestApiClient_DeleteApp_ErrorResponse_SurfacesBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "app not found", http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	c := &apiClient{base: srv.URL, token: "tok-123"}

	err := c.deleteApp("no-such-app")
	if err == nil {
		t.Fatal("deleteApp returned nil error for a 404 response")
	}
	if got := err.Error(); !strings.Contains(got, "app not found") {
		t.Errorf("error = %q, want it to contain the backend's message %q", got, "app not found")
	}
}
