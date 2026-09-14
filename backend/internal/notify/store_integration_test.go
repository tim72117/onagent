//go:build integration

// Integration tests for notify's GORM-backed stores against a live
// Postgres. Excluded from the default build; run with:
//
//	go test -tags integration ./internal/notify/ \
//	  -args -dsn "postgres://platform:platform@localhost:5434/platform?sslmode=disable"
//
// Mirrors internal/toolschema's own openTestDB pattern (skip, not fail,
// when Postgres isn't reachable).
package notify

import (
	"flag"
	"sync"
	"testing"

	"github.com/tim72117/onagent/internal/db"
	"gorm.io/gorm"
)

var dsn = flag.String("dsn", "postgres://platform:platform@localhost:5434/platform?sslmode=disable", "Postgres DSN")

func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	database, err := db.Open(*dsn)
	if err != nil {
		t.Skipf("no reachable Postgres at %s (%v) — skipping integration test", *dsn, err)
	}
	t.Cleanup(func() {
		if sqlDB, err := database.DB(); err == nil {
			sqlDB.Close()
		}
	})
	return database
}

func TestGormNotificationStore_Insert(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const subjectID = "test-notify-store-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, subjectID)
	})

	store := NewGormNotificationStore(database)

	if err := store.Insert(Notification{
		SubjectID:    subjectID,
		RuleName:     "test_rule",
		Title:        "Hello",
		Body:         "World",
		ActionLabel:  "Do it →",
		ActionTarget: "/somewhere",
	}); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	var rows []notificationRow
	if err := database.Where("subject_id = ?", subjectID).Find(&rows).Error; err != nil {
		t.Fatalf("query inserted row: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1", len(rows))
	}
	row := rows[0]
	if row.Title != "Hello" || row.Body != "World" || row.RuleName != "test_rule" || row.Status != "pending" {
		t.Errorf("row = %+v, unexpected", row)
	}
	if row.ActionLabel == nil || *row.ActionLabel != "Do it →" {
		t.Errorf("row.ActionLabel = %v, want \"Do it →\"", row.ActionLabel)
	}
}

func TestGormNotificationStore_Insert_NoActionLeavesActionColumnsNull(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const subjectID = "test-notify-store-noaction-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, subjectID)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{SubjectID: subjectID, RuleName: "r", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	var row notificationRow
	if err := database.Where("subject_id = ?", subjectID).First(&row).Error; err != nil {
		t.Fatalf("query inserted row: %v", err)
	}
	if row.ActionLabel != nil || row.ActionTarget != nil {
		t.Errorf("ActionLabel/ActionTarget = %v/%v, want both nil", row.ActionLabel, row.ActionTarget)
	}
}

func TestGormProgressStore_MarkDone_CompletesOnlyAfterBothSides(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const subjectID = "test-progress-app"
	const ruleName = "test_pair_rule"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM rule_progress WHERE subject_id = $1 AND rule_name = $2`, subjectID, ruleName)
	})

	store := NewGormProgressStore(database)

	completed, err := store.MarkDone(subjectID, ruleName, "a")
	if err != nil {
		t.Fatalf("MarkDone(a): %v", err)
	}
	if completed {
		t.Fatal("MarkDone(a) reported completed after only side A — want false")
	}

	completed, err = store.MarkDone(subjectID, ruleName, "b")
	if err != nil {
		t.Fatalf("MarkDone(b): %v", err)
	}
	if !completed {
		t.Fatal("MarkDone(b) reported not completed after both sides — want true")
	}
}

func TestGormProgressStore_MarkDone_FiresExactlyOnceForRepeatedCalls(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const subjectID = "test-progress-repeat-app"
	const ruleName = "test_pair_rule_repeat"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM rule_progress WHERE subject_id = $1 AND rule_name = $2`, subjectID, ruleName)
	})

	store := NewGormProgressStore(database)
	if _, err := store.MarkDone(subjectID, ruleName, "a"); err != nil {
		t.Fatalf("MarkDone(a): %v", err)
	}
	completed, err := store.MarkDone(subjectID, ruleName, "b")
	if err != nil || !completed {
		t.Fatalf("MarkDone(b) = (%v, %v), want (true, nil)", completed, err)
	}

	// Repeating either side afterward must never report completedNow again.
	if completed, err := store.MarkDone(subjectID, ruleName, "b"); err != nil || completed {
		t.Fatalf("repeated MarkDone(b) = (%v, %v), want (false, nil)", completed, err)
	}
	if completed, err := store.MarkDone(subjectID, ruleName, "a"); err != nil || completed {
		t.Fatalf("repeated MarkDone(a) = (%v, %v), want (false, nil)", completed, err)
	}
}

