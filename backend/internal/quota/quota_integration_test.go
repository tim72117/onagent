//go:build integration

// Integration tests for the quota package (quota.go + admin.go) against a
// live Postgres. Excluded from the default build; run with:
//
//	go test -tags integration ./internal/quota/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
//
// These exercise Service's exported methods directly (Record, StandingFor,
// SetTier, CountUsers, ListUsers) rather than poking SQL, which is what
// distinguishes this file from internal/db/schema_integration_test.go's two
// quota-adjacent tests (idempotency of the ON CONFLICT constraint itself,
// and that deleting an app doesn't erase its usage ledger). This suite is
// meant to survive the package's planned rewrite from database/sql to GORM:
// it only asserts on Service's public behavior, never on the SQL used to
// get there.
package quota

import (
	"context"
	"database/sql"
	"flag"
	"testing"

	"github.com/tim72117/onagent/internal/db"
	"gorm.io/gorm"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

// openTestDB opens the shared dev Postgres, skipping the test (not failing
// the suite) when it isn't reachable, matching the other integration tests'
// convention.
func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	t.Cleanup(func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } })
	return database
}

// makeTestUser inserts a throwaway users row at a high, collision-avoiding
// id and registers its cleanup. Deleting the user CASCADEs to apps,
// subscriptions, and usage_events (see schema.sql), so a single cleanup
// here is enough to remove everything a test hangs off of it.
func makeTestUser(t *testing.T, conn *sql.DB, id int64, email string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
		id, email,
	); err != nil {
		t.Fatalf("insert test user %d: %v", id, err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup user %d: %v", id, err)
		}
	})
}

// makeTestApp inserts a throwaway apps row owned by ownerID and registers
// its cleanup. Cleaning it up explicitly (rather than relying solely on the
// owning user's CASCADE) keeps each test's app gone even if a later
// assertion in the same test fails before the user cleanup runs.
func makeTestApp(t *testing.T, conn *sql.DB, appID string, ownerID int64) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO apps (app_id, owner_id) VALUES ($1, $2)`,
		appID, ownerID,
	); err != nil {
		t.Fatalf("insert test app %s: %v", appID, err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID); err != nil {
			t.Errorf("cleanup app %s: %v", appID, err)
		}
	})
}

// TestRecordIsIdempotentThroughThePackage exercises Record's dedup semantics
// via the exported API (unlike schema_integration_test.go's
// TestSchemaApplyIsIdempotent, which inserts raw SQL to pin the DB
// constraint itself). Three Record calls with the same (appID, eventID) must
// leave usage counted once, observed through StandingFor's Used field since
// usageSince is unexported.
//
// Needs an explicit subscriptions row with started_at safely in the past:
// with no row at all, StandingFor/ownerStanding COALESCE started_at to
// now() at query time, which lands strictly after the usage_events rows'
// own created_at (also now(), but evaluated moments earlier by Record) and
// would exclude them from the current period — a real race in the
// no-subscription-row fallback, not a test bug. Pinning started_at avoids
// it, which is exactly what TestStandingForDefaultsWhenNoSubscriptionRow
// exists to test instead (it only asserts Used==0 for a fresh user with no
// usage at all, so the race there is harmless).
func TestRecordIsIdempotentThroughThePackage(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	svc := New(database)
	ctx := context.Background()

	const userID = 999901
	const appID = "quota-record-dedup-app"
	makeTestUser(t, conn, userID, "quota-record-dedup@example.com")
	makeTestApp(t, conn, appID, userID)
	if err := svc.SetTier(ctx, userID, TierFree); err != nil {
		t.Fatalf("SetTier: %v", err)
	}
	if _, err := conn.Exec(`UPDATE subscriptions SET started_at = now() - interval '1 day' WHERE user_id = $1`, userID); err != nil {
		t.Fatalf("backdate started_at: %v", err)
	}

	for i := 0; i < 3; i++ {
		if err := svc.Record(ctx, appID, "req-dedup-1"); err != nil {
			t.Fatalf("Record call %d: %v", i+1, err)
		}
	}

	st, err := svc.StandingFor(ctx, userID)
	if err != nil {
		t.Fatalf("StandingFor: %v", err)
	}
	if st.Used != 1 {
		t.Errorf("Used after 3 Records of the same event_id = %d, want 1", st.Used)
	}
}

// TestRecordAgainstUnknownAppIsANoOp confirms Record's insert-select never
// creates an orphaned usage_events row for an app_id that doesn't exist: the
// SELECT ... FROM apps WHERE app_id = $1 clause finds no matching row, so
// the INSERT has nothing to insert.
func TestRecordAgainstUnknownAppIsANoOp(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	svc := New(database)
	ctx := context.Background()

	const appID = "quota-nonexistent-app-999902"
	// Belt-and-suspenders: make sure nothing pre-existing shares this app_id.
	if _, err := conn.Exec(`DELETE FROM usage_events WHERE app_id = $1`, appID); err != nil {
		t.Fatalf("pre-cleanup: %v", err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM usage_events WHERE app_id = $1`, appID); err != nil {
			t.Errorf("cleanup usage_events for %s: %v", appID, err)
		}
	})

	if err := svc.Record(ctx, appID, "req-orphan-1"); err != nil {
		t.Fatalf("Record against unknown app returned an error: %v", err)
	}

	var n int
	if err := conn.QueryRow(`SELECT count(*) FROM usage_events WHERE app_id = $1`, appID).Scan(&n); err != nil {
		t.Fatalf("count usage_events: %v", err)
	}
	if n != 0 {
		t.Errorf("Record against an unknown app wrote %d usage_events rows, want 0", n)
	}
}

