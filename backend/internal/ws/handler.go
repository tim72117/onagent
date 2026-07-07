package ws

import (
	"log/slog"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/tim72117/agent-tool-platform/internal/inference"
	"github.com/tim72117/agent-tool-platform/internal/toolschema"
)

// Handler upgrades HTTP connections to WebSocket sessions for the Agent
// Bridge SDK. Unlike CORS-protected fetch/XHR, a WebSocket handshake is
// NOT gated by the browser: any page can attempt to open a connection to
// any origin. The server is the only line of defense, so AllowedOrigins is
// enforced here rather than left to browser behavior.
type Handler struct {
	Apps           map[string]*toolschema.App
	Inference      inference.Service
	Log            *slog.Logger
	AllowedOrigins OriginChecker

	upgrader websocket.Upgrader
}

// OriginChecker decides whether a WebSocket handshake from the given Origin
// header should be accepted.
type OriginChecker func(origin string) bool

// AllowAllOrigins accepts every origin. Only appropriate for local
// development; production deployments should pass a real allowlist backed
// by each developer app's registered domains.
func AllowAllOrigins(string) bool { return true }

func NewHandler(apps map[string]*toolschema.App, infer inference.Service, log *slog.Logger, allowed OriginChecker) *Handler {
	h := &Handler{
		Apps:           apps,
		Inference:      infer,
		Log:            log,
		AllowedOrigins: allowed,
	}
	h.upgrader = websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				// Non-browser clients (curl, server-to-server) send no
				// Origin header; allow them through to the app-level
				// appId check in the hello message instead.
				return true
			}
			return h.AllowedOrigins(origin)
		},
	}
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.Log.Info("ws upgrade rejected", "err", err, "origin", r.Header.Get("Origin"))
		return
	}
	NewSession(r.Context(), conn, h.Apps, h.Inference, h.Log)
}