// TestGormProgressStore_MarkDone_ConcurrentSidesCompleteExactlyOnce is the
// real-world race this store exists to make safe: side A and side B
// arriving from two different HTTP requests at nearly the same instant
// must still result in exactly one completedNow=true, never zero (a
// missed notification) or two (a duplicate).
func TestGormProgressStore_MarkDone_ConcurrentSidesCompleteExactlyOnce(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const subjectID = "test-progress-race-app"
	const ruleName = "test_pair_rule_race"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM rule_progress WHERE subject_id = $1 AND rule_name = $2`, subjectID, ruleName)
	})

	store := NewGormProgressStore(database)

	var wg sync.WaitGroup
	results := make([]bool, 2)
	sides := []string{"a", "b"}
	for i := range sides {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			completed, err := store.MarkDone(subjectID, ruleName, sides[i])
			if err != nil {
				t.Errorf("MarkDone(%s): %v", sides[i], err)
				return
			}
			results[i] = completed
		}(i)
	}
	wg.Wait()

	completedCount := 0
	for _, c := range results {
		if c {
			completedCount++
		}
	}
	if completedCount != 1 {
		t.Fatalf("completedCount = %d across concurrent MarkDone(a)/MarkDone(b), want exactly 1", completedCount)
	}
}

func TestGormProgressStore_MarkDone_RejectsInvalidSide(t *testing.T) {
	database := openTestDB(t)
	store := NewGormProgressStore(database)
	if _, err := store.MarkDone("some-app", "some-rule", "c"); err == nil {
		t.Fatal("MarkDone with side=\"c\" = nil error, want an error")
	}
}

func TestGormNotificationStore_ListForSubjects(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appA = "test-notify-list-app-a"
	const appB = "test-notify-list-app-b"
	const appC = "test-notify-list-app-c-not-owned"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id IN ($1, $2, $3)`, appA, appB, appC)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{SubjectID: appA, RuleName: "r", Title: "A1", Body: "b"}); err != nil {
		t.Fatalf("Insert appA: %v", err)
	}
	if err := store.Insert(Notification{SubjectID: appB, RuleName: "r", Title: "B1", Body: "b"}); err != nil {
		t.Fatalf("Insert appB: %v", err)
	}
	if err := store.Insert(Notification{SubjectID: appC, RuleName: "r", Title: "C1 (not owned)", Body: "b"}); err != nil {
		t.Fatalf("Insert appC: %v", err)
	}

	records, err := store.ListForSubjects([]string{appA, appB})
	if err != nil {
		t.Fatalf("ListForSubjects: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("len(records) = %d, want 2 (appC must not be included)", len(records))
	}
	titles := map[string]bool{}
	for _, r := range records {
		titles[r.Title] = true
	}
	if !titles["A1"] || !titles["B1"] {
		t.Errorf("titles = %v, want A1 and B1", titles)
	}
	if titles["C1 (not owned)"] {
		t.Error("ListForSubjects returned a notification for an app not in subjectIDs")
	}
}

func TestGormNotificationStore_ListForSubjects_EmptyInputReturnsEmpty(t *testing.T) {
	database := openTestDB(t)
	store := NewGormNotificationStore(database)
	records, err := store.ListForSubjects(nil)
	if err != nil {
		t.Fatalf("ListForSubjects(nil): %v", err)
	}
	if len(records) != 0 {
		t.Fatalf("len(records) = %d, want 0 for empty subjectIDs (must not return every row in the table)", len(records))
	}
}

