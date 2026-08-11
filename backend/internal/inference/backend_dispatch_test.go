package inference

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/toolschema"
)

func TestDispatchBackend_Success(t *testing.T) {
	var gotBody dispatchRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("expected Content-Type application/json, got %q", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"places":["Cafe A","Cafe B"]}}`))
	}))
	defer srv.Close()

	config := &toolschema.BackendDispatch{Endpoint: srv.URL}
	result, err := dispatchBackend(t.Context(), config, "recommend_nearby", json.RawMessage(`{"lat":25.03,"lng":121.56}`))
	if err != nil {
		t.Fatalf("dispatchBackend: %v", err)
	}

	if gotBody.ToolName != "recommend_nearby" {
		t.Errorf("expected toolName=recommend_nearby in request, got %q", gotBody.ToolName)
	}
	if string(gotBody.Args) != `{"lat":25.03,"lng":121.56}` {
		t.Errorf("expected args to round-trip, got %s", gotBody.Args)
	}

	var got struct{ Places []string }
	if err := json.Unmarshal(result, &got); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if len(got.Places) != 2 || got.Places[0] != "Cafe A" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestDispatchBackend_ToolReportedFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":false,"error":"no results found"}`))
	}))
	defer srv.Close()

	config := &toolschema.BackendDispatch{Endpoint: srv.URL}
	_, err := dispatchBackend(t.Context(), config, "recommend_nearby", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected an error when the endpoint reports ok:false, got nil")
	}
}

func TestDispatchBackend_NonSuccessHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("internal error"))
	}))
	defer srv.Close()

	config := &toolschema.BackendDispatch{Endpoint: srv.URL}
	_, err := dispatchBackend(t.Context(), config, "recommend_nearby", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected an error for a non-2xx response, got nil")
	}
}

func TestDispatchBackend_TimeoutRespectsConfiguredTimeoutMS(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	config := &toolschema.BackendDispatch{Endpoint: srv.URL, TimeoutMS: 50}
	start := time.Now()
	_, err := dispatchBackend(t.Context(), config, "slow_tool", json.RawMessage(`{}`))
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a timeout error, got nil")
	}
	if elapsed > 150*time.Millisecond {
		t.Errorf("expected the 50ms TimeoutMS to be respected, took %v", elapsed)
	}
}

func TestDispatchBackend_MalformedJSONResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()

	config := &toolschema.BackendDispatch{Endpoint: srv.URL}
	_, err := dispatchBackend(t.Context(), config, "recommend_nearby", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected an error for a malformed JSON response, got nil")
	}
}

func TestToolFactoryFor_PrefersBackendDispatchOverKind(t *testing.T) {
	tool := toolschema.Tool{
		Name: "recommend_nearby",
		Kind: toolschema.ToolKindQuery, // set on purpose, to confirm BackendDispatch still wins
		BackendDispatch: &toolschema.BackendDispatch{
			Endpoint: "http://example.invalid",
		},
	}
	factory := toolFactoryFor(tool)
	inst := factory()
	if _, ok := inst.(*backendDispatchTool); !ok {
		t.Fatalf("expected toolFactoryFor to select backendDispatchTool when BackendDispatch is set, got %T", inst)
	}
}
