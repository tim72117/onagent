// Database schema completeness check (GET /admin/api/schema-check). See
// db.CheckTable's doc comment for what this catches that hand-maintained
// schema.sql + narrow GORM structs alone wouldn't (a column or primary key
// renamed on one side and not the other, or a migration applied to the
// database that no struct anywhere has caught up with yet).
//
// Every production row struct across the migrated packages (auth.appAuthRow,
// toolschema.appRow, session.userRow, ...) is DELIBERATELY narrow — each
// package only declares the columns it actually reads/writes, so a bare
// GORM Save() can never clobber a column another package owns (see e.g.
// auth.appAuthRow's own doc comment). Comparing those narrow structs
// directly against the database would make every table "fail" permanently
// on every column its owning package doesn't touch, which would make this
// endpoint noise, not a signal. So this file defines its own, separate set
// of "full column" reference structs — one per table, covering every column
// schema.sql declares — used ONLY for this comparison. They are never
// wired into any query, so they carry none of the narrow structs'
// clobber-risk concerns.
package adminconsole

import (
	"net/http"
	"sort"
	"time"

	"github.com/tim72117/onagent/internal/adminauth"
	"github.com/tim72117/onagent/internal/db"
)

type schemaCheckResponse struct {
	Ok     bool             `json:"ok"`
	Tables []db.SchemaCheck `json:"tables"`
}

// The reference structs below mirror internal/db/schema.sql's CREATE TABLE
// statements column-for-column. They intentionally duplicate field
// declarations that already exist (narrower) elsewhere in the codebase —
// see this file's package doc comment for why that duplication is the
// point, not an oversight to "fix" by importing the production structs.
type usersFull struct {
	ID           int64     `gorm:"column:id;primaryKey"`
	Email        string    `gorm:"column:email"`
	PasswordHash string    `gorm:"column:password_hash"`
	CreatedAt    time.Time `gorm:"column:created_at"`
}

func (usersFull) TableName() string { return "users" }

type sessionsFull struct {
	ID        string    `gorm:"column:id;primaryKey"`
	UserID    int64     `gorm:"column:user_id"`
	ExpiresAt time.Time `gorm:"column:expires_at"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

func (sessionsFull) TableName() string { return "sessions" }

type userTokensFull struct {
	ID         int64      `gorm:"column:id;primaryKey"`
	TokenHash  string     `gorm:"column:token_hash"`
	UserID     int64      `gorm:"column:user_id"`
	Name       string     `gorm:"column:name"`
	CreatedAt  time.Time  `gorm:"column:created_at"`
	LastUsedAt *time.Time `gorm:"column:last_used_at"`
}

func (userTokensFull) TableName() string { return "user_tokens" }

type cliAuthSessionsFull struct {
	ID          string    `gorm:"column:id;primaryKey"`
	RedirectURI string    `gorm:"column:redirect_uri"`
	Name        string    `gorm:"column:name"`
	Token       *string   `gorm:"column:token"`
	Approved    bool      `gorm:"column:approved"`
	ExpiresAt   time.Time `gorm:"column:expires_at"`
	CreatedAt   time.Time `gorm:"column:created_at"`
}

func (cliAuthSessionsFull) TableName() string { return "cli_auth_sessions" }

type appsFull struct {
	AppID         string    `gorm:"column:app_id;primaryKey"`
	OwnerID       *int64    `gorm:"column:owner_id"`
	APIKeyHash    *string   `gorm:"column:api_key_hash"`
	AllowedOrigin *string   `gorm:"column:allowed_origin"`
	Thought       *string   `gorm:"column:thought"`
	CreatedAt     time.Time `gorm:"column:created_at"`
}

func (appsFull) TableName() string { return "apps" }

type toolsFull struct {
	AppID           string `gorm:"column:app_id;primaryKey"`
	Name            string `gorm:"column:name;primaryKey"`
	Description     string `gorm:"column:description"`
	Parameters      []byte `gorm:"column:parameters"`
	Returns         []byte `gorm:"column:returns"`
	Kind            string `gorm:"column:kind"`
	BackendDispatch []byte `gorm:"column:backend_dispatch"`
	Position        int    `gorm:"column:position"`
}

func (toolsFull) TableName() string { return "tools" }

type subscriptionsFull struct {
	UserID        int64     `gorm:"column:user_id;primaryKey"`
	Tier          string    `gorm:"column:tier"`
	QuotaOverride *int64    `gorm:"column:monthly_quota"`
	StartedAt     time.Time `gorm:"column:started_at"`
	UpdatedAt     time.Time `gorm:"column:updated_at"`
}

func (subscriptionsFull) TableName() string { return "subscriptions" }

type usageEventsFull struct {
	ID        int64     `gorm:"column:id;primaryKey"`
	AppID     *string   `gorm:"column:app_id"`
	OwnerID   *int64    `gorm:"column:owner_id"`
	EventID   string    `gorm:"column:event_id"`
	Kind      string    `gorm:"column:kind"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

func (usageEventsFull) TableName() string { return "usage_events" }

type adminUsersFull struct {
	ID           int64     `gorm:"column:id;primaryKey"`
	Email        string    `gorm:"column:email"`
	PasswordHash string    `gorm:"column:password_hash"`
	CreatedAt    time.Time `gorm:"column:created_at"`
}

func (adminUsersFull) TableName() string { return "admin_users" }

type adminSessionsFull struct {
	ID          string    `gorm:"column:id;primaryKey"`
	AdminUserID int64     `gorm:"column:admin_user_id"`
	ExpiresAt   time.Time `gorm:"column:expires_at"`
	CreatedAt   time.Time `gorm:"column:created_at"`
}

func (adminSessionsFull) TableName() string { return "admin_sessions" }

// schemaCheckTargets is a hand-maintained mirror of schema.sql's tables —
// add a table's reference struct above and an entry here whenever
// schema.sql gains one, or the new table silently drops out of this check.
func schemaCheckTargets() map[string][]any {
	return map[string][]any{
		"users":              {&usersFull{}},
		"sessions":           {&sessionsFull{}},
		"user_tokens":        {&userTokensFull{}},
		"cli_auth_sessions":  {&cliAuthSessionsFull{}},
		"apps":               {&appsFull{}},
		"tools":              {&toolsFull{}},
		"subscriptions":      {&subscriptionsFull{}},
		"usage_events":       {&usageEventsFull{}},
		"admin_users":        {&adminUsersFull{}},
		"admin_sessions":     {&adminSessionsFull{}},
	}
}

// schemaCheck compares every table's reference struct against the live
// database, table names sorted for a stable response.
func (h *Handler) schemaCheck(w http.ResponseWriter, r *http.Request, _ *adminauth.Admin) {
	targets := schemaCheckTargets()
	tables := make([]string, 0, len(targets))
	for table := range targets {
		tables = append(tables, table)
	}
	sort.Strings(tables)

	checks := make([]db.SchemaCheck, 0, len(tables))
	ok := true
	for _, table := range tables {
		check, err := db.CheckTable(h.DB, table, targets[table]...)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !check.Ok {
			ok = false
		}
		checks = append(checks, check)
	}
	writeJSON(w, http.StatusOK, schemaCheckResponse{Ok: ok, Tables: checks})
}