func TestGormNotificationStore_UpdateStatus(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appID = "test-notify-updatestatus-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{SubjectID: appID, RuleName: "r", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	records, err := store.ListForSubjects([]string{appID})
	if err != nil || len(records) != 1 {
		t.Fatalf("ListForSubjects after Insert = (%v, %v), want exactly 1 record", records, err)
	}
	id := records[0].ID

	if err := store.UpdateStatus(id, []string{appID}, "completed"); err != nil {
		t.Fatalf("UpdateStatus(completed): %v", err)
	}

	records, err = store.ListForSubjects([]string{appID})
	if err != nil || len(records) != 1 {
		t.Fatalf("ListForSubjects after UpdateStatus: %v, %v", records, err)
	}
	got := records[0]
	if got.Status != "completed" {
		t.Errorf("Status = %q, want %q", got.Status, "completed")
	}
	if got.CompletedAt == nil {
		t.Error("CompletedAt is nil after marking completed")
	}
	if got.ReadAt == nil {
		t.Error("ReadAt is nil after a status transition — acting on a notification implies having seen it")
	}
}

func TestGormNotificationStore_UpdateStatus_RejectsWrongOwner(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appID = "test-notify-updatestatus-wrongowner-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{SubjectID: appID, RuleName: "r", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	records, _ := store.ListForSubjects([]string{appID})
	id := records[0].ID

	// A caller passing an app id list that does NOT include the
	// notification's actual owner must not be able to update it.
	if err := store.UpdateStatus(id, []string{"some-other-app-entirely"}, "dismissed"); err == nil {
		t.Fatal("UpdateStatus with a non-owning subjectIDs list = nil error, want an error")
	}
}

func TestGormNotificationStore_UpdateStatus_RejectsInvalidStatus(t *testing.T) {
	database := openTestDB(t)
	store := NewGormNotificationStore(database)
	if err := store.UpdateStatus(1, []string{"some-app"}, "pending"); err == nil {
		t.Fatal("UpdateStatus with status=\"pending\" = nil error, want an error (only completed/dismissed are valid transitions)")
	}
}

func TestGormNotificationStore_MarkRead_DoesNotOverwriteExistingReadAt(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appID = "test-notify-markread-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{SubjectID: appID, RuleName: "r", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	records, _ := store.ListForSubjects([]string{appID})
	id := records[0].ID

	if err := store.MarkRead(id, []string{appID}); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	records, _ = store.ListForSubjects([]string{appID})
	firstReadAt := records[0].ReadAt
	if firstReadAt == nil {
		t.Fatal("ReadAt is nil after MarkRead")
	}

	if err := store.MarkRead(id, []string{appID}); err != nil {
		t.Fatalf("second MarkRead: %v", err)
	}
	records, _ = store.ListForSubjects([]string{appID})
	if !records[0].ReadAt.Equal(*firstReadAt) {
		t.Errorf("ReadAt changed on a second MarkRead call: was %v, now %v", firstReadAt, records[0].ReadAt)
	}
}

