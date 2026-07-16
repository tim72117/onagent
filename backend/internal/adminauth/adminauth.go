// Package adminauth is the identity layer for the admin back-office
// (apps/admin, mounted at /admin). It is deliberately a SEPARATE system
// from internal/session: separate table (admin_users), separate session
// table (admin_sessions), separate cookie (admin_session). An admin is not
// a users row with a role flag — so no flaw in the public users/session
// flow can escalate into admin access, and holding a developer session
// grants nothing here.
//
// The mechanics (bcrypt, DB-backed opaque session ids, httpOnly+Secure
// cookies, SameSite chosen to match the deployment) mirror internal/session
// on purpose: same hardening, different identity domain. The one thing this
// package adds that session does not is Bootstrap — there is no
// self-service admin signup, so the first admin is seeded from the
// environment at startup instead.
package adminauth

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// CookieName is the admin session cookie. Distinct from
// session.CookieName ("onagent_session") so the developer and admin session
// systems never collide in the same browser.
const CookieName = "admin_session"

const sessionTTL = 12 * time.Hour // shorter than the developer session: admin access is higher-privilege, so re-auth sooner

var emailRE = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// ErrInvalidCredentials is returned for both an unknown email and a wrong
// password, without distinguishing them (same rationale as session's).
var ErrInvalidCredentials = errors.New("invalid admin credentials")

// Admin is an authenticated admin identity.
type Admin struct {
	ID    int64
	Email string
}

// Store is the admin identity/session store, backed by the same *sql.DB as
// everything else but operating only on the admin_* tables.
type Store struct {
	db *sql.DB
	// Secure controls the session cookie's Secure attribute; true in any
	// real (HTTPS) deployment, false only for plain-HTTP local dev. Mirrors
	// session.Store.Secure.
	Secure bool
}

func New(db *sql.DB, secure bool) *Store {
	return &Store{db: db, Secure: secure}
}

// Bootstrap ensures an admin with the given email exists, creating it with
// the given password if not. It is the ONLY way the first admin comes into
// being — there is no registration endpoint — so the trust root is the
// deployment environment (whoever can set ADMIN_BOOTSTRAP_* env vars), never
// an API caller. Idempotent and safe to run on every startup: if the email
// already exists, it is left untouched (the password is NOT reset, so a
// later password change through normal means is not clobbered on restart).
//
// Returns whether it created a new admin, for logging. A blank email or
// password is treated as "no bootstrap configured" and returns (false, nil)
// without touching the database.
func (s *Store) Bootstrap(email, password string) (created bool, err error) {
	email = strings.TrimSpace(email)
	if email == "" || password == "" {
		return false, nil
	}
	if !emailRE.MatchString(email) {
		return false, fmt.Errorf("adminauth: bootstrap email is not a valid address")
	}
	if len(password) < 8 {
		return false, fmt.Errorf("adminauth: bootstrap password must be at least 8 characters")
	}

	var existing int64
	err = s.db.QueryRow(`SELECT id FROM admin_users WHERE lower(email) = lower($1)`, email).Scan(&existing)
	if err == nil {
		return false, nil // already present — leave it alone
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("adminauth: check existing admin: %w", err)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return false, fmt.Errorf("adminauth: hash bootstrap password: %w", err)
	}
	// ON CONFLICT guards the race where two instances bootstrap at once
	// (unique index on lower(email)); the loser just no-ops.
	res, err := s.db.Exec(
		`INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)
		 ON CONFLICT (lower(email)) DO NOTHING`,
		email, string(hash),
	)
	if err != nil {
		return false, fmt.Errorf("adminauth: insert bootstrap admin: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Login verifies an admin's email/password. ErrInvalidCredentials covers
// both a nonexistent email and a wrong password.
func (s *Store) Login(email, password string) (*Admin, error) {
	var (
		id   int64
		hash string
	)
	err := s.db.QueryRow(
		`SELECT id, password_hash FROM admin_users WHERE lower(email) = lower($1)`, email,
	).Scan(&id, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, fmt.Errorf("adminauth: query admin: %w", err)
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return nil, ErrInvalidCredentials
	}
	return &Admin{ID: id, Email: email}, nil
}

// CreateSession mints an admin session for adminID and sets its cookie on w.
func (s *Store) CreateSession(w http.ResponseWriter, adminID int64) (string, error) {
	id, err := randomID()
	if err != nil {
		return "", fmt.Errorf("adminauth: generate id: %w", err)
	}
	expiresAt := time.Now().Add(sessionTTL)

	if _, err := s.db.Exec(
		`INSERT INTO admin_sessions (id, admin_user_id, expires_at) VALUES ($1, $2, $3)`,
		id, adminID, expiresAt,
	); err != nil {
		return "", fmt.Errorf("adminauth: insert session: %w", err)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    id,
		Path:     "/",
		Expires:  expiresAt,
		HttpOnly: true,
		Secure:   s.Secure,
		SameSite: sameSite(s.Secure),
	})
	return id, nil
}

// Verify resolves the admin session cookie on r to its admin. ok is false
// for a missing cookie, an unknown/expired session, or a vanished admin.
func (s *Store) Verify(r *http.Request) (admin *Admin, ok bool) {
	cookie, err := r.Cookie(CookieName)
	if err != nil {
		return nil, false
	}
	var (
		id    int64
		email string
	)
	err = s.db.QueryRow(`
		SELECT admin_users.id, admin_users.email
		  FROM admin_sessions
		  JOIN admin_users ON admin_users.id = admin_sessions.admin_user_id
		 WHERE admin_sessions.id = $1 AND admin_sessions.expires_at > now()`,
		cookie.Value,
	).Scan(&id, &email)
	if err != nil {
		return nil, false
	}
	return &Admin{ID: id, Email: email}, true
}

// Logout deletes the admin session named by r's cookie and clears it on w.
func (s *Store) Logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(CookieName); err == nil {
		_, _ = s.db.Exec(`DELETE FROM admin_sessions WHERE id = $1`, cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.Secure,
		SameSite: sameSite(s.Secure),
	})
}

// Count returns how many admins exist. Used at startup for a log line.
func (s *Store) Count() int {
	var n int
	_ = s.db.QueryRow(`SELECT count(*) FROM admin_users`).Scan(&n)
	return n
}

// sameSite mirrors session.sameSite: None (requires Secure) for real HTTPS
// deployments where the admin SPA and backend may be cross-site; Lax for
// plain-HTTP local dev, which browsers still send on same-site fetches.
func sameSite(secure bool) http.SameSite {
	if secure {
		return http.SameSiteNoneMode
	}
	return http.SameSiteLaxMode
}

func randomID() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
