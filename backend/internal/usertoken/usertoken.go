// Package usertoken implements long-lived bearer tokens that let a
// registered user (internal/session) authenticate to the console API from
// a CLI or script instead of a browser session cookie. Unlike
// internal/auth's one-key-per-app design, a user may hold several tokens
// at once (one per machine/CI context), each independently named and
// revocable — issuing a new one never invalidates the others.
//
// A token only ever proves "this request is user N" — it carries no
// separate authorization of its own. Every /console/* ownership check
// downstream (internal/console's withOwnedApp) applies identically
// whether the caller authenticated via cookie or token.
package usertoken

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// User mirrors session.User's shape (id + email) without importing
// internal/session, so usertoken has no dependency on the cookie-specific
// package — console.go's withAuth is what unifies both into one
// *session.User for downstream handlers.
type User struct {
	ID    int64
	Email string
}

// Token is one issued token's metadata, as returned by List — never
// includes the plaintext, which is shown exactly once at Issue time.
type Token struct {
	ID         int64      `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
}

type Store struct {
	db *sql.DB
}

func New(db *sql.DB) *Store {
	return &Store{db: db}
}

// Issue mints a new token for userID labeled name, persists its hash, and
// returns its id (so the caller can reference it later, e.g. for Revoke,
// without a follow-up List just to look up what Issue already knew) and
// the plaintext. The caller must show the plaintext immediately — it is
// not retrievable afterward, only its hash is ever stored.
func (s *Store) Issue(userID int64, name string) (id int64, plaintext string, err error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return 0, "", fmt.Errorf("usertoken: name is required")
	}

	token, err := randomToken()
	if err != nil {
		return 0, "", fmt.Errorf("usertoken: generate token: %w", err)
	}
	hash := HashToken(token)

	err = s.db.QueryRow(
		`INSERT INTO user_tokens (token_hash, user_id, name) VALUES ($1, $2, $3) RETURNING id`,
		hash, userID, name,
	).Scan(&id)
	if err != nil {
		return 0, "", fmt.Errorf("usertoken: issue: %w", err)
	}

	return id, token, nil
}

// Verify resolves the bearer token in r's Authorization header (if any) to
// the user it was issued to, and best-effort touches last_used_at so List
// can show which tokens are actually in use. ok is false for a missing
// header, a malformed scheme, or an unknown/revoked token.
func (s *Store) Verify(r *http.Request) (user *User, ok bool) {
	token, found := bearerToken(r)
	if !found {
		return nil, false
	}
	hash := HashToken(token)

	var u User
	err := s.db.QueryRow(`
		SELECT users.id, users.email
		  FROM user_tokens
		  JOIN users ON users.id = user_tokens.user_id
		 WHERE user_tokens.token_hash = $1`,
		hash,
	).Scan(&u.ID, &u.Email)
	if err != nil {
		return nil, false
	}

	// Best-effort: a failed touch shouldn't fail the request it's riding
	// along with — last_used_at is a convenience for List, not a
	// correctness-critical value.
	_, _ = s.db.Exec(`UPDATE user_tokens SET last_used_at = now() WHERE token_hash = $1`, hash)

	return &u, true
}

// List returns userID's tokens, most recently created first, without their
// plaintext (unrecoverable) or hash (no reason for a caller to ever see it).
func (s *Store) List(userID int64) ([]Token, error) {
	rows, err := s.db.Query(`
		SELECT id, name, created_at, last_used_at
		  FROM user_tokens
		 WHERE user_id = $1
		 ORDER BY created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("usertoken: list: %w", err)
	}
	defer rows.Close()

	out := []Token{}
	for rows.Next() {
		var t Token
		var lastUsed sql.NullTime
		if err := rows.Scan(&t.ID, &t.Name, &t.CreatedAt, &lastUsed); err != nil {
			return nil, fmt.Errorf("usertoken: scan: %w", err)
		}
		if lastUsed.Valid {
			t.LastUsedAt = &lastUsed.Time
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Revoke deletes userID's token identified by tokenID. Scoped to userID so
// one user can never revoke another's token by guessing an id. Not an
// error if no matching row existed — the caller's desired end state (that
// token no longer works) already holds either way.
func (s *Store) Revoke(userID, tokenID int64) error {
	if _, err := s.db.Exec(
		`DELETE FROM user_tokens WHERE id = $1 AND user_id = $2`, tokenID, userID,
	); err != nil {
		return fmt.Errorf("usertoken: revoke: %w", err)
	}
	return nil
}

// HashToken computes the sha256 hex digest of a plaintext token — what's
// actually stored, in user_tokens.token_hash.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// bearerToken extracts the token from an "Authorization: Bearer <token>"
// header, if present and well-formed.
func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(h, prefix))
	if token == "" {
		return "", false
	}
	return token, true
}

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "atp_" + base64.RawURLEncoding.EncodeToString(buf), nil
}
