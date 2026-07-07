package toolschema

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"gopkg.in/yaml.v3"
)

var nameRE = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// LoadDir reads every *.yaml/*.yml file in dir as an App definition and
// returns them keyed by AppID. It fails fast on duplicate AppIDs, duplicate
// tool names within an app, or invalid tool names, since these would
// otherwise surface as confusing runtime errors during codegen or dispatch.
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

	if app.AppID == "" {
		return nil, fmt.Errorf("toolschema: %s: appId is required", path)
	}

	seen := make(map[string]bool, len(app.Tools))
	for i, t := range app.Tools {
		if !nameRE.MatchString(t.Name) {
			return nil, fmt.Errorf("toolschema: %s: tool[%d] has invalid name %q (must match %s)", path, i, t.Name, nameRE.String())
		}
		if seen[t.Name] {
			return nil, fmt.Errorf("toolschema: %s: duplicate tool name %q", path, t.Name)
		}
		seen[t.Name] = true
		if t.Description == "" {
			return nil, fmt.Errorf("toolschema: %s: tool %q is missing a description", path, t.Name)
		}
		if t.Parameters.Type == "" {
			return nil, fmt.Errorf("toolschema: %s: tool %q is missing parameters.type", path, t.Name)
		}
	}

	return &app, nil
}
