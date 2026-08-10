// Command migrate is a one-time import of the pre-database state
// (backend/tools/*.yaml app+tool definitions, backend/apps/*.json API key
// hashes) into Postgres. Run once when moving an existing deployment onto
// the database-backed backend; a fresh deployment with no prior YAML/JSON
// files has nothing to migrate and can skip this entirely.
//
// Idempotent per app: re-running after a partial run just re-saves each app
// (toolschema.Registry.Save is upsert + replace-all-tools) and re-applies
// any key file found, so a failure partway through is safe to retry.
//
// Migrated apps have no owner (owner_id NULL) unless -owner-email is given,
// since the pre-multi-user world had no concept of one. An unowned app is
// invisible to the console API (internal/console's withOwnedApp requires an
// exact owner match) — it keeps working for already-connected sites
// (internal/ws doesn't check ownership), but nobody can log in and manage
// it until an owner is assigned.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"gorm.io/gorm"

	"github.com/tim72117/onagent/internal/db"
	"github.com/tim72117/onagent/internal/toolschema"
)

// userLookupRow/appKeyRow are this command's own narrow, independent views
// of the shared users/apps tables — same convention internal/auth and
// internal/toolschema use for apps (see auth.go's appAuthRow doc comment):
// no shared model package, and every write here is a column-scoped
// Update(), never a bare Save(), so this can never clobber owner_id/thought
// (toolschema's columns) or allowed_origin (auth's other column).
type userLookupRow struct {
	ID int64 `gorm:"column:id"`
}

func (userLookupRow) TableName() string { return "users" }

type appKeyRow struct {
	AppID      string `gorm:"column:app_id"`
	APIKeyHash string `gorm:"column:api_key_hash"`
}

func (appKeyRow) TableName() string { return "apps" }

type keyFile struct {
	AppID      string `json:"appId"`
	ApiKeyHash string `json:"apiKeyHash"`
}

func main() {
	dsn := flag.String("db", envOr("DATABASE_URL", "postgres://platform:platform@localhost:5434/platform?sslmode=disable"), "database connection string")
	toolsDir := flag.String("tools-dir", "tools", "directory of legacy *.yaml app/tool definitions")
	appsDir := flag.String("apps-dir", "apps", "directory of legacy <appId>.json API key files")
	ownerEmail := flag.String("owner-email", "", "existing user account email to assign as owner of every migrated app (must already be registered); omit to leave apps unowned")
	flag.Parse()

	database, err := db.Open(*dsn)
	if err != nil {
		fatal("connect to database", err)
	}
	if sqlDB, err := database.DB(); err == nil {
		defer sqlDB.Close()
	}

	var ownerID int64
	var hasOwner bool
	if *ownerEmail != "" {
		var row userLookupRow
		err := database.Where("lower(email) = lower(?)", *ownerEmail).First(&row).Error
		if err != nil {
			fatal(fmt.Sprintf("look up owner %q (register this account first via POST /auth/register)", *ownerEmail), err)
		}
		ownerID = row.ID
		hasOwner = true
	}

	registry, err := toolschema.NewRegistry(database)
	if err != nil {
		fatal("open registry", err)
	}

	apps, err := toolschema.LoadDir(*toolsDir)
	if err != nil {
		fatal(fmt.Sprintf("read %s", *toolsDir), err)
	}
	if len(apps) == 0 {
		fmt.Printf("No YAML app definitions found in %s — nothing to migrate.\n", *toolsDir)
		return
	}

	for appID, app := range apps {
		if _, exists := registry.Get(appID); !exists {
			if !hasOwner {
				fatal(fmt.Sprintf("create app %s", appID),
					fmt.Errorf("app doesn't exist yet and no -owner-email given; a newly created app needs an owner"))
			}
			if err := registry.Create(appID, ownerID); err != nil {
				fatal(fmt.Sprintf("create app %s", appID), err)
			}
		}
		if err := registry.Save(app); err != nil {
			fatal(fmt.Sprintf("save app %s", appID), err)
		}
		fmt.Printf("Migrated app %-20s %d tool(s)\n", appID, len(app.Tools))
	}

	keyCount, err := migrateKeys(database, *appsDir, apps)
	if err != nil {
		fatal("migrate API keys", err)
	}

	fmt.Printf("\nDone: %d app(s), %d key(s).\n", len(apps), keyCount)
	if keyCount > 0 {
		fmt.Println("Existing plaintext keys were never stored anywhere and still work unchanged " +
			"(only their hashes moved from apps/*.json into the database).")
	}
}

// migrateKeys reads every backend/apps/<appId>.json that has a matching
// migrated app and writes its hash directly into the apps table — directly
// via a column-scoped GORM Update, not through auth.Store.Issue, because
// Issue generates a *new* key and this must preserve the existing hash so
// already-deployed sites don't break.
func migrateKeys(database *gorm.DB, appsDir string, apps map[string]*toolschema.App) (int, error) {
	entries, err := os.ReadDir(appsDir)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read dir %s: %w", appsDir, err)
	}

	count := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(appsDir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			return count, fmt.Errorf("read %s: %w", path, err)
		}
		var kf keyFile
		if err := json.Unmarshal(data, &kf); err != nil {
			return count, fmt.Errorf("parse %s: %w", path, err)
		}
		if kf.AppID == "" || kf.ApiKeyHash == "" {
			return count, fmt.Errorf("%s: appId and apiKeyHash are both required", path)
		}
		if _, migrated := apps[kf.AppID]; !migrated {
			fmt.Printf("Skipping key for %-20s (no matching app in %s)\n", kf.AppID, path)
			continue
		}
		if err := database.Model(&appKeyRow{}).Where("app_id = ?", kf.AppID).
			Update("api_key_hash", kf.ApiKeyHash).Error; err != nil {
			return count, fmt.Errorf("apply key for %s: %w", kf.AppID, err)
		}
		fmt.Printf("Migrated key for %-20s\n", kf.AppID)
		count++
	}
	return count, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func fatal(action string, err error) {
	fmt.Fprintf(os.Stderr, "migrate: %s: %v\n", action, err)
	os.Exit(1)
}
