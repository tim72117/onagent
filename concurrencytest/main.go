// concurrencytest drives concurrent WebSocket "virtual users" against the
// onagent backend's /ws endpoint and checks that they don't interfere with
// each other — each user asks the LLM to repeat back a unique nonce and
// asserts its own response contains that same nonce, never another user's.
//
// This is a scenario/correctness check, not a load/stress test: it proves
// isolation under concurrency (does response content ever cross wires
// between sessions sharing the single serialized orchestrator, or between
// different apps' tool declarations — see docs/project-audit.md's A1 and
// S1), not throughput or latency under pressure.
//
// Works against a real LLM provider (not just mock inference): the prompt
// explicitly instructs the model to repeat the nonce verbatim, and the
// match is a substring check tolerant of surrounding text the model adds.
// A real model occasionally paraphrasing/mangling the nonce despite the
// instruction shows up as a false "cross-talk" failure — rerun individual
// failures once before treating them as real cross-session bugs.
//
// Because inference.WantService currently serializes every request behind
// one global mutex (see docs/project-audit.md's A1), per-user latency
// grows with concurrency when pointed at a real provider — each user's
// request queues behind every earlier one, across every app sharing that
// backend. That's expected, not a bug: raise -timeout generously (the
// default already assumes this) rather than reading timeouts as failures.
//
// What scenario runs — which app(s), how many concurrent users each, what
// credentials — is entirely described by a JSON config, never by editing
// this file: add an app, change a user count, or mix multiple apps in one
// run purely by editing the config. The single-group -app/-token/-origin/
// -users flags remain as a shorthand for the common one-app case; they
// build the same one-element group list a -config file would.
//
// Usage:
//
//	go run . -users 20 -url ws://localhost:8080/ws -app analysis -token ... -origin ...
//	go run . -config scenario.json
//
// Example scenario.json (multiple apps, each with their own concurrent
// users, all running at once — see docs/project-audit.md's S1):
//
//	{
//	  "groups": [
//	    {"app": "analysis",     "token": "...", "origin": "http://localhost:5175", "users": 5},
//	    {"app": "cli-test-app", "token": "...", "origin": "http://localhost:9999", "users": 5}
//	  ]
//	}
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type envelope struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

// group describes one app's slice of virtual users: how many, and what
// identity/credentials they connect with. This is the unit a JSON config
// file lists — the whole point being that new scenarios (more apps, more
// users, different mixes) are expressed as more/edited groups, never as
// changes to the Go code driving them.
type group struct {
	App    string `json:"app"`
	Token  string `json:"token"`
	Origin string `json:"origin"`
	Users  int    `json:"users"`
	// Scenario selects which per-user WS interaction to run. Only
	// "repeat_nonce" (the cross-talk check) exists today; the field exists
	// so a future second scenario (e.g. multi-turn conversations, or a
	// deliberately-hanging query tool per docs/project-audit.md's S2) is
	// also just a config value, not a new flag or code path callers must
	// know to opt into.
	Scenario string `json:"scenario"`
}

type config struct {
	Groups []group `json:"groups"`
}

// spec is one virtual user's fully-resolved identity, after flattening
// every group's Users count into individual entries — what actually gets
// handed to a goroutine.
type spec struct {
	globalIdx int
	app       string
	token     string
	origin    string
	scenario  string
}

type userResult struct {
	spec    spec
	ok      bool
	err     error
	elapsed time.Duration
}

func main() {
	wsURL := flag.String("url", "ws://localhost:8080/ws", "backend WebSocket endpoint")
	configPath := flag.String("config", "", "path to a JSON scenario file (see this file's header comment for the format); overrides -app/-token/-origin/-users when set")
	appID := flag.String("app", "analysis", "single-app shorthand: appId to connect as (ignored if -config is set)")
	token := flag.String("token", os.Getenv("CONCURRENCYTEST_TOKEN"), "single-app shorthand: API key for -app, defaults to $CONCURRENCYTEST_TOKEN (ignored if -config is set)")
	origin := flag.String("origin", "", "single-app shorthand: Origin header to send, must exactly match the app's allowed_origin (ignored if -config is set)")
	users := flag.Int("users", 10, "single-app shorthand: number of concurrent virtual users (ignored if -config is set)")
	timeout := flag.Duration("timeout", 120*time.Second, "per-user round-trip timeout (generous: WantService serializes all requests behind one mutex, see A1 — later users wait behind every earlier one on a real provider)")
	flag.Parse()

	var groups []group
	if *configPath != "" {
		loaded, err := loadConfig(*configPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "load -config: %v\n", err)
			os.Exit(1)
		}
		groups = loaded.Groups
	} else {
		groups = []group{{App: *appID, Token: *token, Origin: *origin, Users: *users}}
	}

	specs := flatten(groups)
	if len(specs) == 0 {
		fmt.Fprintln(os.Stderr, "no virtual users to run (empty groups / users=0)")
		os.Exit(1)
	}

	results := make(chan userResult, len(specs))
	var wg sync.WaitGroup
	start := time.Now()

	for _, s := range specs {
		wg.Add(1)
		go func(s spec) {
			defer wg.Done()
			results <- runUser(s, *wsURL, *timeout)
		}(s)
	}

	wg.Wait()
	close(results)

	ordered := make([]userResult, len(specs))
	for r := range results {
		ordered[r.spec.globalIdx] = r
	}

	var ok, crossTalk, otherFail int
	for _, r := range ordered {
		status := "OK"
		switch {
		case r.ok:
			ok++
		case r.err != nil && strings.Contains(r.err.Error(), "cross-talk"):
			crossTalk++
			status = "CROSS-TALK: " + r.err.Error()
		default:
			otherFail++
			status = "FAIL: " + r.err.Error()
		}
		fmt.Printf("user %3d  app=%-16s  %-10s  %v\n", r.spec.globalIdx, r.spec.app, statusWord(r.ok, status), r.elapsed)
	}

	fmt.Printf("\n%d/%d succeeded, %d cross-talk, %d other failures, wall time %v\n",
		ok, len(specs), crossTalk, otherFail, time.Since(start))

	if crossTalk > 0 || otherFail > 0 {
		os.Exit(1)
	}
}

