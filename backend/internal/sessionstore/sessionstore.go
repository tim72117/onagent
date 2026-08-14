// Package sessionstore implements want's types.SessionStore against this
// backend's own Postgres database, so a session's conversation history
// survives process restarts/redeploys instead of living only in memory for
// the orchestrator's lifetime. See want's
// doc/guide-custom-session-store-2026-08.md for the interface contract this
// implements.
package sessionstore

import (
	"encoding/json"
	"fmt"

	"github.com/tim72117/want/types"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// experienceRow is the GORM-mapped shape of the agent_experiences table
// (see internal/db/schema.sql). id is the table's own auto-increment
// ordering column — Load sorts by it, not by exp_id or created_at, to
// preserve exact insertion order. AppID scopes every row to the app its
// session belongs to — see Store.ForApp's doc comment for why this exists.
type experienceRow struct {
	ID        int64  `gorm:"column:id;primaryKey"`
	SessionID string `gorm:"column:session_id"`
	AppID     string `gorm:"column:app_id"`
	ExpID     string `gorm:"column:exp_id"`
	Data      []byte `gorm:"column:data"`
}

func (experienceRow) TableName() string { return "agent_experiences" }

// Store is a GORM-backed types.SessionStore backend, shared process-wide.
// It does not itself implement types.SessionStore — see ForApp, which is
// the only way to get one. All writes are synchronous (no internal
// buffering).
type Store struct {
	db *gorm.DB
}

// New returns a Store that reads/writes through db. db must already have
// the agent_experiences table (see internal/db/schema.sql); callers get
// this for free since db.Open applies the schema on every startup.
func New(db *gorm.DB) *Store {
	return &Store{db: db}
}

// ForApp returns a types.SessionStore whose every Append/Load/Flush/
// DeleteSession call is scoped to appID: rows written through it always
// carry appID, and reads/deletes only ever see rows written under that
// same appID, never another app's.
//
// This exists because sessionID alone is not a safe scope for Load — see
// docs/sessionstore-architecture-review-2026-08-14.md #1/#3: sessionID has
// no access control of its own beyond staying unguessable, and a caller
// with no valid SessionID (want.go's sessionKeyFor "" fallback — shared by
// every such caller) would otherwise read and write one shared, persisted
// history across all of them. Binding to appID at the point each session's
// orchestrator is built (see inference.WantService.buildOrchestrator, the
// only caller of this method) closes that gap without changing want's
// fixed types.SessionStore interface, which has no room for an app
// parameter of its own.
func (s *Store) ForApp(appID string) types.SessionStore {
	return &scopedStore{store: s, appID: appID}
}

// scopedStore adapts Store to types.SessionStore for exactly one appID —
// see Store.ForApp.
type scopedStore struct {
	store *Store
	appID string
}

func (s *scopedStore) Append(sessionID string, exp types.Experience, id string) error {
	return s.store.append(s.appID, sessionID, exp, id)
}

func (s *scopedStore) Load(sessionID string) ([]types.Experience, error) {
	return s.store.load(s.appID, sessionID)
}

func (s *scopedStore) Flush(sessionID string) error {
	return s.store.flush(s.appID, sessionID)
}

func (s *scopedStore) DeleteSession(sessionID string) error {
	return s.store.deleteSession(s.appID, sessionID)
}

// append persists exp under sessionID (scoped to appID), keyed by id
// (want's per-Experience uuid). A repeated id for the same sessionID is a
// no-op, not an error — the guide leaves redelivery dedup to the
// implementer, and want's own callers may retry an Append after an
// ambiguous failure (e.g. a timeout where the write actually succeeded).
func (s *Store) append(appID, sessionID string, exp types.Experience, id string) error {
	data, err := json.Marshal(exp)
	if err != nil {
		return fmt.Errorf("sessionstore: marshal experience: %w", err)
	}

	row := experienceRow{SessionID: sessionID, AppID: appID, ExpID: id, Data: data}
	if err := s.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "session_id"}, {Name: "exp_id"}},
		DoNothing: true,
	}).Create(&row).Error; err != nil {
		return fmt.Errorf("sessionstore: append: %w", err)
	}
	return nil
}

// load returns sessionID's full Experience history in insertion order,
// restricted to rows recorded under appID — a sessionID belonging to a
// different app (or never recorded at all) returns an empty slice, exactly
// like a session with no history yet, not an error. "No history visible to
// this app" and "no history at all" are indistinguishable on purpose: this
// is the access-control boundary itself, not a special case to report
// differently.
func (s *Store) load(appID, sessionID string) ([]types.Experience, error) {
	var rows []experienceRow
	if err := s.db.
		Where("app_id = ? AND session_id = ?", appID, sessionID).
		Order("id").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("sessionstore: load: %w", err)
	}

	experiences := make([]types.Experience, 0, len(rows))
	for _, row := range rows {
		var exp types.Experience
		if err := json.Unmarshal(row.Data, &exp); err != nil {
			return nil, fmt.Errorf("sessionstore: load: unmarshal: %w", err)
		}
		experiences = append(experiences, exp)
	}
	return experiences, nil
}

// flush is a no-op: every append above is already a synchronous write, so
// there is no buffer to drain.
func (s *Store) flush(appID, sessionID string) error {
	return nil
}

// deleteSession removes sessionID's entire history, scoped to appID —
// implements the optional types.SessionStoreDeleter interface, used only by
// want's REPL /context load command. onagent's own WebSocket path never
// calls this, but providing it costs nothing and keeps Store usable from a
// future REPL or CLI tool against the same database.
func (s *Store) deleteSession(appID, sessionID string) error {
	if err := s.db.Where("app_id = ? AND session_id = ?", appID, sessionID).Delete(&experienceRow{}).Error; err != nil {
		return fmt.Errorf("sessionstore: delete session: %w", err)
	}
	return nil
}
