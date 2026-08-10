//go:build integration

// Integration tests for usertoken against a live Postgres. These pin down
// the CURRENT database/sql implementation's behavior before it is rewritten
// onto GORM, so a future rewrite that silently changes behavior (e.g. makes
// Verify's fire-and-forget last_used_at update propagate an error, or makes
// Revoke drop its user_id scoping) fails this test rather than shipping.
//
// Excluded from the default build; run with:
//
//	go test -tags integration ./internal/usertoken/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
package usertoken

import (
	"flag"
	"net/http"
	"testing"

	"github.com/tim72117/onagent/internal/db"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

func TestUserTokenLifecycle(t *testing.T) {
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v)", *dsn, err)
	}
	defer func() { if sqlDB, err := database.DB(); err == nil { sqlDB.Close() } }()
	sqlDB, _ := database.DB()
	conn := sqlDB

	const (
		userAID    = 999901
		userBID    = 999902
		userAEmail = "usertoken-integ-a@example.com"
		userBEmail = "usertoken-integ-b@example.com"
	)

	cleanup := func() {
		_, _ = conn.Exec(`DELETE FROM users WHERE id IN ($1, $2)`, userAID, userBID)
	}
	cleanup() // clean slate in case a previous run left rows behind
	t.Cleanup(cleanup)

	if _, err := conn.Exec(
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
		userAID, userAEmail,
	); err != nil {
		t.Fatalf("seed user A: %v", err)
	}
	if _, err := conn.Exec(
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
		userBID, userBEmail,
	); err != nil {
		t.Fatalf("seed user B: %v", err)
	}
	// user_tokens rows cascade-delete with their owning user, so nothing
	// extra is needed to clean those up.

	store := New(database)

	// --- 1. Basic CRUD flow: Issue -> Verify -> List ---------------------

	tokenID, plaintext, err := store.Issue(userAID, "laptop")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if tokenID == 0 {
		t.Fatal("Issue returned id=0")
	}
	if plaintext == "" {
		t.Fatal("Issue returned empty plaintext")
	}

	// List before any Verify: LastUsedAt must still be nil/unset.
	list, err := store.List(userAID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("List(userA) = %d tokens, want 1", len(list))
	}
	if list[0].ID != tokenID {
		t.Errorf("listed token id = %d, want %d", list[0].ID, tokenID)
	}
	if list[0].Name != "laptop" {
		t.Errorf("listed token name = %q, want %q", list[0].Name, "laptop")
	}
	if list[0].LastUsedAt != nil {
		t.Errorf("freshly issued token LastUsedAt = %v, want nil (not yet verified)", list[0].LastUsedAt)
	}

	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+plaintext)
	user, ok := store.Verify(req)
	if !ok {
		t.Fatal("Verify(valid token) returned ok=false")
	}
	if user.ID != userAID {
		t.Errorf("Verify resolved userID = %d, want %d", user.ID, userAID)
	}
	if user.Email != userAEmail {
		t.Errorf("Verify resolved email = %q, want %q", user.Email, userAEmail)
	}

	// --- 2. Verify's fire-and-forget last_used_at update ------------------
	//
	// The Verify call just above already returned ok=true — that success
	// did not wait on or depend on the last_used_at touch succeeding, which
	// is exactly the fire-and-forget contract a GORM rewrite could
	// accidentally break by making the update's error propagate into
	// Verify's return. Now confirm the side effect actually landed: List
	// must show a non-nil LastUsedAt where it was nil before.
	list2, err := store.List(userAID)
	if err != nil {
		t.Fatalf("List after Verify: %v", err)
	}
	if len(list2) != 1 {
		t.Fatalf("List(userA) after Verify = %d tokens, want 1", len(list2))
	}
	if list2[0].LastUsedAt == nil {
		t.Error("LastUsedAt still nil after a successful Verify; fire-and-forget update did not land")
	}

	// --- 3. Revoke's compound (id, user_id) protection, plus 4. plaintext
	// uniqueness across Issue calls ------------------------------------

	tokenBID, plaintextB, err := store.Issue(userBID, "phone")
	if err != nil {
		t.Fatalf("Issue for user B: %v", err)
	}
	if plaintextB == plaintext {
		t.Error("two Issue calls produced the same plaintext token")
	}

	// userA attempts to revoke userB's token by id. Revoke's DELETE is
	// scoped by "WHERE id = $1 AND user_id = $2", so this matches zero rows
	// and, per the current implementation, returns nil error (not an error)
	// — it's a silent no-op, not a failure. The load-bearing assertion is
	// simply that tokenB survives.
	if err := store.Revoke(userAID, tokenBID); err != nil {
		t.Fatalf("cross-user Revoke returned an error (current impl treats a zero-row delete as success): %v", err)
	}

	listB, err := store.List(userBID)
	if err != nil {
		t.Fatalf("List(userB) after cross-user revoke attempt: %v", err)
	}
	if len(listB) != 1 || listB[0].ID != tokenBID {
		t.Fatalf("userB's token was removed by userA's cross-user Revoke call — user_id scoping regressed; List(userB) = %+v", listB)
	}

	// Now the rightful owner revokes it: this must actually delete the row.
	if err := store.Revoke(userBID, tokenBID); err != nil {
		t.Fatalf("owner Revoke: %v", err)
	}
	listB2, err := store.List(userBID)
	if err != nil {
		t.Fatalf("List(userB) after owner revoke: %v", err)
	}
	if len(listB2) != 0 {
		t.Fatalf("List(userB) after owner Revoke = %d tokens, want 0", len(listB2))
	}

	// --- 5. Verify rejects an unknown/garbage token -----------------------

	badReq, _ := http.NewRequest("GET", "/", nil)
	badReq.Header.Set("Authorization", "Bearer onagent_this-token-was-never-issued")
	if _, ok := store.Verify(badReq); ok {
		t.Error("Verify(unknown token) returned ok=true, want false")
	}

	noAuthReq, _ := http.NewRequest("GET", "/", nil)
	if _, ok := store.Verify(noAuthReq); ok {
		t.Error("Verify(no Authorization header) returned ok=true, want false")
	}
}
