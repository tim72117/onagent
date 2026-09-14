//go:build integration

// Integration tests for usecase against a live Postgres. Excluded from the
// default build; run with:
//
//	go test -tags integration ./internal/usecase/ \
//	  -args -dsn "postgres://platform:platform@localhost:5436/platform?sslmode=disable"
package usecase

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/db"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5436/platform?sslmode=disable", "Postgres DSN")

func openTestDB(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	conn, err := database.DB()
	if err != nil {
		t.Fatalf("db handle: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return New(database), conn
}

// makeTestUser inserts a throwaway user and registers its cleanup. Deleting
// the user CASCADEs to use_case_responses (see schema.sql), so this single
// cleanup removes the answers too.
func makeTestUser(t *testing.T, conn *sql.DB, id int64, email string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, id, email,
	); err != nil {
		t.Fatalf("insert test user %d: %v", id, err)
	}
	t.Cleanup(func() {
		if _, err := conn.Exec(`DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup user %d: %v", id, err)
		}
	})
}

func TestSaveAndGet(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999930
	makeTestUser(t, conn, userID, "usecase-save@example.com")

	// Nothing stored yet: ok=false, not an error — "hasn't answered" is a
	// normal state the console asks about on every load.
	if _, ok, err := store.Get(ctx, userID); err != nil || ok {
		t.Fatalf("Get before save = ok %v, err %v; want ok=false, no error", ok, err)
	}

	want := Response{
		Domain:       "Booking services (salon, clinic, gym)",
		Goal:         "Let customers check availability and book by just saying so",
		HandledToday: "Staff answering the phone",
	}
	if err := store.Save(ctx, userID, want); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, ok, err := store.Get(ctx, userID)
	if err != nil || !ok {
		t.Fatalf("Get after save = ok %v, err %v; want ok=true", ok, err)
	}
	if got.Domain != want.Domain || got.Goal != want.Goal || got.HandledToday != want.HandledToday {
		t.Errorf("round-trip mismatch:\n got %+v\nwant %+v", got, want)
	}
	if got.UpdatedAt.IsZero() {
		t.Error("UpdatedAt is zero, want the write time")
	}
}

// TestSaveReplacesRatherThanAccumulating pins the one-row-per-user design:
// someone refining their answer must end up with one current answer, not two
// rows nobody can reconcile.
func TestSaveReplacesRatherThanAccumulating(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999931
	makeTestUser(t, conn, userID, "usecase-replace@example.com")

	if err := store.Save(ctx, userID, Response{Domain: "Education / courses", Goal: "Answer course questions"}); err != nil {
		t.Fatalf("first Save: %v", err)
	}
	if err := store.Save(ctx, userID, Response{Domain: "SaaS / developer tools", Goal: "Help users configure webhooks"}); err != nil {
		t.Fatalf("second Save: %v", err)
	}

	var rows int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM use_case_responses WHERE user_id = $1`, userID).Scan(&rows); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if rows != 1 {
		t.Errorf("rows = %d, want exactly 1 — re-submitting must replace", rows)
	}

	got, _, err := store.Get(ctx, userID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Domain != "SaaS / developer tools" {
		t.Errorf("Domain = %q, want the second answer to win", got.Domain)
	}

	// created_at keeps the FIRST submission's time even though the answer
	// changed — that is what makes "when did this user first tell us
	// anything" answerable later.
	var createdBeforeUpdated bool
	if err := conn.QueryRow(
		`SELECT created_at < updated_at FROM use_case_responses WHERE user_id = $1`, userID,
	).Scan(&createdBeforeUpdated); err != nil {
		t.Fatalf("compare timestamps: %v", err)
	}
	if !createdBeforeUpdated {
		t.Error("created_at was overwritten on update, want the original kept")
	}
}

// TestOptionalAnswerStaysDistinguishable: skipping the third question must
// not look identical to answering it with an empty string.
func TestOptionalAnswerStaysDistinguishable(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999932
	makeTestUser(t, conn, userID, "usecase-optional@example.com")

	if err := store.Save(ctx, userID, Response{
		Domain: "Personal project / still exploring",
		Goal:   "Still working out what I want it to do",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	var handledToday *string
	if err := conn.QueryRow(
		`SELECT handled_today FROM use_case_responses WHERE user_id = $1`, userID,
	).Scan(&handledToday); err != nil {
		t.Fatalf("read handled_today: %v", err)
	}
	if handledToday != nil {
		t.Errorf("handled_today = %q, want NULL for a skipped optional answer", *handledToday)
	}

	// It still reads back as an empty string through the Go API, so callers
	// need no nil handling of their own.
	got, _, err := store.Get(ctx, userID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.HandledToday != "" {
		t.Errorf("HandledToday = %q, want empty string", got.HandledToday)
	}
}

func TestSaveRejectsBadInput(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999933
	makeTestUser(t, conn, userID, "usecase-invalid@example.com")

	cases := []struct {
		name string
		in   Response
	}{
		{"no domain", Response{Goal: "Something"}},
		{"no goal", Response{Domain: "Finance / insurance"}},
		{"whitespace-only domain", Response{Domain: "   ", Goal: "Something"}},
		{"whitespace-only goal", Response{Domain: "Finance / insurance", Goal: "  \n "}},
		{"over-long domain", Response{Domain: strings.Repeat("x", maxDomain+1), Goal: "Something"}},
		{"over-long goal", Response{Domain: "Finance / insurance", Goal: strings.Repeat("x", maxGoal+1)}},
		// The optional field has a cap too — the one most likely to be dropped
		// in a refactor, precisely because skipping it is valid.
		{"over-long handledToday", Response{
			Domain:       "Finance / insurance",
			Goal:         "Something",
			HandledToday: strings.Repeat("x", maxToday+1),
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := store.Save(ctx, userID, tc.in); err == nil {
				t.Error("Save accepted invalid input, want an error")
			}
		})
	}

	// None of the rejected attempts left anything behind.
	var rows int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM use_case_responses WHERE user_id = $1`, userID).Scan(&rows); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if rows != 0 {
		t.Errorf("rows = %d after only-invalid saves, want 0", rows)
	}
}

// TestSaveTrimsWhitespace: the console sends whatever was typed, so the
// store is what guarantees a stray trailing newline doesn't become part of
// the stored answer.
func TestSaveTrimsWhitespace(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999934
	makeTestUser(t, conn, userID, "usecase-trim@example.com")

	if err := store.Save(ctx, userID, Response{
		Domain:       "  Other  ",
		Goal:         "\n Logistics dispatch \n",
		HandledToday: "   ",
	}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, _, err := store.Get(ctx, userID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Domain != "Other" {
		t.Errorf("Domain = %q, want it trimmed", got.Domain)
	}
	if got.Goal != "Logistics dispatch" {
		t.Errorf("Goal = %q, want it trimmed", got.Goal)
	}
	// A whitespace-only optional answer is the same as skipping it.
	if got.HandledToday != "" {
		t.Errorf("HandledToday = %q, want empty for a whitespace-only answer", got.HandledToday)
	}
}

// TestLimitsCountCharactersNotBytes is the regression guard for the caps
// being measured in runes. Under byte counting a Traditional Chinese answer
// is refused at roughly a third of the advertised limit, and the rejection
// quotes a character count the user can see is wrong — 41 characters
// reported as "longer than 120 characters".
//
// zh-Hant is a shipped locale (apps/landing/zh-tw/ exists) and the "Other"
// free-text box is exactly where non-ASCII arrives, so this is the realistic
// case rather than an exotic one.
func TestLimitsCountCharactersNotBytes(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999935
	makeTestUser(t, conn, userID, "usecase-multibyte@example.com")

	// Every character here is 3 bytes in UTF-8, so this is well past
	// maxDomain as a byte count while being comfortably under it as
	// characters.
	domain := strings.Repeat("預", maxDomain-1)
	if got := len(domain); got <= maxDomain {
		t.Fatalf("test setup: %d bytes is not over the %d-byte mark this guards", got, maxDomain)
	}

	if err := store.Save(ctx, userID, Response{
		Domain: domain,
		Goal:   strings.Repeat("約", maxGoal-1),
	}); err != nil {
		t.Fatalf("Save rejected an answer that is within the character limits: %v", err)
	}

	got, ok, err := store.Get(ctx, userID)
	if err != nil || !ok {
		t.Fatalf("Get: ok %v, err %v", ok, err)
	}
	if got.Domain != domain {
		t.Error("stored domain differs from what was sent")
	}

	// One character over is still refused, so the cap is real and not just
	// relaxed.
	if err := store.Save(ctx, userID, Response{
		Domain: strings.Repeat("預", maxDomain+1),
		Goal:   "Something",
	}); err == nil {
		t.Error("Save accepted a domain over the character limit, want it refused")
	}
}

// TestValidationErrorsAreDistinguishable pins the split the HTTP layer
// depends on: only a caller mistake carries ErrInvalid, so a database
// failure cannot be reported to the user as bad input (and stay invisible in
// the 5xx rate).
func TestValidationErrorsAreDistinguishable(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999936
	makeTestUser(t, conn, userID, "usecase-errkind@example.com")

	err := store.Save(ctx, userID, Response{Goal: "Something"})
	if !errors.Is(err, ErrInvalid) {
		t.Errorf("missing domain gave %v, want it to wrap ErrInvalid", err)
	}

	// A save against a user that does not exist violates the foreign key —
	// an infrastructure failure, not the shape of the body, so it must NOT
	// be classed as the caller's mistake.
	err = store.Save(ctx, 999999999, Response{Domain: "Other", Goal: "Something"})
	if err == nil {
		t.Fatal("Save against a nonexistent user succeeded, want a foreign-key error")
	}
	if errors.Is(err, ErrInvalid) {
		t.Errorf("a database error was classed as invalid input: %v", err)
	}
}
