//go:build integration

// Integration tests for feedback against a live Postgres. Excluded from the
// default build; run with:
//
//	go test -tags integration ./internal/feedback/ \
//	  -args -dsn "postgres://platform:platform@localhost:5436/platform?sslmode=disable"
package feedback

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

func makeTestUser(t *testing.T, conn *sql.DB, id int64, email string) {
	t.Helper()
	if _, err := conn.Exec(
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, id, email,
	); err != nil {
		t.Fatalf("insert test user %d: %v", id, err)
	}
	t.Cleanup(func() {
		conn.Exec(`DELETE FROM feedback WHERE user_id = $1`, id)
		if _, err := conn.Exec(`DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Errorf("cleanup user %d: %v", id, err)
		}
	})
}

func makeTestApp(t *testing.T, conn *sql.DB, appID string, ownerID int64) {
	t.Helper()
	if _, err := conn.Exec(`INSERT INTO apps (app_id, owner_id) VALUES ($1, $2)`, appID, ownerID); err != nil {
		t.Fatalf("insert test app %s: %v", appID, err)
	}
	t.Cleanup(func() { conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID) })
}

func TestSubmitAndRead(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999950
	const appID = "feedback-submit-app"
	makeTestUser(t, conn, userID, "feedback-submit@example.com")
	makeTestApp(t, conn, appID, userID)

	if err := store.Submit(ctx, appID, userID, "Agent thought", "  The thought editor loses my cursor  "); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	got, err := store.Recent(ctx, 50)
	if err != nil {
		t.Fatalf("Recent: %v", err)
	}
	var found *Entry
	for i := range got {
		if got[i].UserID != nil && *got[i].UserID == userID {
			found = &got[i]
			break
		}
	}
	if found == nil {
		t.Fatal("the submitted message is not in Recent")
	}
	if found.Message != "The thought editor loses my cursor" {
		t.Errorf("Message = %q, want it trimmed", found.Message)
	}
	if found.CardTitle != "Agent thought" {
		t.Errorf("CardTitle = %q, want the card it was opened from", found.CardTitle)
	}
	if found.AppID == nil || *found.AppID != appID {
		t.Error("AppID did not survive the round trip")
	}
}

// TestSubmitAppends is the difference from usecase: a second message is a
// second thing somebody said, not a correction of the first.
func TestSubmitAppends(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999951
	makeTestUser(t, conn, userID, "feedback-append@example.com")

	for _, m := range []string{"First thought", "Second, unrelated thought"} {
		if err := store.Submit(ctx, "", userID, "", m); err != nil {
			t.Fatalf("Submit %q: %v", m, err)
		}
	}

	var rows int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM feedback WHERE user_id = $1`, userID).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != 2 {
		t.Errorf("rows = %d, want 2 — feedback accumulates rather than replacing", rows)
	}
}

// TestSurvivesTheAppItCameFrom: the message stays readable after its app is
// deleted, which is often exactly when it is most worth reading.
func TestSurvivesTheAppItCameFrom(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999952
	const appID = "feedback-doomed-app"
	makeTestUser(t, conn, userID, "feedback-survive@example.com")
	makeTestApp(t, conn, appID, userID)

	if err := store.Submit(ctx, appID, userID, "", "This app is impossible to configure"); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if _, err := conn.Exec(`DELETE FROM apps WHERE app_id = $1`, appID); err != nil {
		t.Fatalf("delete app: %v", err)
	}

	var message string
	var storedAppID *string
	if err := conn.QueryRow(
		`SELECT message, app_id FROM feedback WHERE user_id = $1`, userID,
	).Scan(&message, &storedAppID); err != nil {
		t.Fatalf("the feedback did not survive its app being deleted: %v", err)
	}
	if message != "This app is impossible to configure" {
		t.Errorf("Message = %q", message)
	}
	if storedAppID != nil {
		t.Errorf("app_id = %q, want NULL once the app is gone", *storedAppID)
	}
}

func TestSubmitRejectsBadInput(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999953
	makeTestUser(t, conn, userID, "feedback-invalid@example.com")

	cases := []struct {
		name            string
		cardTitle, body string
	}{
		{"empty message", "", ""},
		{"whitespace-only message", "", "   \n "},
		{"over-long message", "", strings.Repeat("x", maxMessage+1)},
		{"over-long card title", strings.Repeat("x", maxCardTitle+1), "Something"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := store.Submit(ctx, "", userID, tc.cardTitle, tc.body)
			if err == nil {
				t.Fatal("Submit accepted invalid input, want an error")
			}
			// The HTTP layer answers 400 only for ErrInvalid; anything else
			// is reported as a server fault.
			if !errors.Is(err, ErrInvalid) {
				t.Errorf("error does not wrap ErrInvalid: %v", err)
			}
		})
	}

	var rows int
	conn.QueryRow(`SELECT COUNT(*) FROM feedback WHERE user_id = $1`, userID).Scan(&rows)
	if rows != 0 {
		t.Errorf("rows = %d after only-invalid submits, want 0", rows)
	}
}

// TestLimitsCountCharactersNotBytes: the same rune-vs-byte guard usecase
// needs, for the same reason — zh-Hant is a shipped locale and this is a
// free-text box.
func TestLimitsCountCharactersNotBytes(t *testing.T) {
	store, conn := openTestDB(t)
	ctx := context.Background()

	const userID = 999954
	makeTestUser(t, conn, userID, "feedback-multibyte@example.com")

	message := strings.Repeat("回", maxMessage-1)
	if len(message) <= maxMessage {
		t.Fatalf("test setup: %d bytes is not over the %d-byte mark this guards", len(message), maxMessage)
	}
	if err := store.Submit(ctx, "", userID, "", message); err != nil {
		t.Fatalf("Submit rejected a message within the character limit: %v", err)
	}
}

// TestDatabaseErrorsAreNotInvalidInput pins the split the HTTP layer relies
// on: a foreign-key violation is ours, not the caller's.
func TestDatabaseErrorsAreNotInvalidInput(t *testing.T) {
	store, _ := openTestDB(t)

	err := store.Submit(context.Background(), "", 999999999, "", "Something")
	if err == nil {
		t.Fatal("Submit for a nonexistent user succeeded, want a foreign-key error")
	}
	if errors.Is(err, ErrInvalid) {
		t.Errorf("a database error was classed as invalid input: %v", err)
	}
}