func loadConfig(path string) (config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return config{}, err
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return config{}, fmt.Errorf("parse %s: %w", path, err)
	}
	return cfg, nil
}

// flatten expands each group's Users count into that many individual
// specs, assigning a single global index across all groups combined — the
// nonce uniqueness guarantee (see runUser) depends on every spec across
// every group getting a distinct index, not just within its own group.
func flatten(groups []group) []spec {
	var specs []spec
	idx := 0
	for _, g := range groups {
		scenario := g.Scenario
		if scenario == "" {
			scenario = "repeat_nonce"
		}
		for i := 0; i < g.Users; i++ {
			specs = append(specs, spec{
				globalIdx: idx,
				app:       g.App,
				token:     g.Token,
				origin:    g.Origin,
				scenario:  scenario,
			})
			idx++
		}
	}
	return specs
}

func statusWord(ok bool, full string) string {
	if ok {
		return "OK"
	}
	return full
}

func runUser(s spec, wsURL string, timeout time.Duration) userResult {
	switch s.scenario {
	case "repeat_nonce", "":
		return runRepeatNonce(s, wsURL, timeout)
	default:
		return userResult{spec: s, ok: false, err: fmt.Errorf("unknown scenario %q", s.scenario)}
	}
}

// runRepeatNonce is the one scenario implemented today: connect, send a
// prompt asking the model to echo a globally-unique nonce, and assert the
// response contains exactly that nonce. See this file's header comment for
// what a mismatch does and doesn't prove.
func runRepeatNonce(s spec, wsURL string, timeout time.Duration) userResult {
	start := time.Now()
	fail := func(err error) userResult {
		return userResult{spec: s, ok: false, err: err, elapsed: time.Since(start)}
	}

	target, err := url.Parse(wsURL)
	if err != nil {
		return fail(fmt.Errorf("invalid url: %w", err))
	}
	if s.token != "" {
		q := target.Query()
		q.Set("token", s.token)
		target.RawQuery = q.Encode()
	}

	var headers http.Header
	if s.origin != "" {
		headers = http.Header{"Origin": {s.origin}}
	}
	conn, resp, err := websocket.DefaultDialer.Dial(target.String(), headers)
	if err != nil {
		if resp != nil {
			body, _ := io.ReadAll(resp.Body)
			return fail(fmt.Errorf("dial: %w (status %s, body %q)", err, resp.Status, body))
		}
		return fail(fmt.Errorf("dial: %w", err))
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))

	if err := send(conn, "hello", map[string]string{"appId": s.app}); err != nil {
		return fail(fmt.Errorf("send hello: %w", err))
	}
	if _, err := readUntil(conn, "ack"); err != nil {
		return fail(fmt.Errorf("await ack: %w", err))
	}

	nonce := fmt.Sprintf("nonce-user-%d-%d", s.globalIdx, time.Now().UnixNano())
	prompt := fmt.Sprintf(
		"Repeat the following token exactly, character for character, and say nothing else: %s",
		nonce,
	)
	if err := send(conn, "prompt", map[string]string{"text": prompt}); err != nil {
		return fail(fmt.Errorf("send prompt: %w", err))
	}

	env, err := readUntil(conn, "assistant_message")
	if err != nil {
		return fail(fmt.Errorf("await assistant_message: %w", err))
	}
	var payload struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		return fail(fmt.Errorf("decode assistant_message: %w", err))
	}
	if !strings.Contains(payload.Text, nonce) {
		return fail(fmt.Errorf("cross-talk: expected nonce %q in response, got %q", nonce, payload.Text))
	}

	return userResult{spec: s, ok: true, elapsed: time.Since(start)}
}

func send(conn *websocket.Conn, msgType string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return conn.WriteJSON(envelope{Type: msgType, Payload: raw})
}

// readUntil reads envelopes until one matching want arrives, an "error"
// envelope arrives (surfaced as a Go error), or the connection's read
// deadline is hit. Messages of any other type are ignored — this session
// only ever expects one in-flight request at a time, but skipping unknowns
// keeps this robust rather than tightly coupled to exact message ordering.
func readUntil(conn *websocket.Conn, want string) (envelope, error) {
	for {
		var env envelope
		if err := conn.ReadJSON(&env); err != nil {
			return envelope{}, err
		}
		if env.Type == "error" {
			var payload struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(env.Payload, &payload)
			return envelope{}, fmt.Errorf("server error: %s", payload.Message)
		}
		if env.Type == want {
			return env, nil
		}
	}
}
