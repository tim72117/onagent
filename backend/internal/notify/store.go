package notify

import (
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// notificationRow is the GORM-mapped shape of the notifications table (see
// db/schema.sql). A separate struct from this package's own Notification
// (which Rule/PairRule.Build return) rather than reusing one type for
// both: Notification is the rule-authoring shape (no id, no timestamps —
// a rule has no business assigning those), notificationRow is the
// persisted shape (adds what only the database decides). Converting
// between them happens once, in GormNotificationStore.Insert.
type notificationRow struct {
	ID           int64      `gorm:"column:id;primaryKey"`
	SubjectID    string     `gorm:"column:subject_id"`
	RuleName     string     `gorm:"column:rule_name"`
	Title        string     `gorm:"column:title"`
	Body         string     `gorm:"column:body"`
	ActionLabel  *string    `gorm:"column:action_label"`
	ActionTarget *string    `gorm:"column:action_target"`
	Status       string     `gorm:"column:status"`
	CreatedAt    time.Time  `gorm:"column:created_at"`
	ReadAt       *time.Time `gorm:"column:read_at"`
	CompletedAt  *time.Time `gorm:"column:completed_at"`
}

func (notificationRow) TableName() string { return "notifications" }

// GormNotificationStore is the Postgres-backed NotificationStore Engine
// writes through in production (see cmd/server/main.go). A thin wrapper
// around one INSERT — kept this small deliberately, since the interesting
// logic (which rule fired, what the wording is) already happened by the
// time Insert is called; this method's only job is turning that decision
// into a durable row.
type GormNotificationStore struct {
	db *gorm.DB
}

func NewGormNotificationStore(db *gorm.DB) *GormNotificationStore {
	return &GormNotificationStore{db: db}
}

func (s *GormNotificationStore) Insert(n Notification) error {
	row := notificationRow{
		SubjectID: n.SubjectID,
		RuleName:  n.RuleName,
		Title:     n.Title,
		Body:      n.Body,
		Status:    "pending",
	}
	if n.ActionLabel != "" {
		row.ActionLabel = &n.ActionLabel
	}
	if n.ActionTarget != "" {
		row.ActionTarget = &n.ActionTarget
	}
	if err := s.db.Create(&row).Error; err != nil {
		return fmt.Errorf("notify: insert notification for rule %s: %w", n.RuleName, err)
	}
	return nil
}

// Record is one persisted notification, read back for display — the
// console's read side (console.go's listNotifications handler) converts
// this straight into its own JSON response shape. Distinct from
// Notification (the rule-authoring shape passed to Insert): Record adds
// everything only the database decides (ID, CreatedAt, the mutable
// ReadAt/CompletedAt/Status) that a rule has no business setting itself.
type Record struct {
	ID           int64
	SubjectID    string
	Title        string
	Body         string
	ActionLabel  string // "" means no suggested next step
	ActionTarget string // "" means no suggested next step
	Status       string // "pending" | "completed" | "dismissed"
	CreatedAt    time.Time
	ReadAt       *time.Time
	CompletedAt  *time.Time
}

func (r notificationRow) toRecord() Record {
	rec := Record{
		ID:          r.ID,
		SubjectID:   r.SubjectID,
		Title:       r.Title,
		Body:        r.Body,
		Status:      r.Status,
		CreatedAt:   r.CreatedAt,
		ReadAt:      r.ReadAt,
		CompletedAt: r.CompletedAt,
	}
	if r.ActionLabel != nil {
		rec.ActionLabel = *r.ActionLabel
	}
	if r.ActionTarget != nil {
		rec.ActionTarget = *r.ActionTarget
	}
	return rec
}

// ListForSubjects returns every notification whose SubjectID is one of
// subjectIDs, newest first — the "all the apps this user owns" query
// console.go's listNotifications handler needs, rather than one call per
// app: a user who owns several apps sees one combined notification list,
// not one per app to check separately. An empty subjectIDs returns an
// empty slice, not every row in the table — GORM's Where with an empty
// IN-list already does the right thing here (matches nothing), but this
// is called out because a caller passing an empty owned-apps list by
// mistake must never see every OTHER user's notifications instead.
func (s *GormNotificationStore) ListForSubjects(subjectIDs []string) ([]Record, error) {
	if len(subjectIDs) == 0 {
		return nil, nil
	}
	var rows []notificationRow
	if err := s.db.Where("subject_id IN ?", subjectIDs).Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("notify: list notifications: %w", err)
	}
	out := make([]Record, len(rows))
	for i, row := range rows {
		out[i] = row.toRecord()
	}
	return out, nil
}

