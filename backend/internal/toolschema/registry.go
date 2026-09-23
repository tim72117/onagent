package toolschema

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/tim72117/onagent/internal/events"
)

// appRow is toolschema's own narrow view of the shared `apps` table —
// deliberately declared independently of internal/auth's own view of the
// same table (see auth.go's appAuthRow), same rationale: no shared model
// package, no cross-package coupling. Every write in this file uses either
// Create with an OnConflict clause, or a column-scoped Update/Updates —
// never a bare Save() — for the same "don't risk clobbering a column the
// other package owns" reason documented on appAuthRow.
type appRow struct {
	AppID           string  `gorm:"column:app_id;primaryKey"`
	OwnerID         *int64  `gorm:"column:owner_id"`
	Thought         *string `gorm:"column:thought"`
	Public          bool    `gorm:"column:public"`
	MaxPromptLength *int    `gorm:"column:max_prompt_length"`
	Enabled         bool    `gorm:"column:enabled"`
}

func (appRow) TableName() string { return "apps" }

// toolRow is the GORM-mapped shape of the `tools` table (surrogate `id`
// primary key, (app_id, name) a UNIQUE constraint instead — see
// internal/db/schema.sql and its migration comment for why this replaced
// the old (app_id, name) composite primary key). BackendDispatch is NULL
// (nil) for the common case of a tool that dispatches to the connected
// browser page — see Tool.BackendDispatch's doc comment.
type toolRow struct {
	ID              int64   `gorm:"column:id;primaryKey"`
	AppID           string  `gorm:"column:app_id"`
	Name            string  `gorm:"column:name"`
	Description     string  `gorm:"column:description"`
	Parameters      []byte  `gorm:"column:parameters"`
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
	// events is nil until SetEventBus is called — every Publish call site
	// in this file guards on r.events != nil first, so a Registry built
	// without ever calling SetEventBus (every existing test/tool that
	// constructs one via NewRegistry, unchanged) behaves exactly as before
	// this field was added: no events published, same as if this field
	// didn't exist. This mirrors quota.Service's own "nil disables the
	// feature" convention elsewhere in this codebase (see ws.Session.quota),
	// chosen over adding a required *events.Bus parameter to NewRegistry
	// specifically to avoid changing its signature at all five existing
	// call sites (cmd/server, cmd/migrate, and three integration test
	// files) just to plumb an optional feature through.
	events *events.Bus
}

// NewRegistry loads every app from db once and returns a Registry serving
// that snapshot. The returned Registry publishes no events until
// SetEventBus is called.
func NewRegistry(db *gorm.DB) (*Registry, error) {
	r := &Registry{db: db}
	if err := r.Reload(); err != nil {
		return nil, err
	}
	return r, nil
}

