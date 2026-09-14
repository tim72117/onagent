// Package usecase stores what a user says they intend to build — the first
// half of the Builder flow (see docs/research-feedback-form-2026-09.md),
// collected by the console's welcome notification form.
//
// Deliberately its own package rather than a few methods on internal/quota:
// this is product research, not entitlement. Nothing here gates access or
// feeds a quota decision, and keeping it separate means a change to how
// answers are collected can never accidentally alter what someone is
// allowed to do.
package usecase

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Maximum accepted lengths. Generous enough that no honest answer is ever
// truncated, small enough that the endpoint can't be used to store
// arbitrary data — these are two sentences and a label, not documents.
const (
	maxDomain = 120
	maxGoal   = 2000
	maxToday  = 2000
)

// ErrInvalid wraps every rejection that is the CALLER's fault — a missing or
// over-long field — so the HTTP layer can answer 400 for those and 500 for
// an infrastructure failure. Without this the two are indistinguishable at
// the call site, and a database outage gets reported to the user as "your
// input was rejected" while never appearing in the 5xx rate.
var ErrInvalid = errors.New("usecase: invalid response")

// invalid builds an ErrInvalid-wrapped error with a message safe to show a
// caller: it names the field and the rule, never anything internal.
func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Response is one user's answers. Stored one row per user (see
// internal/db/schema.sql): re-submitting replaces, rather than appending a
// new draft nobody would reconcile.
type Response struct {
	Domain string `json:"domain"`
	Goal   string `json:"goal"`
	// HandledToday is optional — the question benefits us, not the person
	// answering, so the form marks it optional and an empty string is a
	// valid, complete response.
	HandledToday string    `json:"handledToday"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// responseRow is the GORM-mapped shape of use_case_responses, matching the
// convention of every other migrated package: the schema itself lives in
// internal/db/schema.sql, and only the columns this package reads or writes
// are declared here.
type responseRow struct {
	UserID       int64     `gorm:"column:user_id;primaryKey"`
	Domain       string    `gorm:"column:domain"`
	Goal         string    `gorm:"column:goal"`
	HandledToday *string   `gorm:"column:handled_today"`
	UpdatedAt    time.Time `gorm:"column:updated_at"`
}

func (responseRow) TableName() string { return "use_case_responses" }

// Store reads and writes use-case responses. A nil *Store is NOT valid here
// (unlike quota.Service): there is no meaningful "disabled" behaviour for a
// form that either saves or doesn't, and silently discarding an answer
// someone took the time to write would be worse than failing loudly.
type Store struct {
	db *gorm.DB
}

func New(db *gorm.DB) *Store { return &Store{db: db} }

// Save records userID's answers, replacing any previous submission.
//
// Validation is deliberately strict about the two required fields and
// lenient about everything else: domain and goal are what the whole form
// exists to learn, so an empty one is a bug in the caller rather than a
// user with nothing to say. Whitespace-only counts as empty — the console
// disables its own submit button on the same rule, so anything reaching
// here with blanks arrived by another route.
func (s *Store) Save(ctx context.Context, userID int64, r Response) error {
	domain := strings.TrimSpace(r.Domain)
	goal := strings.TrimSpace(r.Goal)
	today := strings.TrimSpace(r.HandledToday)

	// Counted in runes, not bytes: len() on a UTF-8 string would cut a
	// Traditional Chinese answer off at about a third of the stated limit
	// and then report a character count the user can see is wrong.
	switch {
	case domain == "":
		return invalid("domain is required")
	case goal == "":
		return invalid("goal is required")
	case utf8.RuneCountInString(domain) > maxDomain:
		return invalid("domain is longer than %d characters", maxDomain)
	case utf8.RuneCountInString(goal) > maxGoal:
		return invalid("goal is longer than %d characters", maxGoal)
	case utf8.RuneCountInString(today) > maxToday:
		return invalid("handledToday is longer than %d characters", maxToday)
	}

	// NULL rather than "" for the optional answer, so "skipped" and
	// "answered with nothing" stay distinguishable in the data.
	var todayVal *string
	if today != "" {
		todayVal = &today
	}

	// Upsert on the user's own primary key. created_at keeps its original
	// value (it is not in DoUpdates), so a refined answer still records when
	// that user first told us anything.
	err := s.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"domain", "goal", "handled_today", "updated_at"}),
		}).
		Create(&responseRow{
			UserID:       userID,
			Domain:       domain,
			Goal:         goal,
			HandledToday: todayVal,
			UpdatedAt:    time.Now(),
		}).Error
	if err != nil {
		return fmt.Errorf("usecase: save response for user %d: %w", userID, err)
	}
	return nil
}

// Get returns userID's answers, with ok=false when they have not answered.
// Used by the console to decide whether the welcome notification still has
// anything to ask for.
func (s *Store) Get(ctx context.Context, userID int64) (Response, bool, error) {
	var row responseRow
	err := s.db.WithContext(ctx).Where("user_id = ?", userID).Take(&row).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return Response{}, false, nil
		}
		return Response{}, false, fmt.Errorf("usecase: get response for user %d: %w", userID, err)
	}
	var today string
	if row.HandledToday != nil {
		today = *row.HandledToday
	}
	return Response{
		Domain:       row.Domain,
		Goal:         row.Goal,
		HandledToday: today,
		UpdatedAt:    row.UpdatedAt,
	}, true, nil
}
