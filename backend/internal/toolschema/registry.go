package toolschema

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// appRow is toolschema's own narrow view of the shared `apps` table —
// deliberately declared independently of internal/auth's own view of the
// same table (see auth.go's appAuthRow), same rationale: no shared model
// package, no cross-package coupling. Every write in this file uses either
// Create with an OnConflict clause, or a column-scoped Update/Updates —
// never a bare Save() — for the same "don't risk clobbering a column the
// other package owns" reason documented on appAuthRow.
type appRow struct {
	AppID   string  `gorm:"column:app_id;primaryKey"`
	OwnerID *int64  `gorm:"column:owner_id"`
	Thought *string `gorm:"column:thought"`
	Public  bool    `gorm:"column:public"`
}

func (appRow) TableName() string { return "apps" }

// toolRow is the GORM-mapped shape of the `tools` table (composite primary
// key app_id+name — see internal/db/schema.sql). BackendDispatch is NULL
// (nil) for the common case of a tool that dispatches to the connected
// browser page — see Tool.BackendDispatch's doc comment.
type toolRow struct {
	AppID           string  `gorm:"column:app_id;primaryKey"`
	Name            string  `gorm:"column:name;primaryKey"`
	Description     string  `gorm:"column:description"`
	Parameters      []byte  `gorm:"column:parameters"`
	Returns         []byte  `gorm:"column:returns"`
	Kind            string  `gorm:"column:kind"`
	BackendDispatch []byte  `gorm:"column:backend_dispatch"`
	Position        int     `gorm:"column:position"`
	SourceTemplate  *string `gorm:"column:source_template"`
}

func (toolRow) TableName() string { return "tools" }


// Registry is a thread-safe, database-backed holder for the set of
// registered apps. Introduced so the console API (internal/console) can
// create/update/delete an app's tools and have every consumer — the
// WebSocket handler, the codegen HTTP endpoints — see the change without a
// process restart. Originally backed by backend/tools/*.yaml on disk;
// now backed by Postgres (internal/db) so state survives across backend
// instances and isn't lost if the filesystem it ran on disappears.
//
// All reads/writes go through an in-memory cache refreshed by Reload,
// rather than hitting the database on every WebSocket hello — a session
// resolving its tool set shouldn't pay a query per connection.
type Registry struct {
	db   *gorm.DB
	mu   sync.RWMutex
	apps map[string]*App
}

// NewRegistry loads every app from db once and returns a Registry serving
// that snapshot.
func NewRegistry(db *gorm.DB) (*Registry, error) {
	r := &Registry{db: db}
	if err := r.Reload(); err != nil {
		return nil, err
	}
	return r, nil
}

// Get returns the app for id, and whether it was found.
func (r *Registry) Get(id string) (*App, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	app, ok := r.apps[id]
	return app, ok
}

// All returns a snapshot copy of every loaded app, keyed by appId. Safe to
// range over without holding the Registry's lock — callers get their own
// map, not a reference into internal state.
func (r *Registry) All() map[string]*App {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[string]*App, len(r.apps))
	for k, v := range r.apps {
		out[k] = v
	}
	return out
}

// Reload re-reads every app and its tools from the database and atomically
// swaps them into memory. On error, the previous in-memory set is left
// untouched.
func (r *Registry) Reload() error {
	apps, err := loadAllApps(r.db)
	if err != nil {
		return err
	}
	r.mu.Lock()
	r.apps = apps
	r.mu.Unlock()
	return nil
}

// SaveTool validates tool and upserts it as the one row (app_id, tool.Name)
// in the tools table — unlike the replace-all Save this superseded (see git
// history), every other tool already on appID is left completely untouched.
// Both the console front-end's per-tool editor and the CLI's `onagent tool
// create` write through this now, since neither has (or should need) the
// app's full current tool list in hand just to avoid clobbering it.
//
// tool is validated by wrapping it in a single-tool App and reusing
// App.Validate() — appID itself must already be ValidAppID (Create already
// enforced that when the app was made), so this only needs Validate's
// per-tool checks (name, description, parameters.type, kind, ...), not a
// second, separately-maintained set of single-tool validation rules.
func (r *Registry) SaveTool(appID string, tool Tool) error {
	if err := (&App{AppID: appID, Tools: []Tool{tool}}).Validate(); err != nil {
		return fmt.Errorf("toolschema: refusing to save invalid tool: %w", err)
	}
	if err := saveTool(r.db, appID, tool); err != nil {
		return err
	}
	return r.Reload()
}

// DeleteTool removes the one (app_id, name) row from tools, and reloads.
// Deleting a tool name that never existed is not an error — same
// already-gone-is-fine convention as Registry.Delete for a nonexistent app.
func (r *Registry) DeleteTool(appID, name string) error {
	if err := r.db.Where("app_id = ? AND name = ?", appID, name).Delete(&toolRow{}).Error; err != nil {
		return fmt.Errorf("toolschema: delete tool %s.%s: %w", appID, name, err)
	}
	return r.Reload()
}