// HasRuleFired reports whether any of ruleNames has ever produced a
// notification for any of subjectIDs — the "has this user already gotten
// a welcome-style notice, under any of their apps" check notify's
// catch_up_welcome Rule needs (see cmd/server/main.go), since that rule
// has no per-subject rule_progress row of its own to check the way a
// PairRule would (it's a stateless single-event Rule; the notifications
// table itself is the only record of whether it already fired). Accepts
// multiple rule names specifically so catch_up_welcome can check for
// EITHER "welcome" (the normal first-app path) OR its own past firing
// ("catch_up_welcome") in one call — checking only "welcome" would let it
// re-fire itself on every subsequent session.started for a user it
// already caught up, since its own notification is filed under a
// different rule_name. Status is deliberately not filtered on — a
// dismissed or completed notification still counts as "already sent," so
// dismissing it must never cause it to be sent again.
func (s *GormNotificationStore) HasRuleFired(subjectIDs []string, ruleNames ...string) (bool, error) {
	if len(subjectIDs) == 0 || len(ruleNames) == 0 {
		return false, nil
	}
	var count int64
	if err := s.db.Model(&notificationRow{}).
		Where("subject_id IN ? AND rule_name IN ?", subjectIDs, ruleNames).
		Count(&count).Error; err != nil {
		return false, fmt.Errorf("notify: check rules %v fired: %w", ruleNames, err)
	}
	return count > 0, nil
}

