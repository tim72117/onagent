//go:build integration

// Integration tests for Handler.listNotifications/updateNotification
// against a live Postgres — these depend on real toolschema.Registry
// (for OwnedBy) and notify.GormNotificationStore, so a fake store would
// only prove the handler calls its dependencies correctly, not that the
// combination actually enforces cross-app ownership boundaries the way a
// real caller depends on. Mirrors playground_integration_test.go's own
// makeTestUser/openTestDB conventions.
package console

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/tim72117/onagent/internal/notify"
	"github.com/tim72117/onagent/internal/session"
	"github.com/tim72117/onagent/internal/toolschema"
)

func newPatchNotificationRequest(id, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPatch, "/console/notifications/"+id, strings.NewReader(body))
	r.SetPathValue("id", id)
	return r
}

// TestListNotifications_ReturnsOnlyOwnedAppsAcrossMultipleApps confirms
// the cross-app merge this handler exists for: a user who owns two apps
// sees both apps' notifications combined into one list, and never sees a
// notification belonging to an app they don't own.
func TestListNotifications_ReturnsOnlyOwnedAppsAcrossMultipleApps(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999820
	const otherOwnerID = 999821
	const appA = "test-console-notify-app-a"
	const appB = "test-console-notify-app-b"
	const appOther = "test-console-notify-app-other-owner"
	makeTestUser(t, sqlDB, ownerID, "console-notify-owner@example.com")
	makeTestUser(t, sqlDB, otherOwnerID, "console-notify-other@example.com")
	makeTestApp(t, database, appA, ownerID)
	makeTestApp(t, database, appB, ownerID)
	makeTestApp(t, database, appOther, otherOwnerID)

	store := notify.NewGormNotificationStore(database)
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id IN ($1, $2, $3)`, appA, appB, appOther)
	})
	if err := store.Insert(notify.Notification{SubjectID: appA, RuleName: "r", Title: "From A", Body: "b"}); err != nil {
		t.Fatalf("seed appA notification: %v", err)
	}
	if err := store.Insert(notify.Notification{SubjectID: appB, RuleName: "r", Title: "From B", Body: "b"}); err != nil {
		t.Fatalf("seed appB notification: %v", err)
	}
	if err := store.Insert(notify.Notification{SubjectID: appOther, RuleName: "r", Title: "From other owner", Body: "b"}); err != nil {
		t.Fatalf("seed appOther notification: %v", err)
	}

	apps, err := toolschema.NewRegistry(database)
	if err != nil {
		t.Fatalf("toolschema.NewRegistry: %v", err)
	}
	h := &Handler{Apps: apps, Notify: store}
	user := &session.User{ID: ownerID}

	rec := httptest.NewRecorder()
	h.listNotifications(rec, httptest.NewRequest(http.MethodGet, "/console/notifications", nil), user)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "From A") || !strings.Contains(body, "From B") {
		t.Errorf("response missing owned apps' notifications: %s", body)
	}
	if strings.Contains(body, "From other owner") {
		t.Errorf("response leaked another owner's notification: %s", body)
	}
}

// TestListNotifications_NilNotifyReturns404 confirms the field's own
// documented "no meaningful disabled fallback" behavior actually 404s
// rather than panicking on a nil h.Notify.
func TestListNotifications_NilNotifyReturns404(t *testing.T) {
	apps, err := toolschema.NewRegistry(openTestDB(t))
	if err != nil {
		t.Fatalf("toolschema.NewRegistry: %v", err)
	}
	h := &Handler{Apps: apps}
	user := &session.User{ID: 1}

	rec := httptest.NewRecorder()
	h.listNotifications(rec, httptest.NewRequest(http.MethodGet, "/console/notifications", nil), user)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

// TestUpdateNotification_TransitionsStatus confirms the full path: an
// owner can mark their own app's notification completed, and the change
// is visible through a subsequent listNotifications call.
func TestUpdateNotification_TransitionsStatus(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const ownerID = 999822
	const appID = "test-console-notify-update-app"
	makeTestUser(t, sqlDB, ownerID, "console-notify-update@example.com")
	makeTestApp(t, database, appID, ownerID)

	store := notify.NewGormNotificationStore(database)
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})
	if err := store.Insert(notify.Notification{SubjectID: appID, RuleName: "r", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("seed notification: %v", err)
	}
	records, err := store.ListForSubjects([]string{appID})
	if err != nil || len(records) != 1 {
		t.Fatalf("seed lookup: %v, %v", records, err)
	}
	id := records[0].ID

	apps, err := toolschema.NewRegistry(database)
	if err != nil {
		t.Fatalf("toolschema.NewRegistry: %v", err)
	}
	h := &Handler{Apps: apps, Notify: store}
	user := &session.User{ID: ownerID}

	rec := httptest.NewRecorder()
	h.updateNotification(rec, newPatchNotificationRequest(strconv.FormatInt(id, 10), `{"status":"completed"}`), user)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d, body: %s", rec.Code, http.StatusNoContent, rec.Body.String())
	}

	records, err = store.ListForSubjects([]string{appID})
	if err != nil || len(records) != 1 {
		t.Fatalf("post-update lookup: %v, %v", records, err)
	}
	if records[0].Status != "completed" {
		t.Errorf("Status = %q, want %q", records[0].Status, "completed")
	}
}

// TestUpdateNotification_RejectsUpdatingAnotherOwnersNotification is the
// cross-tenant boundary this handler exists to enforce: a user cannot
// mark another user's app's notification as completed/dismissed just by
// guessing/knowing its numeric id.
func TestUpdateNotification_RejectsUpdatingAnotherOwnersNotification(t *testing.T) {
	database := openTestDB(t)
	sqlDB, _ := database.DB()

	const realOwnerID = 999823
	const attackerID = 999824
	const appID = "test-console-notify-crosstenant-app"
	makeTestUser(t, sqlDB, realOwnerID, "console-notify-realowner@example.com")
	makeTestUser(t, sqlDB, attackerID, "console-notify-attacker@example.com")
	makeTestApp(t, database, appID, realOwnerID)

	store := notify.NewGormNotificationStore(database)
	t.Cleanup(func() {
		_, _ = sqlDB.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID)
	})
	if err := store.Insert(notify.Notification{SubjectID: appID, RuleName: "r", Title: "t", Body: "b"}); err != nil {
		t.Fatalf("seed notification: %v", err)
	}
	records, _ := store.ListForSubjects([]string{appID})
	id := records[0].ID

	apps, err := toolschema.NewRegistry(database)
	if err != nil {
		t.Fatalf("toolschema.NewRegistry: %v", err)
	}
	h := &Handler{Apps: apps, Notify: store}
	attacker := &session.User{ID: attackerID}

	rec := httptest.NewRecorder()
	h.updateNotification(rec, newPatchNotificationRequest(strconv.FormatInt(id, 10), `{"status":"dismissed"}`), attacker)

	if rec.Code == http.StatusNoContent {
		t.Fatal("attacker's updateNotification call succeeded against another owner's notification")
	}

	records, _ = store.ListForSubjects([]string{appID})
	if records[0].Status != "pending" {
		t.Errorf("notification Status = %q after rejected cross-tenant update attempt, want unchanged %q", records[0].Status, "pending")
	}
}
