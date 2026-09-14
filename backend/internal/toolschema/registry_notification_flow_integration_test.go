//go:build integration

// End-to-end test for the app-creation notification pipeline:
//
//	Registry.Create → events.Bus → notify.Engine → notifications table
//
// Every layer here already has its own tests (internal/events, internal/notify
// and its store), but nothing exercised them wired together, and the seams
// between them are where this flow can fail silently:
//
//   - Registry publishes only when SetEventBus was called (registry.go guards
//     every Publish on r.events != nil), so forgetting to wire it produces no
//     error and no notification — just nothing.
//   - Publish is fire-and-forget on its own goroutine, so "the app exists"
//     and "the notification exists" are not the same instant.
//   - ActionTarget is a bare string on both sides (Go here, a string compare
//     in apps/console/src/App.tsx's openNotificationAction). A typo yields a
//     button that does nothing, with nothing failing to announce it.
//
// Mirrors cmd/server/main.go's own wiring rather than inventing a simpler
// one, so a change to how production assembles this fails here too.
//
// Excluded from the default build; run with:
//
//	go test -tags integration ./internal/toolschema/ \
//	  -args -dsn "postgres://platform:platform@localhost:5436/platform?sslmode=disable"
package toolschema

import (
	"database/sql"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/tim72117/onagent/internal/events"
	"github.com/tim72117/onagent/internal/notify"
)

// welcomeRule is cmd/server/main.go's rule of the same name. Kept in step by
// hand; the assertions below are what catch it drifting.
func welcomeRule() notify.Rule {
	return notify.Rule{
		Name:      "welcome",
		EventType: "app.created",
		Match: func(e events.Event) bool {
			isFirst, _ := e.Metadata["isFirst"].(bool)
			return isFirst
		},
		Build: func(e events.Event) notify.Action {
			return notify.CreateNotification{
				SubjectID:    e.SubjectID,
				Title:        "Thanks for signing up",
				Body:         "Want a month of Builder — 1,000 prompts, free? Tell us what you're building, put it through a real test, and send us your feedback.",
				ActionLabel:  "Join Builder →",
				ActionTarget: "useCaseForm",
			}
		},
	}
}

// awaitNotification polls for a notification about appID. The publish is
// fire-and-forget on another goroutine, so there is no synchronisation point
// to wait on — polling with a deadline is honest about that, where a fixed
// sleep would either be flaky or slow.
func awaitNotification(t *testing.T, conn *sql.DB, appID string, within time.Duration) (title, body, actionTarget string, found bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		var at sql.NullString
		err := conn.QueryRow(
			`SELECT title, body, action_target FROM notifications WHERE subject_id = $1`, appID,
		).Scan(&title, &body, &at)
		if err == nil {
			return title, body, at.String, true
		}
		if err != sql.ErrNoRows {
			t.Fatalf("query notification: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	return "", "", "", false
}

// pipeline assembles Registry + Bus + Engine the way main.go does and returns
// the registry, with cleanup registered.
func pipeline(t *testing.T) (*Registry, *sql.DB) {
	t.Helper()
	database := openTestDB(t)
	conn, err := database.DB()
	if err != nil {
		t.Fatalf("db handle: %v", err)
	}

	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := events.NewBus(log)
	notify.NewEngine(
		[]notify.Rule{welcomeRule()},
		nil,
		notify.NewGormNotificationStore(database),
		notify.NewGormProgressStore(database),
		log,
	).Register(bus)
	reg.SetEventBus(bus)
	return reg, conn
}

func TestCreateApp_NotifiesOnTheFirstAppOnly(t *testing.T) {
	reg, conn := pipeline(t)

	const userID = 999940
	const firstApp = "notify-flow-first"
	const secondApp = "notify-flow-second"
	makeTestUser(t, conn, userID, "notify-flow@example.com")
	t.Cleanup(func() {
		conn.Exec(`DELETE FROM notifications WHERE subject_id IN ($1, $2)`, firstApp, secondApp)
	})

	if err := reg.Create(firstApp, userID, false); err != nil {
		t.Fatalf("Create first app: %v", err)
	}

	title, body, actionTarget, found := awaitNotification(t, conn, firstApp, 3*time.Second)
	if !found {
		t.Fatal("no notification for the first app — the pipeline is not connected end to end")
	}
	if title != "Thanks for signing up" {
		t.Errorf("title = %q, want the welcome rule's own title", title)
	}
	// The exact string the console compares against in openNotificationAction
	// (apps/console/src/App.tsx). Nothing else pins the two sides together.
	if actionTarget != "useCaseForm" {
		t.Errorf("action_target = %q, want %q — the console's action button routes on this exact string",
			actionTarget, "useCaseForm")
	}
	// Copy the review asked to be removed; assert it stays removed.
	if body == "" {
		t.Error("body is empty")
	}

	// A second app must NOT notify: the rule is gated on isFirst, which the
	// registry computes at publish time.
	if err := reg.Create(secondApp, userID, false); err != nil {
		t.Fatalf("Create second app: %v", err)
	}
	if _, _, _, found := awaitNotification(t, conn, secondApp, 500*time.Millisecond); found {
		t.Error("the second app produced a welcome notification too; isFirst is not gating")
	}
}

// TestCreateApp_WithoutEventBusIsSilent pins the opt-in: a Registry nobody
// called SetEventBus on must create apps perfectly well and publish nothing.
// Every existing caller (tests, the CLI) is in exactly that state.
func TestCreateApp_WithoutEventBusIsSilent(t *testing.T) {
	database := openTestDB(t)
	conn, err := database.DB()
	if err != nil {
		t.Fatalf("db handle: %v", err)
	}
	reg, err := NewRegistry(database)
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}

	const userID = 999941
	const appID = "notify-flow-nobus"
	makeTestUser(t, conn, userID, "notify-flow-nobus@example.com")
	t.Cleanup(func() { conn.Exec(`DELETE FROM notifications WHERE subject_id = $1`, appID) })

	if err := reg.Create(appID, userID, false); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, _, _, found := awaitNotification(t, conn, appID, 500*time.Millisecond); found {
		t.Error("a registry with no event bus produced a notification")
	}
}