// Delete removes an app and its tools (ON DELETE CASCADE) from the
// database and reloads. Deleting an app that doesn't exist is not an
// error — deleting something already gone is the caller's desired end
// state either way.
func (r *Registry) Delete(appID string) error {
	if !ValidAppID(appID) {
		return fmt.Errorf("toolschema: invalid appId %q", appID)
	}
	if err := r.db.Where("app_id = ?", appID).Delete(&appRow{}).Error; err != nil {
		return fmt.Errorf("toolschema: delete app %s: %w", appID, err)
	}
	return r.Reload()
}

// Create inserts a brand-new app owned by ownerID with no tools yet, and
// reloads. Fails if appID already exists — unlike Save, which is
// upsert-and-replace-tools for editing an app the caller already knows
// exists, Create is specifically "this must be a new app," so the console
// API can tell "created" apart from "already existed, tools replaced."
//
// ownerID isn't part of the App type (see toolschema/schema.go) because
// ownership is a console-API-only concern — the WebSocket handler and public
// codegen endpoints that read through Registry.Get/All never need to know
// who owns what, only what an app's tools are.
func (r *Registry) Create(appID string, ownerID int64) error {
	if !ValidAppID(appID) {
		return fmt.Errorf("toolschema: invalid appId %q", appID)
	}
	if _, exists := r.Get(appID); exists {
		return fmt.Errorf("toolschema: appId %q already exists", appID)
	}
	if err := r.db.Create(&appRow{AppID: appID, OwnerID: &ownerID}).Error; err != nil {
		return fmt.Errorf("toolschema: create app %s: %w", appID, err)
	}
	return r.Reload()
}

// OwnerOf returns the user id that owns appID, or ok=false if the app
// doesn't exist or (only possible for apps migrated before multi-user
// existed) has no owner recorded.
func (r *Registry) OwnerOf(appID string) (ownerID int64, ok bool) {
	var row appRow
	err := r.db.Select("owner_id").Where("app_id = ?", appID).Take(&row).Error
	if err != nil || row.OwnerID == nil {
		return 0, false
	}
	return *row.OwnerID, true
}

// SetThought sets or clears (thought == "") appID's custom want agent
// system prompt, and reloads so the change is visible immediately. Fails
// if appID doesn't exist.
func (r *Registry) SetThought(appID, thought string) error {
	if !ValidAppID(appID) {
		return fmt.Errorf("toolschema: invalid appId %q", appID)
	}
	var val *string
	if thought != "" {
		val = &thought
	}
	res := r.db.Model(&appRow{}).Where("app_id = ?", appID).Update("thought", val)
	if res.Error != nil {
		return fmt.Errorf("toolschema: set thought for %s: %w", appID, res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("toolschema: no such app %q", appID)
	}
	return r.Reload()
}

// SetPublic sets appID's Public flag and reloads so the change is visible
// immediately. Fails if appID doesn't exist. No REST route calls this today
// (no caller has asked for one) — it exists so a future admin/owner-facing
// endpoint has a ready-made write path, mirroring SetThought's shape.
func (r *Registry) SetPublic(appID string, public bool) error {
	if !ValidAppID(appID) {
		return fmt.Errorf("toolschema: invalid appId %q", appID)
	}
	res := r.db.Model(&appRow{}).Where("app_id = ?", appID).Update("public", public)
	if res.Error != nil {
		return fmt.Errorf("toolschema: set public for %s: %w", appID, res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("toolschema: no such app %q", appID)
	}
	return r.Reload()
}

// OwnedBy returns every appId owned by ownerID, for a user's app list.
func (r *Registry) OwnedBy(ownerID int64) ([]string, error) {
	var rows []appRow
	if err := r.db.
		Select("app_id").
		Where("owner_id = ?", ownerID).
		Order("app_id").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("toolschema: query apps for owner %d: %w", ownerID, err)
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.AppID)
	}
	return ids, nil
}

// --- database access ---------------------------------------------------

