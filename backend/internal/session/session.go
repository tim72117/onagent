// Package session implements email/password accounts and database-backed
// login sessions for the console API (internal/console), replacing the
// earlier single shared ADMIN_TOKEN. Every app now belongs to exactly one
// user (apps.owner_id); internal/console is responsible for checking that
// ownership on every request, this package only answers "who is making
// this request, if anyone."
package session

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/lib/pq"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/tim72117/onagent/internal/quota"
)

// CookieName is the cookie the console API's session id travels in. httpOnly
// so page JavaScript can't read it (XSS can't exfiltrate the session even
// if it can run arbitrary code), Secure in production (see Store.Secure).
const CookieName = "onagent_session"

const sessionTTL = 30 * 24 * time.Hour

var emailRE = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// ErrInvalidCredentials covers both "no such user" and "wrong password"
// without distinguishing them in the response — telling a caller which one
// failed lets them enumerate registered emails.
var ErrInvalidCredentials = errors.New("invalid email or password")

// ErrEmailTaken is returned by Register when the email is already in use
// (case-insensitively — see the schema's users_email_lower_idx).
var ErrEmailTaken = errors.New("an account with this email already exists")

// User is the caller-facing shape of an authenticated account. Never
// includes the password hash.
type User struct {
	ID    int64
	Email string
}

// userRow/sessionRow/subscriptionRow are the GORM-mapped shapes of their
// respective tables (see internal/db/schema.sql for the authoritative
// column definitions — schema management stays there, not AutoMigrate).
type userRow struct {
	ID           int64  `gorm:"column:id;primaryKey"`
	Email        string `gorm:"column:email"`
	PasswordHash string `gorm:"column:password_hash"`
}

func (userRow) TableName() string { return "users" }

type sessionRow struct {
	ID        string    `gorm:"column:id;primaryKey"`
	UserID    int64     `gorm:"column:user_id"`
	ExpiresAt time.Time `gorm:"column:expires_at"`
}

func (sessionRow) TableName() string { return "sessions" }

type subscriptionRow struct {
	UserID int64  `gorm:"column:user_id;primaryKey"`
	Tier   string `gorm:"column:tier"`
}

func (subscriptionRow) TableName() string { return "subscriptions" }


// Store implements registration, login, and session verification against
// the users/sessions tables (internal/db/schema.sql).
type Store struct {
	db *gorm.DB
	// Secure controls the cookie's Secure attribute. true in any real
	// deployment (HTTPS-only cookie); false only for http://localhost dev,
	// where the browser would otherwise silently refuse to store it.
	Secure bool
}

func New(db *gorm.DB, secure bool) *Store {
	return &Store{db: db, Secure: secure}
}

// Register creates a new account. Fails with ErrEmailTaken if the email
// (case-insensitively) is already registered, or a validation error for a
// malformed email / too-short password.
func (s *Store) Register(email, password string) (*User, error) {
	email = strings.TrimSpace(email)
	if !emailRE.MatchString(email) {
		return nil, fmt.Errorf("invalid email address")
	}
	if len(password) < 8 {
		return nil, fmt.Errorf("password must be at least 8 characters")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("session: hash password: %w", err)
	}

	// The user row and its free-tier subscription row are created together
	// in one transaction: a signup that left a user without a subscription
	// row would still work (internal/quota treats a missing row as the free
	// tier), but writing it here keeps subscriptions 1:1 with users on the
	// happy path and gives billing a row to later UPDATE in place. All-or-
	// nothing avoids a half-created account if the second insert fails.
	var id int64
	err = s.db.Transaction(func(tx *gorm.DB) error {
		u := userRow{Email: email, PasswordHash: string(hash)}
		if err := tx.Create(&u).Error; err != nil {
			// internal/db.Open configures GORM's postgres driver to reuse
			// the *sql.DB opened via lib/pq (see that file's comment), so
			// errors surfacing here are still *pq.Error, not pgx's
			// pgconn.PgError — GORM's own driver choice doesn't change what
			// actually executes the query underneath database/sql.
			var pqErr *pq.Error
			if errors.As(err, &pqErr) && pqErr.Code == "23505" { // unique_violation
				return ErrEmailTaken
			}
			return fmt.Errorf("session: insert user: %w", err)
		}
		id = u.ID

		// Start every account on the default tier. The actual allowance is
		// NOT stored on the row — internal/quota derives it from the tier's
		// plan at check time (quota.PlanFor), so a plan's number can change
		// without touching existing rows. monthly_quota is left NULL: it's
		// an optional per-user override, not the source of the limit.
		// started_at and tier both have schema defaults, but tier is set
		// explicitly here so the account's plan is unambiguous from the row
		// itself.
		if err := tx.Create(&subscriptionRow{UserID: id, Tier: string(quota.DefaultTier)}).Error; err != nil {
			return fmt.Errorf("session: insert subscription: %w", err)
		}
		return nil
	})
	if err != nil {
		if errors.Is(err, ErrEmailTaken) {
			return nil, ErrEmailTaken
		}
		return nil, err
	}

	return &User{ID: id, Email: email}, nil
}

