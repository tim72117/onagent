// Package cliauth backs the browser-redirect CLI login flow (onagent login
// --web): the CLI registers its local callback intent server-side first
// and gets back an opaque, single-use session id — that id is the only
// thing that ever needs to appear in a URL from then on. The actual
// redirect target is never re-derived from anything a browser page's own
// URL carries, which is what makes a malicious link unable to redirect a
// freshly minted token anywhere: an attacker has no way to get their own
// redirect_uri associated with a session id, since that association only
// ever happens server-side, in response to the CLI's own Start call.
package cliauth

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const ttl = 10 * time.Minute

// loopbackRedirectRE matches only http://localhost:<port>/... or
// http://127.0.0.1:<port>/... — the only redirect targets a CLI's own
// local server can plausibly be. Enforced here, server-side, at Start
// time — see the package doc for why this beats re-validating a
// client-supplied value from the page's own URL later.
var loopbackRedirectRE = regexp.MustCompile(`^http://(localhost|127\.0\.0\.1):\d+/`)

type Store struct {
	db *sql.DB
}

func New(db *sql.DB) *Store {
	return &Store{db: db}
}

// Start registers a new pending session for redirectURI (rejected unless
// it's a loopback address) and returns its opaque id.
func (s *Store) Start(redirectURI, name string) (id string, err error) {
	if !loopbackRedirectRE.MatchString(redirectURI) {
		return "", fmt.Errorf("cliauth: redirect_uri must be a loopback address (http://localhost:<port>/... or http://127.0.0.1:<port>/...)")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "browser login"
	}

	id, err = randomID()
	if err != nil {
		return "", fmt.Errorf("cliauth: generate id: %w", err)
	}

	if _, err := s.db.Exec(
		`INSERT INTO cli_auth_sessions (id, redirect_uri, name, expires_at) VALUES ($1, $2, $3, $4)`,
		id, redirectURI, name, time.Now().Add(ttl),
	); err != nil {
		return "", fmt.Errorf("cliauth: start: %w", err)
	}
	return id, nil
}

// NameFor returns id's display name (e.g. for a "the {name} CLI wants to
// sign in" consent screen, or as the label passed to usertoken.Issue on
// approval) — ok is false if id is unknown or its session has expired.
func (s *Store) NameFor(id string) (name string, ok bool) {
	err := s.db.QueryRow(
		`SELECT name FROM cli_auth_sessions WHERE id = $1 AND expires_at > now()`, id,
	).Scan(&name)
	return name, err == nil
}

// Approve records token (already minted by the caller via usertoken.Issue
// — this package has no dependency on that one, console.go orchestrates
// both) against id and returns the redirect_uri to send the browser to.
// ok is false if id is unknown, expired, or already approved — approving
// twice would let a second tab re-collect a token for a session the user
// already completed, which has no legitimate use.
func (s *Store) Approve(id, token string) (redirectURI string, ok bool) {
	res, err := s.db.Exec(
		`UPDATE cli_auth_sessions SET token = $1, approved = true
		  WHERE id = $2 AND expires_at > now() AND approved = false`,
		token, id,
	)
	if err != nil {
		return "", false
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", false
	}

	err = s.db.QueryRow(`SELECT redirect_uri FROM cli_auth_sessions WHERE id = $1`, id).Scan(&redirectURI)
	return redirectURI, err == nil
}

// Exchange collects id's approved token — the CLI's local callback server
// calls this once, right after the browser redirects back to it with id
// in hand. Clearing the token column on success makes this single-use: a
// replayed or duplicated callback finds nothing left to collect. ok is
// false if id is unknown, not yet approved, or already collected.
func (s *Store) Exchange(id string) (token string, ok bool) {
	err := s.db.QueryRow(
		`SELECT token FROM cli_auth_sessions WHERE id = $1 AND approved = true AND token IS NOT NULL`, id,
	).Scan(&token)
	if err != nil {
		return "", false
	}

	_, _ = s.db.Exec(`UPDATE cli_auth_sessions SET token = NULL WHERE id = $1`, id)
	return token, true
}

func randomID() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