// TestStandingForDefaultsWhenNoSubscriptionRow confirms a user with no
// subscriptions row at all is treated as being on DefaultTier (free) with
// its plan limit, and zero usage, matching the COALESCE fallback in both
// StandingFor's and ownerStanding's queries.
func TestStandingForDefaultsWhenNoSubscriptionRow(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	svc := New(database)
	ctx := context.Background()

	const userID = 999903
	makeTestUser(t, conn, userID, "quota-no-sub@example.com")

	st, err := svc.StandingFor(ctx, userID)
	if err != nil {
		t.Fatalf("StandingFor: %v", err)
	}
	if st.Tier != DefaultTier {
		t.Errorf("Tier for a user with no subscriptions row = %q, want %q (DefaultTier)", st.Tier, DefaultTier)
	}
	wantPlan := PlanFor(DefaultTier)
	if st.PlanName != wantPlan.Name {
		t.Errorf("PlanName = %q, want %q", st.PlanName, wantPlan.Name)
	}
	if st.Limit != wantPlan.MonthlyPrompts {
		t.Errorf("Limit = %d, want %d (no per-user override, so the plan's own value)", st.Limit, wantPlan.MonthlyPrompts)
	}
	if st.Used != 0 {
		t.Errorf("Used for a brand-new user = %d, want 0", st.Used)
	}
	if !st.PeriodEnd.After(st.PeriodStart) {
		t.Errorf("PeriodEnd (%v) should be after PeriodStart (%v)", st.PeriodEnd, st.PeriodStart)
	}
}

// TestStandingForReflectsSetTier covers admin.go's SetTier upsert together
// with quota.go's StandingFor read path: after SetTier(userID, TierFree),
// StandingFor must report that tier (the only tier plans currently defines,
// but the read/write roundtrip is what's under test here, not the catalog).
func TestStandingForReflectsSetTier(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	svc := New(database)
	ctx := context.Background()

	const userID = 999904
	makeTestUser(t, conn, userID, "quota-set-tier-read@example.com")

	if err := svc.SetTier(ctx, userID, TierFree); err != nil {
		t.Fatalf("SetTier: %v", err)
	}

	st, err := svc.StandingFor(ctx, userID)
	if err != nil {
		t.Fatalf("StandingFor: %v", err)
	}
	if st.Tier != TierFree {
		t.Errorf("Tier after SetTier(TierFree) = %q, want %q", st.Tier, TierFree)
	}
}