// Login verifies email/password and returns the matching user.
// ErrInvalidCredentials covers both a nonexistent email and a wrong
// password — see that error's doc comment for why.
func (s *Store) Login(email, password string) (*User, error) {
	var row userRow
	err := s.db.Where("lower(email) = lower(?)", email).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrInvalidCredentials
	}
	if err != nil {
		return nil, fmt.Errorf("session: query user: %w", err)
	}

	if bcrypt.CompareHashAndPassword([]byte(row.PasswordHash), []byte(password)) != nil {
		return nil, ErrInvalidCredentials
	}

	return &User{ID: row.ID, Email: email}, nil
}

// CreateSession mints a new session for userID and sets its cookie on w.
// Returns the raw session id (rarely needed by callers beyond tests — the
// cookie is what actually carries it to the browser).
func (s *Store) CreateSession(w http.ResponseWriter, userID int64) (string, error) {
	id, err := randomID()
	if err != nil {
		return "", fmt.Errorf("session: generate id: %w", err)
	}
	expiresAt := time.Now().Add(sessionTTL)

	if err := s.db.Create(&sessionRow{ID: id, UserID: userID, ExpiresAt: expiresAt}).Error; err != nil {
		return "", fmt.Errorf("session: insert: %w", err)
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

// Verify resolves the session cookie on r, if any, to its user. ok is false
// for a missing cookie, an unknown/expired session, or a user that no
// longer exists (shouldn't happen given ON DELETE CASCADE, but Verify
// doesn't assume it).
func (s *Store) Verify(r *http.Request) (user *User, ok bool) {
	cookie, err := r.Cookie(CookieName)
	if err != nil {
		return nil, false
	}

	var row userRow
	res := s.db.
		Table("sessions").
		Select("users.id, users.email").
		Joins("JOIN users ON users.id = sessions.user_id").
		Where("sessions.id = ? AND sessions.expires_at > ?", cookie.Value, time.Now()).
		Scan(&row)
	if res.Error != nil || res.RowsAffected == 0 {
		return nil, false
	}

	return &User{ID: row.ID, Email: row.Email}, true
}

// Logout deletes the session named by r's cookie (if any) and clears the
// cookie on w. Not an error if there was no session — logging out twice is
// a no-op, not a failure.
func (s *Store) Logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(CookieName); err == nil {
		s.db.Where("id = ?", cookie.Value).Delete(&sessionRow{})
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

// sameSite picks the cookie's SameSite attribute to match what the browser
// will actually accept. SameSite=None requires Secure — browsers silently
// drop a None cookie set without it (a real bug this project hit: the
// cookie from CreateSession was never stored in http://localhost dev,
// so every request looked unauthenticated one round trip later even though
// login itself reported success). Secure=true deployments use None because
// the console origin and the backend origin differ (e.g. a dashboard
// domain calling an api. subdomain) and the fetch is cross-site from the
// cookie's perspective. Secure=false (plain-HTTP local dev) falls back to
// Lax, which browsers do send on the same-site fetches this SPA makes to
// localhost even across different ports.
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