func loadAllApps(db *gorm.DB) (map[string]*App, error) {
	var appRows []appRow
	if err := db.Order("app_id").Find(&appRows).Error; err != nil {
		return nil, fmt.Errorf("toolschema: query apps: %w", err)
	}

	apps := make(map[string]*App, len(appRows))
	for _, row := range appRows {
		var thought string
		if row.Thought != nil {
			thought = *row.Thought
		}
		apps[row.AppID] = &App{AppID: row.AppID, Tools: []Tool{}, Thought: thought, Public: row.Public}
	}

	var toolRows []toolRow
	if err := db.Order("app_id, position").Find(&toolRows).Error; err != nil {
		return nil, fmt.Errorf("toolschema: query tools: %w", err)
	}

	for _, tr := range toolRows {
		var params ParameterSchema
		if err := json.Unmarshal(tr.Parameters, &params); err != nil {
			return nil, fmt.Errorf("toolschema: unmarshal parameters for %s.%s: %w", tr.AppID, tr.Name, err)
		}

		tool := Tool{Name: tr.Name, Description: tr.Description, Parameters: params, Kind: ToolKind(tr.Kind)}
		if tr.SourceTemplate != nil {
			tool.SourceTemplate = *tr.SourceTemplate
		}
		if tr.Returns != nil {
			var ret ParameterSchema
			if err := json.Unmarshal(tr.Returns, &ret); err != nil {
				return nil, fmt.Errorf("toolschema: unmarshal returns for %s.%s: %w", tr.AppID, tr.Name, err)
			}
			tool.Returns = &ret
		}
		if tr.BackendDispatch != nil {
			var bd BackendDispatch
			if err := json.Unmarshal(tr.BackendDispatch, &bd); err != nil {
				return nil, fmt.Errorf("toolschema: unmarshal backend_dispatch for %s.%s: %w", tr.AppID, tr.Name, err)
			}
			tool.BackendDispatch = &bd
		}

		app, ok := apps[tr.AppID]
		if !ok {
			// A tool row referencing an app_id not in `apps` would mean the
			// foreign key / cascade delete didn't do its job — a schema
			// invariant violation, not a normal runtime condition.
			return nil, fmt.Errorf("toolschema: tool %s.%s references missing app", tr.AppID, tr.Name)
		}
		app.Tools = append(app.Tools, tool)
	}

	return apps, nil
}

// saveTool upserts the single (app_id, tool.Name) row inside one
// transaction, so a concurrent Reload can never observe a half-written
// tools table (there's really only one row here, but the existence check
// below and the insert must still commit or fail together).
func saveTool(db *gorm.DB, appID string, tool Tool) error {
	return db.Transaction(func(tx *gorm.DB) error {
		// Must fail, not silently write an orphaned tool row, if appID
		// doesn't exist yet — mirrors the check the old saveApp made before
		// this function replaced it (see git history): apps.owner_id is
		// NOT NULL (schema.sql), and a tool row for an app_id with no
		// matching apps row would either violate the tools.app_id foreign
		// key or, on an older schema still missing that constraint,
		// silently create data with nothing to own it. In the real request
		// path this is unreachable — PUT /console/apps/{appId}/tools/
		// {toolName} runs behind withOwnedApp (console.go), which 404s a
		// nonexistent appId before saveTool's handler ever calls this —
		// this check only fires for a caller that bypasses that standard
		// flow, and it should get a clear error instead of quietly
		// corrupting data.
		var exists bool
		if err := tx.Raw(`SELECT EXISTS(SELECT 1 FROM apps WHERE app_id = ?)`, appID).Scan(&exists).Error; err != nil {
			return fmt.Errorf("toolschema: check app %s exists: %w", appID, err)
		}
		if !exists {
			return fmt.Errorf("toolschema: app %q does not exist; create it first via POST /console/apps", appID)
		}

		paramsJSON, err := json.Marshal(tool.Parameters)
		if err != nil {
			return fmt.Errorf("toolschema: marshal parameters for %s: %w", tool.Name, err)
		}
		var returnsJSON []byte
		if tool.Returns != nil {
			returnsJSON, err = json.Marshal(tool.Returns)
			if err != nil {
				return fmt.Errorf("toolschema: marshal returns for %s: %w", tool.Name, err)
			}
		}
		kind := tool.Kind
		if kind == "" {
			kind = ToolKindAction
		}
		var backendDispatchJSON []byte
		if tool.BackendDispatch != nil {
			backendDispatchJSON, err = json.Marshal(tool.BackendDispatch)
			if err != nil {
				return fmt.Errorf("toolschema: marshal backend_dispatch for %s: %w", tool.Name, err)
			}
		}
		var sourceTemplate *string
		if tool.SourceTemplate != "" {
			sourceTemplate = &tool.SourceTemplate
		}

		// position defaults to "after every existing tool on this app" for
		// a brand-new name; ON CONFLICT's DoUpdates list deliberately
		// excludes position, so updating an existing tool leaves its
		// current position alone instead of moving it to the end.
		var maxPosition sql.NullInt64
		if err := tx.Raw(`SELECT MAX(position) FROM tools WHERE app_id = ?`, appID).Scan(&maxPosition).Error; err != nil {
			return fmt.Errorf("toolschema: resolve position for %s: %w", tool.Name, err)
		}
		position := 0
		if maxPosition.Valid {
			position = int(maxPosition.Int64) + 1
		}

		row := toolRow{
			AppID: appID, Name: tool.Name, Description: tool.Description,
			Parameters: paramsJSON, Returns: returnsJSON, Kind: string(kind),
			BackendDispatch: backendDispatchJSON, Position: position, SourceTemplate: sourceTemplate,
		}
		err = tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "app_id"}, {Name: "name"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"description", "parameters", "returns", "kind", "backend_dispatch", "source_template",
			}),
		}).Create(&row).Error
		if err != nil {
			return fmt.Errorf("toolschema: upsert tool %s.%s: %w", appID, tool.Name, err)
		}
		return nil
	})
}
