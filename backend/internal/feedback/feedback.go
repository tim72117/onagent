// Package feedback stores the free-text messages the console's feedback
// sheet collects (see apps/console/src/FeedbackSheet.tsx).
//
// Append-only by design: every submission is its own row. That is the
// difference from internal/usecase, which keeps one row per user because a
// use case is a statement of intent someone refines — feedback is not
// refined, it is said, and a later message never supersedes an earlier one.
package feedback

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

// maxMessage is generous enough for a long complaint and small enough that
// the endpoint cannot be used as arbitrary storage. maxCardTitle covers the
// console's own card names with room to spare; it is context, not content.
const (
	maxMessage   = 5000
	maxCardTitle = 120
)

// ErrInvalid wraps rejections caused by the caller — an empty or over-long
// message — so the HTTP layer can answer 400 for those and 500 for an
// infrastructure failure. Without the distinction a database outage gets
// reported to the user as "your input was rejected" while staying invisible
// in the 5xx rate.
var ErrInvalid = errors.New("feedback: invalid submission")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Entry is one stored message, as returned when reading the inbox back.
// AppID and UserID are pointers because both outlive what they reference:
// the row survives its app being deleted and its author's account closing
// (ON DELETE SET NULL — see internal/db/schema.sql).
type Entry struct {
	ID        int64     `json:"id"`
	AppID     *string   `json:"appId"`
	UserID    *int64    `json:"userId"`
	CardTitle string    `json:"cardTitle"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"createdAt"`
}

// feedbackRow is the GORM-mapped shape of the feedback table. Schema lives
// in internal/db/schema.sql, matching every other migrated package; only the
// columns this package reads or writes are declared.
type feedbackRow struct {
	ID        int64     `gorm:"column:id;primaryKey"`
	AppID     *string   `gorm:"column:app_id"`
	UserID    *int64    `gorm:"column:user_id"`
	CardTitle *string   `gorm:"column:card_title"`
	Message   string    `gorm:"column:message"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

func (feedbackRow) TableName() string { return "feedback" }

// Store appends and reads feedback.
type Store struct {
	db *gorm.DB
}

func New(db *gorm.DB) *Store { return &Store{db: db} }

// Submit appends one message. appID and cardTitle are context and may be
// empty; the message itself is the point and may not be.
//
// Counted in runes rather than bytes: len() on a UTF-8 string would cut a
// Traditional Chinese message off at roughly a third of the stated limit and
// then quote a character count the writer can see is wrong.
func (s *Store) Submit(ctx context.Context, appID string, userID int64, cardTitle, message string) error {
	message = strings.TrimSpace(message)
	cardTitle = strings.TrimSpace(cardTitle)

	switch {
	case message == "":
		return invalid("message is required")
	case len([]rune(message)) > maxMessage:
		return invalid("message is longer than %d characters", maxMessage)
	case len([]rune(cardTitle)) > maxCardTitle:
		return invalid("cardTitle is longer than %d characters", maxCardTitle)
	}

	// Empty context is stored as NULL rather than "", keeping "sent from no
	// particular card" distinct from "sent from a card with a blank name".
	row := feedbackRow{Message: message, CreatedAt: time.Now()}
	if appID != "" {
		row.AppID = &appID
	}
	if userID != 0 {
		row.UserID = &userID
	}
	if cardTitle != "" {
		row.CardTitle = &cardTitle
	}

	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return fmt.Errorf("feedback: submit for user %d: %w", userID, err)
	}
	return nil
}

// Recent returns the newest entries first, capped at limit. Intended for an
// operator reading the inbox; there is no per-user scoping here because
// feedback is not something its author reads back.
func (s *Store) Recent(ctx context.Context, limit int) ([]Entry, error) {
	if limit <= 0 {
		limit = 50
	}
	var rows []feedbackRow
	if err := s.db.WithContext(ctx).
		Order("created_at DESC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("feedback: list recent: %w", err)
	}

	out := make([]Entry, 0, len(rows))
	for _, r := range rows {
		e := Entry{
			ID:        r.ID,
			AppID:     r.AppID,
			UserID:    r.UserID,
			Message:   r.Message,
			CreatedAt: r.CreatedAt,
		}
		if r.CardTitle != nil {
			e.CardTitle = *r.CardTitle
		}
		out = append(out, e)
	}
	return out, nil
}
