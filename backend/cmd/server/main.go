// Command server runs the agent-tool-platform backend: it loads developer
// tool definitions, exposes codegen endpoints (LLM tool schema + generated
// TypeScript), and serves the WebSocket endpoint the Agent Bridge SDK
// connects to.
package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/tim72117/agent-tool-platform/internal/codegen"
	"github.com/tim72117/agent-tool-platform/internal/inference"
	"github.com/tim72117/agent-tool-platform/internal/toolschema"
	"github.com/tim72117/agent-tool-platform/internal/ws"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))

	toolsDir := envOr("TOOLS_DIR", "tools")
	apps, err := toolschema.LoadDir(toolsDir)
	if err != nil {
		log.Error("failed to load tool definitions", "dir", toolsDir, "err", err)
		os.Exit(1)
	}
	log.Info("loaded tool definitions", "dir", toolsDir, "apps", len(apps))

	originAllowlist := parseOrigins(envOr("ALLOWED_ORIGINS", ""))
	originChecker := ws.AllowAllOrigins
	if len(originAllowlist) > 0 {
		originChecker = allowlistChecker(originAllowlist)
		log.Info("origin allowlist enabled", "origins", originAllowlist)
	} else {
		log.Warn("no ALLOWED_ORIGINS set; accepting WebSocket handshakes from any origin (dev mode only)")
	}

	inferSvc := inference.NewMock()
	wsHandler := ws.NewHandler(apps, inferSvc, log, originChecker)

	mux := http.NewServeMux()
	mux.Handle("/ws", wsHandler)
	mux.HandleFunc("/apps/{appId}/tools.json", handleToolSchema(apps))
	mux.HandleFunc("/apps/{appId}/tools.ts", handleToolTypeScript(apps))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	addr := envOr("ADDR", ":8080")
	log.Info("listening", "addr", addr)
	if err := http.ListenAndServe(addr, withCORS(mux)); err != nil {
		log.Error("server exited", "err", err)
		os.Exit(1)
	}
}

func handleToolSchema(apps map[string]*toolschema.App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		app, ok := apps[r.PathValue("appId")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(codegen.ToLLMTools(app))
	}
}

func handleToolTypeScript(apps map[string]*toolschema.App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		app, ok := apps[r.PathValue("appId")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		src, err := codegen.TypeScript(app)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte(src))
	}
}

// withCORS enables browser fetches to the codegen/REST endpoints above from
// any origin. This is safe here because these endpoints only ever return
// public, non-sensitive artifacts (tool schema, generated TS) keyed by a
// developer-chosen appId — unlike /ws, nothing here is per-user data, so a
// permissive policy doesn't leak anything an allowlist would protect.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseOrigins(csv string) []string {
	if csv == "" {
		return nil
	}
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func allowlistChecker(allowed []string) ws.OriginChecker {
	set := make(map[string]bool, len(allowed))
	for _, o := range allowed {
		set[o] = true
	}
	return func(origin string) bool {
		return set[origin]
	}
}