func TestGormNotificationStore_HasRuleFired(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appA = "test-notify-hasrulefired-app-a"
	const appB = "test-notify-hasrulefired-app-b"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id IN ($1, $2)`, appA, appB)
	})

	store := NewGormNotificationStore(database)

	fired, err := store.HasRuleFired([]string{appA, appB}, "welcome")
	if err != nil {
		t.Fatalf("HasRuleFired (before any insert): %v", err)
	}
	if fired {
		t.Fatal("HasRuleFired = true before any notification was ever inserted")
	}

	if err := store.Insert(Notification{SubjectID: appA, RuleName: "some_other_rule", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("seed unrelated rule: %v", err)
	}
	fired, err = store.HasRuleFired([]string{appA, appB}, "welcome")
	if err != nil || fired {
		t.Fatalf("HasRuleFired = (%v, %v) after inserting a DIFFERENT rule's notification, want (false, nil)", fired, err)
	}

	if err := store.Insert(Notification{SubjectID: appB, RuleName: "welcome", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("seed welcome notification: %v", err)
	}
	fired, err = store.HasRuleFired([]string{appA, appB}, "welcome")
	if err != nil || !fired {
		t.Fatalf("HasRuleFired = (%v, %v) after appB got a welcome notification, want (true, nil)", fired, err)
	}
}

func TestGormNotificationStore_HasRuleFired_IgnoresStatus(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appID = "test-notify-hasrulefired-status-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{SubjectID: appID, RuleName: "welcome", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	records, _ := store.ListForSubjects([]string{appID})
	if err := store.UpdateStatus(records[0].ID, []string{appID}, "dismissed"); err != nil {
		t.Fatalf("UpdateStatus(dismissed): %v", err)
	}

	// A dismissed welcome notification still counts as "already sent" —
	// dismissing it must never make catch_up_welcome send it again.
	fired, err := store.HasRuleFired([]string{appID}, "welcome")
	if err != nil || !fired {
		t.Fatalf("HasRuleFired = (%v, %v) for a DISMISSED welcome notification, want (true, nil)", fired, err)
	}
}

func TestGormNotificationStore_HasRuleFired_EmptyInputReturnsFalse(t *testing.T) {
	database := openTestDB(t)
	store := NewGormNotificationStore(database)
	fired, err := store.HasRuleFired(nil, "welcome")
	if err != nil || fired {
		t.Fatalf("HasRuleFired(nil, ...) = (%v, %v), want (false, nil)", fired, err)
	}
}

func TestGormNotificationStore_CompleteByActionTarget(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appID = "test-notify-completebytarget-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{
		SubjectID:    appID,
		RuleName:     "welcome",
		Title:        "Thanks for signing up",
		Body:         "b",
		ActionLabel:  "Join Builder →",
		ActionTarget: "useCaseForm",
	}); err != nil {
		t.Fatalf("Insert: %v", err)
	}

	if err := store.CompleteByActionTarget([]string{appID}, "useCaseForm"); err != nil {
		t.Fatalf("CompleteByActionTarget: %v", err)
	}

	records, err := store.ListForSubjects([]string{appID})
	if err != nil || len(records) != 1 {
		t.Fatalf("ListForSubjects: %v, %v", records, err)
	}
	got := records[0]
	if got.Status != "completed" {
		t.Errorf("Status = %q, want %q", got.Status, "completed")
	}
	if got.CompletedAt == nil {
		t.Error("CompletedAt is nil after CompleteByActionTarget")
	}
	if got.ReadAt == nil {
		t.Error("ReadAt is nil after CompleteByActionTarget — completing implies having seen it")
	}
}

// TestGormNotificationStore_CompleteByActionTarget_OnlyMatchesPending
// confirms this only ever moves 'pending' forward — a notification the
// user already dismissed must not be silently resurrected as 'completed'.
func TestGormNotificationStore_CompleteByActionTarget_OnlyMatchesPending(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()
	const appID = "test-notify-completebytarget-dismissed-app"
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})

	store := NewGormNotificationStore(database)
	if err := store.Insert(Notification{SubjectID: appID, RuleName: "welcome", Title: "t", Body: "b", ActionTarget: "useCaseForm"}); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	records, _ := store.ListForSubjects([]string{appID})
	if err := store.UpdateStatus(records[0].ID, []string{appID}, "dismissed"); err != nil {
		t.Fatalf("UpdateStatus(dismissed): %v", err)
	}

	if err := store.CompleteByActionTarget([]string{appID}, "useCaseForm"); err != nil {
		t.Fatalf("CompleteByActionTarget: %v", err)
	}

	records, _ = store.ListForSubjects([]string{appID})
	if records[0].Status != "dismissed" {
		t.Errorf("Status = %q after CompleteByActionTarget, want unchanged %q", records[0].Status, "dismissed")
	}
}

// TestGormNotificationStore_CompleteByActionTarget_NoMatchIsNotAnError
// confirms a caller with no matching pending notification (the common
// case — most usecase.submitted events won't have one) is not treated as
// a failure.
func TestGormNotificationStore_CompleteByActionTarget_NoMatchIsNotAnError(t *testing.T) {
	database := openTestDB(t)
	store := NewGormNotificationStore(database)
	if err := store.CompleteByActionTarget([]string{"no-such-app"}, "useCaseForm"); err != nil {
		t.Fatalf("CompleteByActionTarget with no match: %v, want nil", err)
	}
}

func TestGormNotificationStore_CompleteByActionTarget_EmptyInputIsANoOp(t *testing.T) {
	database := openTestDB(t)
	store := NewGormNotificationStore(database)
	if err := store.CompleteByActionTarget(nil, "useCaseForm"); err != nil {
		t.Fatalf("CompleteByActionTarget(nil, ...): %v, want nil", err)
	}
	if err := store.CompleteByActionTarget([]string{"some-app"}, ""); err != nil {
		t.Fatalf("CompleteByActionTarget(..., \"\"): %v, want nil", err)
	}
}
