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
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"

	"gorm.io/gorm"
)

const ttl = 10 * time.Minute

// loopbackRedirectRE matches only http://localhost:<port>/... or
// http://127.0.0.1:<port>/... — the only redirect targets a CLI's own
// local server can plausibly be. Enforced here, server-side, at Start
// time — see the package doc for why this beats re-validating a
// client-supplied value from the page's own URL later.
var loopbackRedirectRE = regexp.MustCompile(`^http://(localhost|127\.0\.0\.1):\d+/`)

// cliAuthSessionRow is the GORM-mapped shape of the cli_auth_sessions table
// (see internal/db/schema.sql for the authoritative column definitions —
// schema management stays there, not AutoMigrate).
type cliAuthSessionRow struct {
	ID          string    `gorm:"column:id;primaryKey"`
	RedirectURI string    `gorm:"column:redirect_uri"`
	Name        string    `gorm:"column:name"`
	Token       *string   `gorm:"column:token"`
	Approved    bool      `gorm:"column:approved"`
	ExpiresAt   time.Time `gorm:"column:expires_at"`
}

func (cliAuthSessionRow) TableName() string { return "cli_auth_sessions" }


type Store struct {
	db *gorm.DB
}

func New(db *gorm.DB) *Store {
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

	row := cliAuthSessionRow{ID: id, RedirectURI: redirectURI, Name: name, ExpiresAt: time.Now().Add(ttl)}
	if err := s.db.Create(&row).Error; err != nil {
		return "", fmt.Errorf("cliauth: start: %w", err)
	}
	return id, nil
}

// NameFor returns id's display name (e.g. for a "the {name} CLI wants to
// sign in" consent screen, or as the label passed to usertoken.Issue on
// approval) — ok is false if id is unknown or its session has expired.
func (s *Store) NameFor(id string) (name string, ok bool) {
	var row cliAuthSessionRow
	err := s.db.
		Select("name").
		Where("id = ? AND expires_at > ?", id, time.Now()).
		First(&row).Error
	return row.Name, err == nil
}

// Approve records token (already minted by the caller via usertoken.Issue
// — this package has no dependency on that one, console.go orchestrates
// both) against id and returns the redirect_uri to send the browser to.
// ok is false if id is unknown, expired, or already approved — approving
// twice would let a second tab re-collect a token for a session the user
// already completed, which has no legitimate use.
func (s *Store) Approve(id, token string) (redirectURI string, ok bool) {
	// Conditional UPDATE + RowsAffected is the single-use guarantee here —
	// this MUST stay a WHERE-scoped Updates(), never rewritten as a
	// First()-then-Save(). A read-then-write pair would leave a TOCTOU
	// window where two concurrent Approve calls could both read
	// approved=false before either writes, letting a session be approved
	// twice. The conditional UPDATE lets Postgres's own row lock serialize
	// concurrent attempts instead.
	res := s.db.Model(&cliAuthSessionRow{}).
		Where("id = ? AND expires_at > ? AND approved = ?", id, time.Now(), false).
		Updates(map[string]any{"token": token, "approved": true})
	if res.Error != nil || res.RowsAffected == 0 {
		return "", false
	}

	var row cliAuthSessionRow
	err := s.db.Select("redirect_uri").Where("id = ?", id).First(&row).Error
	return row.RedirectURI, err == nil
}

// Exchange collects id's approved token — the CLI's local callback server
// calls this once, right after the browser redirects back to it with id
// in hand. Clearing the token column on success makes this single-use: a
// replayed or duplicated callback finds nothing left to collect. ok is
// false if id is unknown, not yet approved, or already collected.
func (s *Store) Exchange(id string) (token string, ok bool) {
	var row cliAuthSessionRow
	err := s.db.
		Select("token").
		Where("id = ? AND approved = ? AND token IS NOT NULL", id, true).
		First(&row).Error
	if err != nil || row.Token == nil {
		return "", false
	}
	token = *row.Token

	// Best-effort: the token was already read above, so a failure here
	// doesn't invalidate this call's result — same as the pre-GORM version,
	// error deliberately discarded. This clears the column so a replayed or
	// duplicated callback finds nothing left to collect.
	_ = s.db.Model(&cliAuthSessionRow{}).Where("id = ?", id).Update("token", nil).Error
	return token, true
}

func randomID() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
