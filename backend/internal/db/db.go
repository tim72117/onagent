// Package db owns the Postgres connection and schema for this backend's
// own state (apps, tools, API key hashes, users, sessions, ...).
// internal/toolschema and internal/auth are the only other packages that
// touch it directly today — everything else keeps talking to those
// packages' existing Go types, not to SQL.
//
// Every internal/* database-access package (and every cmd/* entrypoint)
// goes through GORM. There is no raw database/sql handle exposed here — a
// caller that genuinely needs one (none currently do) can get the same
// underlying *sql.DB GORM itself uses via the returned *gorm.DB's own DB()
// method, rather than this package maintaining a second parallel handle
// nothing uses.
package db

import (
	"database/sql"
	_ "embed"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/lib/pq"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

//go:embed schema.sql
var schemaSQL string

// Open connects to Postgres at dsn and applies schema.sql. Safe to call on
// every startup: every statement in schema.sql is idempotent (CREATE ... IF
// NOT EXISTS), so this never fails or duplicates state on a database that
// already has the schema from a previous run.
//
// Schema management stays entirely on schema.sql, deliberately not handed
// to GORM's AutoMigrate: AutoMigrate can't handle a renamed column or a
// changed primary key (it only ever adds what's missing), which is exactly
// the class of drift a hand-maintained schema.sql with reasoning in its own
// comments is easier to get right. GORM here is a query-layer library only.
func Open(dsn string) (*gorm.DB, error) {
	sqlDB, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: open: %w", err)
	}
	if err := sqlDB.Ping(); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("db: ping: %w", err)
	}
	if _, err := sqlDB.Exec(schemaSQL); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("db: apply schema: %w", err)
	}

	// DriverName is set to "postgres" (not left empty) because GORM's own
	// postgres driver treats an empty DriverName as "this is pgx" and, only
	// in that case, injects a pgx-specific query-mode sentinel into
	// Migrator().ColumnTypes()'s queries (see gorm.io/driver/postgres's
	// Migrator.GetRows). We're on lib/pq here (Conn reuses the *sql.DB
	// opened above via "postgres", not a pgx connection), so that sentinel
	// arrives as a bogus extra bound parameter lib/pq can't make sense of,
	// failing every ColumnTypes call with "got N parameters but the
	// statement requires N-1" — this only surfaced once something started
	// calling ColumnTypes (see CheckTable in schema_check.go).
	gormDB, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB, DriverName: "postgres"}), &gorm.Config{
		Logger: newGormLogger(),
	})
	if err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("db: gorm open: %w", err)
	}

	return gormDB, nil
}

// newGormLogger mirrors GORM's own default (Warn level, slow-query
// threshold) with one change: IgnoreRecordNotFoundError silences
// gorm.ErrRecordNotFound. That error is GORM's normal signal for "no row
// matched" — every First()-based existence/credential check in this
// codebase (adminauth.Login, session.Login, ...) hits it on a routine,
// expected miss (wrong password attempt, unregistered email), not a fault.
// Without this, GORM's default logger prints those as scary-looking error
// lines on every failed login attempt, which is misleading log noise, not a
// real problem to investigate.
func newGormLogger() gormlogger.Interface {
	return gormlogger.New(
		log.New(os.Stderr, "\r\n", log.LstdFlags),
		gormlogger.Config{
			SlowThreshold:             200 * time.Millisecond,
			LogLevel:                  gormlogger.Warn,
			IgnoreRecordNotFoundError: true,
		},
	)
}