// UpdateStatus transitions notification id to status ("completed" or
// "dismissed" — see db/schema.sql's own comment on why these, plus
// "pending", are independent facts rather than one collapsed boolean),
// stamping the matching timestamp column (completed_at/read_at) alongside
// it. Scoped to subjectIDs so a caller can only update a notification that
// actually belongs to one of the apps they own — the same "can't touch
// what you don't own" boundary withOwnedApp enforces elsewhere in this
// codebase, applied here since a notification id alone carries no
// ownership check of its own. Marking read is a separate concern from
// status (see Record's own doc comment on the three independent facts) —
// dismissing or completing a still-unread notification also stamps
// read_at, since a status transition that only happens by the user
// interacting with the row necessarily means they've seen it.
func (s *GormNotificationStore) UpdateStatus(id int64, subjectIDs []string, status string) error {
	if status != "completed" && status != "dismissed" {
		return fmt.Errorf("notify: UpdateStatus: status must be \"completed\" or \"dismissed\", got %q", status)
	}
	if len(subjectIDs) == 0 {
		return fmt.Errorf("notify: no such notification %d", id)
	}

	now := time.Now()
	var completedAt any
	if status == "completed" {
		completedAt = now
	}

	res := s.db.Model(&notificationRow{}).
		Where("id = ? AND subject_id IN ?", id, subjectIDs).
		// Coalesce so an already-read notification keeps its original
		// read_at (the moment it was first seen), not the moment it
		// happened to also transition status.
		Updates(map[string]any{
			"status":       status,
			"read_at":      gorm.Expr("COALESCE(read_at, ?)", now),
			"completed_at": completedAt,
		})
	if res.Error != nil {
		return fmt.Errorf("notify: update notification %d status: %w", id, res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("notify: no such notification %d", id)
	}
	return nil
}

// CompleteByActionTarget implements the write side of
// Action.CompleteNotifications — see that type's own doc comment for why
// this matches on ActionTarget (a step name) rather than a specific
// notification id. Deliberately WHERE status = 'pending': a notification
// someone already dismissed must not be silently resurrected as
// 'completed' just because the same step got done through another path,
// and one already 'completed' has nothing left to do here either — this
// only ever moves 'pending' forward, never any other transition.
// Zero matching rows (nobody had a pending notification for this target)
// is not an error — most callers of this action won't have one every
// time it fires (e.g. a returning Builder user who already dealt with
// their welcome notification submits the form again for some other
// reason), so this returns nil rather than requiring the caller to
// distinguish "nothing to do" from a real failure.
func (s *GormNotificationStore) CompleteByActionTarget(subjectIDs []string, target string) error {
	if len(subjectIDs) == 0 || target == "" {
		return nil
	}
	now := time.Now()
	if err := s.db.Model(&notificationRow{}).
		Where("subject_id IN ? AND action_target = ? AND status = ?", subjectIDs, target, "pending").
		Updates(map[string]any{
			"status":       "completed",
			"completed_at": now,
			"read_at":      gorm.Expr("COALESCE(read_at, ?)", now),
		}).Error; err != nil {
		return fmt.Errorf("notify: complete notifications for action target %s: %w", target, err)
	}
	return nil
}

// MarkRead stamps read_at (if not already set) without changing status —
// the "the user opened the notifications view and saw this" signal,
// distinct from acting on it (UpdateStatus). Scoped to subjectIDs for the
// same ownership reason UpdateStatus is.
func (s *GormNotificationStore) MarkRead(id int64, subjectIDs []string) error {
	if len(subjectIDs) == 0 {
		return fmt.Errorf("notify: no such notification %d", id)
	}
	res := s.db.Model(&notificationRow{}).
		Where("id = ? AND subject_id IN ? AND read_at IS NULL", id, subjectIDs).
		Update("read_at", time.Now())
	if res.Error != nil {
		return fmt.Errorf("notify: mark notification %d read: %w", id, res.Error)
	}
	return nil
}

// ruleProgressRow is the GORM-mapped shape of the rule_progress table (see
// db/schema.sql's own comment on why PairRule's state has to be a table,
// not an in-memory map).
type ruleProgressRow struct {
	SubjectID  string     `gorm:"column:subject_id;primaryKey"`
	RuleName   string     `gorm:"column:rule_name;primaryKey"`
	ADoneAt    *time.Time `gorm:"column:a_done_at"`
	BDoneAt    *time.Time `gorm:"column:b_done_at"`
	NotifiedAt *time.Time `gorm:"column:notified_at"`
}

func (ruleProgressRow) TableName() string { return "rule_progress" }

// GormProgressStore is the Postgres-backed ProgressStore Engine writes
// through in production. See MarkDone for how it guarantees "completed
// exactly once" under a race between side A and side B arriving nearly
// simultaneously.
type GormProgressStore struct {
	db *gorm.DB
}

func NewGormProgressStore(db *gorm.DB) *GormProgressStore {
	return &GormProgressStore{db: db}
}

// MarkDone implements ProgressStore.MarkDone — see that interface's own
// doc comment for the exactly-once contract this method has to uphold.
//
// The whole thing runs inside one serializable-enough transaction: first
// an upsert that creates the (subjectID, ruleName) row if it doesn't exist
// yet and unconditionally stamps this side's *_done_at column (an upsert,
// not a plain INSERT, because the row may already exist from the OTHER
// side having happened first), then a row-locked SELECT ... FOR UPDATE
// read of the row's current state. Postgres's row lock is what actually
// makes this race-safe: if side A and side B's transactions both reach
// this point for the same (subjectID, ruleName) at nearly the same wall-
// clock time, the second transaction's SELECT ... FOR UPDATE blocks until
// the first COMMITs, so it always observes the first transaction's write
// — there is no interleaving where both transactions independently see
// "the other side isn't done yet" and both incorrectly report
// completedNow=true.
func (s *GormProgressStore) MarkDone(subjectID, ruleName, side string) (completedNow bool, err error) {
	if side != "a" && side != "b" {
		return false, fmt.Errorf("notify: MarkDone: side must be \"a\" or \"b\", got %q", side)
	}

	now := time.Now()
	column := "a_done_at"
	if side == "b" {
		column = "b_done_at"
	}

	err = s.db.Transaction(func(tx *gorm.DB) error {
		upsert := ruleProgressRow{SubjectID: subjectID, RuleName: ruleName}
		if side == "a" {
			upsert.ADoneAt = &now
		} else {
			upsert.BDoneAt = &now
		}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "subject_id"}, {Name: "rule_name"}},
			DoUpdates: clause.Assignments(map[string]any{column: now}),
		}).Create(&upsert).Error; err != nil {
			return fmt.Errorf("upsert progress: %w", err)
		}

		var row ruleProgressRow
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("subject_id = ? AND rule_name = ?", subjectID, ruleName).
			First(&row).Error; err != nil {
			return fmt.Errorf("read progress: %w", err)
		}

		if row.ADoneAt != nil && row.BDoneAt != nil && row.NotifiedAt == nil {
			if err := tx.Model(&ruleProgressRow{}).
				Where("subject_id = ? AND rule_name = ?", subjectID, ruleName).
				Update("notified_at", now).Error; err != nil {
				return fmt.Errorf("mark notified: %w", err)
			}
			completedNow = true
		}
		return nil
	})
	if err != nil {
		return false, fmt.Errorf("notify: MarkDone(%s, %s, %s): %w", subjectID, ruleName, side, err)
	}
	return completedNow, nil
}
