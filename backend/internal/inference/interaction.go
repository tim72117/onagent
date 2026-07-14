package inference

import (
	"encoding/json"
	"fmt"
	"sync"
)

// InteractionAsker is what a WS session implements to let a ToolKindQuery
// tool (see queryTool in agent_roles.go) reach the actual connected
// browser: send it a request, block until the browser answers (or the
// session decides to time out/error), return the answer.
//
// queryTool.Call runs inside want's own goroutine (via
// ToolContext.RequestInteraction — see want/orchestrator/dispatch), with no
// direct reference to the ws.Session that owns the connection this
// conversation belongs to. RegisterAsker/lookupAsker is the bridge: each
// Session registers itself here (keyed by its own id, the same id
// WantService.Complete derives orch.AgentID from — see sanitizeSessionID)
// when it starts, and deregisters when the connection closes. queryTool
// recovers the session id from ctx.GetAgentID() (strips the "WS-"/"PG-..."
// prefix WantService.Complete added) and looks up the matching asker.
type InteractionAsker interface {
	AskInteraction(toolName string, args json.RawMessage) (json.RawMessage, error)
}

var (
	askersMu sync.RWMutex
	askers   = make(map[string]InteractionAsker)
)

// RegisterAsker makes sessionID's asker reachable from queryTool.Call.
// sessionID is the raw WS session id (or Playground's PG-<userID>-<appID>
// composite), not the want AgentID derived from it — see AgentIDToSessionID
// for the inverse of that derivation.
func RegisterAsker(sessionID string, asker InteractionAsker) {
	askersMu.Lock()
	askers[sessionID] = asker
	askersMu.Unlock()
}

// UnregisterAsker removes sessionID's asker (call on connection close, or
// queryTool.Call would otherwise reach a closed/gone session and hang until
// want's own interaction timeout).
func UnregisterAsker(sessionID string) {
	askersMu.Lock()
	delete(askers, sessionID)
	askersMu.Unlock()
}

func lookupAsker(sessionID string) (InteractionAsker, bool) {
	askersMu.RLock()
	defer askersMu.RUnlock()
	a, ok := askers[sessionID]
	return a, ok
}

// AgentIDToSessionID reverses the "WS-"/"PG-" prefixing WantService.Complete
// applies to orch.AgentID (see want.go's sanitizeSessionID call site) back
// to the raw session id RegisterAsker/UnregisterAsker key on. Only "WS-" is
// stripped — Playground's "PG-<userID>-<appID>" sessions never register an
// asker (there's no real page behind them to ask, per playground.go's own
// doc comment about tool_calls being display-only there), so a query tool
// used from Playground correctly fails with "no page connected" rather than
// silently hanging.
func AgentIDToSessionID(agentID string) (sessionID string, ok bool) {
	const wsPrefix = "WS-"
	if len(agentID) > len(wsPrefix) && agentID[:len(wsPrefix)] == wsPrefix {
		return agentID[len(wsPrefix):], true
	}
	return "", false
}

// askPage is queryTool.Call's actual bridge to the browser: resolve the
// current want call's session from ctx.GetAgentID(), find its registered
// asker, and block on it.
func askPage(agentID, toolName string, args json.RawMessage) (json.RawMessage, error) {
	sessionID, ok := AgentIDToSessionID(agentID)
	if !ok {
		return nil, fmt.Errorf("query tools aren't available in this context (no page connection behind agent %q)", agentID)
	}
	asker, ok := lookupAsker(sessionID)
	if !ok {
		return nil, fmt.Errorf("no connected page for session %q (it may have disconnected)", sessionID)
	}
	return asker.AskInteraction(toolName, args)
}