// TestSetTierUpsertsOnConflict pins SetTier's ON CONFLICT (user_id) DO
// UPDATE semantics: calling it twice with different tiers must leave the
// second value in effect, not error on the row already existing and not
// silently keep the first value.
func TestSetTierUpsertsOnConflict(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	svc := New(database)
	ctx := context.Background()

	const userID = 999905
	makeTestUser(t, conn, userID, "quota-upsert@example.com")

	// plans only defines TierFree today, but SetTier's validation
	// (if _, ok := plans[tier]; !ok) is against that same map, so calling it
	// twice with the one defined tier still proves the upsert path runs
	// twice without erroring "already exists" and leaves a single row.
	if err := svc.SetTier(ctx, userID, TierFree); err != nil {
		t.Fatalf("first SetTier: %v", err)
	}
	if err := svc.SetTier(ctx, userID, TierFree); err != nil {
		t.Fatalf("second SetTier (must upsert, not conflict-error): %v", err)
	}

	var n int
	if err := conn.QueryRow(`SELECT count(*) FROM subscriptions WHERE user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatalf("count subscriptions rows: %v", err)
	}
	if n != 1 {
		t.Errorf("subscriptions rows for user after two SetTier calls = %d, want 1 (upsert, not insert-again)", n)
	}

	st, err := svc.StandingFor(ctx, userID)
	if err != nil {
		t.Fatalf("StandingFor: %v", err)
	}
	if st.Tier != TierFree {
		t.Errorf("Tier after second SetTier = %q, want %q", st.Tier, TierFree)
	}

	// An unknown tier must be rejected rather than silently stored (see
	// SetTier's doc comment) and must not disturb the existing row.
	if err := svc.SetTier(ctx, userID, Tier("nonexistent-tier")); err == nil {
		t.Error("SetTier with an unknown tier returned nil error, want a rejection")
	}
	st2, err := svc.StandingFor(ctx, userID)
	if err != nil {
		t.Fatalf("StandingFor after rejected SetTier: %v", err)
	}
	if st2.Tier != TierFree {
		t.Errorf("Tier changed after a rejected SetTier call: got %q, want unchanged %q", st2.Tier, TierFree)
	}
}

// TestCountUsersAndListUsers covers admin.go's two read endpoints together:
// CountUsers' delta across creating known test users (never an absolute
// count, since the database may hold unrelated real data), and ListUsers
// surfacing those users with correct field values.
func TestCountUsersAndListUsers(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	conn := sqlDB
	svc := New(database)
	ctx := context.Background()

	before, err := svc.CountUsers(ctx)
	if err != nil {
		t.Fatalf("CountUsers (before): %v", err)
	}

	const userA = 999906
	const userB = 999907
	makeTestUser(t, conn, userA, "quota-list-a@example.com")
	makeTestUser(t, conn, userB, "quota-list-b@example.com")

	// Give userB a non-default tier and an app with recorded usage, so
	// ListUsers' join and its per-row usageSince call are both exercised
	// with non-trivial values. started_at is backdated for the same reason
	// TestRecordIsIdempotentThroughThePackage backdates it: with no
	// subscriptions row (or one whose started_at is "now" at query time),
	// the period boundary can land after the usage rows just recorded and
	// exclude them by a race, not by design.
	if err := svc.SetTier(ctx, userB, TierFree); err != nil {
		t.Fatalf("SetTier for userB: %v", err)
	}
	if _, err := conn.Exec(`UPDATE subscriptions SET started_at = now() - interval '1 day' WHERE user_id = $1`, userB); err != nil {
		t.Fatalf("backdate started_at for userB: %v", err)
	}
	const appID = "quota-list-app-999907"
	makeTestApp(t, conn, appID, userB)
	if err := svc.Record(ctx, appID, "req-list-1"); err != nil {
		t.Fatalf("Record for userB: %v", err)
	}
	if err := svc.Record(ctx, appID, "req-list-2"); err != nil {
		t.Fatalf("Record for userB: %v", err)
	}

	after, err := svc.CountUsers(ctx)
	if err != nil {
		t.Fatalf("CountUsers (after): %v", err)
	}
	if got, want := after-before, 2; got != want {
		t.Errorf("CountUsers delta after creating 2 users = %d, want %d", got, want)
	}

	users, err := svc.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	var foundA, foundB *UserSummary
	for i := range users {
		switch users[i].ID {
		case userA:
			foundA = &users[i]
		case userB:
			foundB = &users[i]
		}
	}
	if foundA == nil {
		t.Fatal("ListUsers did not include userA")
	}
	if foundA.Email != "quota-list-a@example.com" {
		t.Errorf("userA Email = %q, want %q", foundA.Email, "quota-list-a@example.com")
	}
	if foundA.Tier != DefaultTier {
		t.Errorf("userA (no subscriptions row) Tier = %q, want %q", foundA.Tier, DefaultTier)
	}
	if foundA.Used != 0 {
		t.Errorf("userA Used = %d, want 0", foundA.Used)
	}
	if foundA.QuotaOverride != nil {
		t.Errorf("userA QuotaOverride = %v, want nil", foundA.QuotaOverride)
	}

	if foundB == nil {
		t.Fatal("ListUsers did not include userB")
	}
	if foundB.Email != "quota-list-b@example.com" {
		t.Errorf("userB Email = %q, want %q", foundB.Email, "quota-list-b@example.com")
	}
	if foundB.Tier != TierFree {
		t.Errorf("userB Tier = %q, want %q", foundB.Tier, TierFree)
	}
	if foundB.Used != 2 {
		t.Errorf("userB Used = %d, want 2 (two distinct Record calls)", foundB.Used)
	}
	wantLimit := PlanFor(TierFree).MonthlyPrompts
	if foundB.Limit != wantLimit {
		t.Errorf("userB Limit = %d, want %d", foundB.Limit, wantLimit)
	}
}