// SetEventBus wires bus into r so future writes (currently: SaveTool
// inserting a brand-new tool) publish an events.Event. Optional — call
// this once at process startup (see cmd/server/main.go) if the process
// wants event-driven side effects (eventually: the notification rule
// engine's subscriber); skip it entirely for a Registry with no such need
// (every existing test does exactly this, unchanged).
func (r *Registry) SetEventBus(bus *events.Bus) {
	r.events = bus
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

// SaveTool validates tool and upserts it in the tools table, returning the
// row's id (unchanged for an update, freshly assigned for an insert) —
// unlike the replace-all Save this superseded (see git history), every
// other tool already on appID is left completely untouched. Both the
// console front-end's per-tool editor and the CLI's `onagent tool create`
// write through this now, since neither has (or should need) the app's
// full current tool list in hand just to avoid clobbering it.
//
// tool.ID selects which of the two this is (see saveTool's own doc
// comment): zero means "create a new tool," matching tool.Name against
// (app_id, name)'s UNIQUE constraint (so a name collision within the app is
// still rejected, just as a database error rather than Validate catching
// it — Validate only sees the one tool being saved, not the rest of the
// app's existing tools); nonzero means "update the row with this id,"
// changing its name in place if tool.Name differs from what's currently
// stored — the single atomic UPDATE that replaced the old
// delete-old-name-then-insert-new-name two-step a name-only identifier
// used to force (see this file's package doc comment and App.tsx's
// persistTool for the bug that motivated this).
//
// tool is validated by wrapping it in a single-tool App and reusing
// App.Validate() — appID itself must already be ValidAppID (Create already
// enforced that when the app was made), so this only needs Validate's
// per-tool checks (name, description, parameters.type, kind, ...), not a
// second, separately-maintained set of single-tool validation rules.
func (r *Registry) SaveTool(appID string, tool Tool) (id int64, err error) {
	if err := (&App{AppID: appID, Tools: []Tool{tool}}).Validate(); err != nil {
		return 0, fmt.Errorf("toolschema: refusing to save invalid tool: %w", err)
	}
	// tool.ID == 0 on the way in means this call is a create, not an
	// update (see this method's own doc comment on tool.ID's two
	// meanings) — captured before saveTool runs, since saveTool doesn't
	// mutate the tool value's ID field, but reading isCreate after the
	// call would read the same way regardless and stop being a reliable
	// signal the moment that assumption changes.
	isCreate := tool.ID == 0
	id, err = saveTool(r.db, appID, tool)
	if err != nil {
		return 0, err
	}
	if err := r.Reload(); err != nil {
		return 0, err
	}
	// Fire-and-forget on its own goroutine (see events.Bus.Publish's own
	// doc comment on why Publish itself runs handlers synchronously on the
	// calling goroutine) — a slow or buggy notification-rule subscriber
	// must never add latency to, or fail, an app owner's tool save.
	// Guarded on r.events != nil: see the Registry.events field's own
	// comment for why this is nil in every existing caller that hasn't
	// opted in via SetEventBus.
	if r.events != nil && isCreate {
		// isFirst is computed here (once, at the moment of the event that
		// caused it) rather than left for a subscriber to work out later —
		// by the time any subscriber runs, a second tool could already
		// have been created (this is fire-and-forget on another
		// goroutine), so "was this the app's first tool" would no longer
		// be answerable from Get(appID) alone. r.Reload() above already
		// ran, so app.Tools reflects this write.
		isFirst := false
		if app, ok := r.Get(appID); ok {
			isFirst = len(app.Tools) == 1
		}
		go r.events.Publish(events.Event{
			Type:      "tool.created",
			SubjectID: appID,
			Metadata:  map[string]any{"toolName": tool.Name, "toolId": id, "isFirst": isFirst},
		})
	}
	return id, nil
}

// DeleteTool removes the one (app_id, name) row from tools, and reloads.
// Deleting a tool name that never existed is not an error — same
// already-gone-is-fine convention as Registry.Delete for a nonexistent app.
// Kept name-based (rather than requiring an id) for the CLI's `onagent tool
// delete <appId> <toolName>`, which — like `tool create` — has no reason to
// know or track a tool's id; see DeleteToolByID for the id-based sibling
// the console editor uses.
func (r *Registry) DeleteTool(appID, name string) error {
	if err := r.db.Where("app_id = ? AND name = ?", appID, name).Delete(&toolRow{}).Error; err != nil {
		return fmt.Errorf("toolschema: delete tool %s.%s: %w", appID, name, err)
	}
	return r.Reload()
}

// DeleteToolByID removes the one tool row with the given id, scoped to
// appID (so a caller can never delete a tool belonging to a different app
// by guessing/reusing an id), and reloads. Deleting an id that never
// existed (or belongs to a different app) is not an error — same
// already-gone-is-fine convention as DeleteTool for an unknown name.
func (r *Registry) DeleteToolByID(appID string, id int64) error {
	if err := r.db.Where("app_id = ? AND id = ?", appID, id).Delete(&toolRow{}).Error; err != nil {
		return fmt.Errorf("toolschema: delete tool %s#%d: %w", appID, id, err)
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
// public sets the new app's Public flag at creation time (see App.Public's
// own doc comment for what that unlocks — non-owner Playground access,
// nothing else) — false is the same default the schema itself already
// enforces (apps.public NOT NULL DEFAULT false), so every existing caller
// passing false here changes nothing; this is purely a way to skip the
// separate SetPublic call for a caller (the CLI's `app create -public`)
// that wants a public app from the start rather than as a later edit.
//
// ownerID isn't part of the App type (see toolschema/schema.go) because
// ownership is a console-API-only concern — the WebSocket handler and public
// codegen endpoints that read through Registry.Get/All never need to know
// who owns what, only what an app's tools are.
func (r *Registry) Create(appID string, ownerID int64, public bool) error {
	if !ValidAppID(appID) {
		return fmt.Errorf("toolschema: invalid appId %q", appID)
	}
	if _, exists := r.Get(appID); exists {
		return fmt.Errorf("toolschema: appId %q already exists", appID)
	}
	// Enabled is set explicitly rather than left to the column's DEFAULT
	// TRUE: GORM includes every non-pointer field of the struct in the
	// INSERT, so a zero-valued bool would write false and the default
	// would never apply — every newly created app would arrive disabled.
	if err := r.db.Create(&appRow{AppID: appID, OwnerID: &ownerID, Public: public, Enabled: true}).Error; err != nil {
		return fmt.Errorf("toolschema: create app %s: %w", appID, err)
	}
	if err := r.Reload(); err != nil {
		return err
	}
	// Fire-and-forget on its own goroutine (see events.Bus.Publish's own
	// doc comment on why) — feeds notify's "welcome" rule (see cmd/server/
	// main.go), which is gated on the isFirst flag attached below.
	// Guarded on r.events != nil: see the Registry.events field's own
	// comment for why this is nil in every existing caller that hasn't
	// opted in via SetEventBus.
	if r.events != nil {
		// isFirst is computed here (once, at the moment of the event that
		// caused it), same reasoning as SaveTool's own isFirst — by the
		// time any subscriber runs, this owner could already have created
		// a second app (Publish is fire-and-forget on another goroutine),
		// so "was this the owner's first app" would no longer be
		// answerable from OwnedBy alone.
		isFirst := false
		if ids, err := r.OwnedBy(ownerID); err == nil {
			isFirst = len(ids) == 1
		}
		go r.events.Publish(events.Event{
			Type:      "app.created",
			SubjectID: appID,
			ActorID:   ownerID,
			Metadata:  map[string]any{"isFirst": isFirst},
		})
	}
	return nil
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

// SetEnabled turns appID's embedded SDK on or off, and reloads so the
// change applies to the next handshake. Disabling does not close the
// connections an app already has — a live WebSocket keeps running until it
// ends on its own, and is refused when it next tries to reconnect. Fails
// if appID doesn't exist.
func (r *Registry) SetEnabled(appID string, enabled bool) error {
	if !ValidAppID(appID) {
		return fmt.Errorf("toolschema: invalid appId %q", appID)
	}
	res := r.db.Model(&appRow{}).Where("app_id = ?", appID).Update("enabled", enabled)
	if res.Error != nil {
		return fmt.Errorf("toolschema: set enabled for %s: %w", appID, res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("toolschema: no such app %q", appID)
	}
	return r.Reload()
}

// SetMaxPromptLength sets or clears (maxLen == nil) appID's own cap on a
// single end-user prompt's character count, and reloads so the change is
// visible immediately. A non-nil *maxLen <= 0 is rejected — a limit of zero
// or negative characters isn't a meaningful setting a developer would
// actually want; clear the limit (pass nil) to fall back to the
// system-wide default instead. Fails if appID doesn't exist. Note this
// only stores the app's own requested value — it does NOT clamp against
// the system-wide MAX_PROMPT_LENGTH env var here, since that ceiling can
// change independently of any app's stored value; the clamp happens at
// read time in inference.EffectiveMaxPromptLength instead, so raising the
// system-wide cap later doesn't require rewriting every app's row.
func (r *Registry) SetMaxPromptLength(appID string, maxLen *int) error {
	if !ValidAppID(appID) {
		return fmt.Errorf("toolschema: invalid appId %q", appID)
	}
	if maxLen != nil && *maxLen <= 0 {
		return fmt.Errorf("toolschema: maxPromptLength must be positive, got %d", *maxLen)
	}
	res := r.db.Model(&appRow{}).Where("app_id = ?", appID).Update("max_prompt_length", maxLen)
	if res.Error != nil {
		return fmt.Errorf("toolschema: set max prompt length for %s: %w", appID, res.Error)
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
		apps[row.AppID] = &App{AppID: row.AppID, Tools: []Tool{}, Thought: thought, Public: row.Public, MaxPromptLength: row.MaxPromptLength, Enabled: row.Enabled}
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

		tool := Tool{ID: tr.ID, Name: tr.Name, Description: tr.Description, Parameters: params, Kind: ToolKind(tr.Kind)}
		if tr.SourceTemplate != nil {
			tool.SourceTemplate = *tr.SourceTemplate
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

// saveTool upserts one tool row inside one transaction, so a concurrent
// Reload can never observe a half-written tools table (there's really only
// one row here, but the existence check below and the insert/update must
// still commit or fail together), and returns that row's id.
//
// tool.ID == 0 means "no existing row known" — insert, upserting by
// (app_id, name) via ON CONFLICT the same way this always worked (the CLI's
// `onagent tool create <appId> <tool.yaml>` path: a hand-written YAML file
// has no id to give, and re-running it against an unchanged name must keep
// updating that same tool, not create a duplicate). tool.ID != 0 means "the
// caller already knows which row this is" (the console API's per-tool
// editor, once a tool has been saved once and the console holds onto its
// id) — this is the path that actually fixes the rename bug: an UPDATE ...
// WHERE id = tool.ID changes name in place, atomically, with no window
// where the tool exists under neither name (contrast the old
// (app_id, name)-keyed ON CONFLICT, which had no way to change the
// conflict target itself — a rename there meant the caller had to run a
// separate DELETE for the old name first, and if the following INSERT then
// failed, the tool was simply gone).
func saveTool(db *gorm.DB, appID string, tool Tool) (id int64, err error) {
	err = db.Transaction(func(tx *gorm.DB) error {
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

		if tool.ID != 0 {
			// Update-in-place by id, including name — this is the whole
			// point (see this function's doc comment): a rename is one
			// UPDATE, never a DELETE+INSERT. Scoped to app_id too, so a
			// caller can never repoint an id it was handed for one app onto
			// a row belonging to another. Deliberately does NOT touch
			// position (an existing tool keeps its place — see the insert
			// branch below for where position is actually assigned).
			res := tx.Model(&toolRow{}).
				Where("id = ? AND app_id = ?", tool.ID, appID).
				Updates(map[string]any{
					"name": tool.Name, "description": tool.Description,
					"parameters": paramsJSON, "kind": string(kind),
					"backend_dispatch": backendDispatchJSON, "source_template": sourceTemplate,
				})
			if res.Error != nil {
				return fmt.Errorf("toolschema: update tool %s#%d: %w", appID, tool.ID, res.Error)
			}
			if res.RowsAffected == 0 {
				return fmt.Errorf("toolschema: no tool with id %d on app %q", tool.ID, appID)
			}
			id = tool.ID
			return nil
		}

		// tool.ID == 0: insert, or upsert-by-name for a caller (the CLI)
		// that doesn't track ids at all — ON CONFLICT (app_id, name) keeps
		// re-running `onagent tool create` against an unchanged name
		// idempotent, same as before this file gained an id column.
		//
		// position defaults to "after every existing tool on this app" for
		// a brand-new name; ON CONFLICT's DoUpdates list deliberately
		// excludes position, so updating an existing tool by name leaves
		// its current position alone instead of moving it to the end.
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
			Parameters: paramsJSON, Kind: string(kind),
			BackendDispatch: backendDispatchJSON, Position: position, SourceTemplate: sourceTemplate,
		}
		err = tx.Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "app_id"}, {Name: "name"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"description", "parameters", "kind", "backend_dispatch", "source_template",
			}),
		}).Create(&row).Error
		if err != nil {
			return fmt.Errorf("toolschema: upsert tool %s.%s: %w", appID, tool.Name, err)
		}
		id = row.ID
		return nil
	})
	return id, err
}
