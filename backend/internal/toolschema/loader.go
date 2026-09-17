package toolschema

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// MaxDescriptionLength caps a tool's description, counted in runes so the
// limit means the same thing for CJK and emoji as it does for ASCII.
//
// Enforced here rather than only in the console, because `onagent tool
// create` pushes YAML straight past the console's own field — a console-only
// cap would be advisory, not a limit. The console mirrors this number (see
// apps/console/src/schema.ts's MAX_DESCRIPTION) and stops typing at it, so
// an over-long description is refused as it is written rather than after a
// round trip.
const MaxDescriptionLength = 600

var nameRE = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// appIDRE constrains appIds to safe characters for use as a SQL identifier
// value and, in the migration path (cmd/migrate) and auth.Store.Issue, a
// filename stem. Path separators, "..", leading dots are all excluded so a
// console API request can never point outside what's intended.
var appIDRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)

// ValidAppID reports whether id is safe to use as an app identifier.
func ValidAppID(id string) bool { return appIDRE.MatchString(id) }

// LoadDir reads every *.yaml/*.yml file in dir as an App definition and
// returns them keyed by AppID. It fails fast on duplicate AppIDs, duplicate
// tool names within an app, or invalid tool names, since these would
// otherwise surface as confusing runtime errors during codegen or dispatch.
//
// Used only by cmd/migrate now to import the pre-database YAML files into
// Postgres; Registry (registry.go) is the live data path.
func LoadDir(dir string) (map[string]*App, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("toolschema: read dir %s: %w", dir, err)
	}

	apps := make(map[string]*App)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		ext := filepath.Ext(entry.Name())
		if ext != ".yaml" && ext != ".yml" {
			continue
		}

		path := filepath.Join(dir, entry.Name())
		app, err := LoadFile(path)
		if err != nil {
			return nil, err
		}
		if _, dup := apps[app.AppID]; dup {
			return nil, fmt.Errorf("toolschema: duplicate appId %q (file %s)", app.AppID, path)
		}
		apps[app.AppID] = app
	}
	return apps, nil
}

// LoadFile reads and validates a single App definition file.
func LoadFile(path string) (*App, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("toolschema: read %s: %w", path, err)
	}

	var app App
	if err := yaml.Unmarshal(data, &app); err != nil {
		return nil, fmt.Errorf("toolschema: parse %s: %w", path, err)
	}

	if err := app.Validate(); err != nil {
		return nil, fmt.Errorf("toolschema: %s: %w", path, err)
	}

	return &app, nil
}

// Validate checks the same rules LoadFile enforces (unique/valid tool
// names, required description/parameters.type), independent of where the
// App came from. Used by LoadFile for YAML on disk, and by the console API
// for an App decoded from a request body — both must reject the same
// malformed input before it ever reaches a file or the in-memory Registry.
func (a *App) Validate() error {
	if !ValidAppID(a.AppID) {
		return fmt.Errorf("invalid appId %q (must match %s)", a.AppID, appIDRE.String())
	}

	seen := make(map[string]bool, len(a.Tools))
	for i, t := range a.Tools {
		if !nameRE.MatchString(t.Name) {
			return fmt.Errorf("tool[%d] has invalid name %q (must match %s)", i, t.Name, nameRE.String())
		}
		if seen[t.Name] {
			return fmt.Errorf("duplicate tool name %q", t.Name)
		}
		seen[t.Name] = true
		if t.Description == "" {
			return fmt.Errorf("tool %q is missing a description", t.Name)
		}
		if n := utf8.RuneCountInString(t.Description); n > MaxDescriptionLength {
			return fmt.Errorf("tool %q has a description of %d characters (limit is %d)", t.Name, n, MaxDescriptionLength)
		}
		if t.Parameters.Type == "" {
			return fmt.Errorf("tool %q is missing parameters.type", t.Name)
		}
		switch t.Kind {
		case "", ToolKindAction, ToolKindQuery:
		default:
			return fmt.Errorf("tool %q has invalid kind %q (must be %q or %q)", t.Name, t.Kind, ToolKindAction, ToolKindQuery)
		}
		if t.BackendDispatch != nil && t.BackendDispatch.Endpoint == "" {
			return fmt.Errorf("tool %q has a backendDispatch block but no endpoint", t.Name)
		}
	}

	return nil
}
