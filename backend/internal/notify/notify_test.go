package notify

import (
	"io"
	"log/slog"
	"sync"
	"testing"

	"github.com/tim72117/onagent/internal/events"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// fakeNotificationStore is an in-memory NotificationStore — lets these
// tests assert exactly what would have been written without needing a
// live Postgres (see notify_integration_test.go for the ones that
// exercise the real SQL-backed stores).
type fakeNotificationStore struct {
	mu        sync.Mutex
	rows      []Notification
	completed []struct {
		subjectIDs []string
		target     string
	}
}

func (s *fakeNotificationStore) Insert(n Notification) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows = append(s.rows, n)
	return nil
}

// CompleteByActionTarget just records the call — Notification (the
// rule-authoring shape this fake stores) has no Status field to mutate
// (that's a persisted-row concept, see Record in store.go), so there's
// nothing meaningful to simulate beyond "was this called, and with what
// arguments" — exactly what TestEngine_Rule_CompleteNotificationsAppliesToMatchingActionTarget
// asserts on.
func (s *fakeNotificationStore) CompleteByActionTarget(subjectIDs []string, target string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed = append(s.completed, struct {
		subjectIDs []string
		target     string
	}{subjectIDs, target})
	return nil
}

func (s *fakeNotificationStore) all() []Notification {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Notification, len(s.rows))
	copy(out, s.rows)
	return out
}

// fakeProgressStore is an in-memory ProgressStore. Mirrors the "fire
// exactly once" contract ProgressStore.MarkDone documents: completedNow is
// true only the first time both sides become done for a given
// (subjectID, ruleName).
type fakeProgressStore struct {
	mu    sync.Mutex
	a     map[string]bool
	b     map[string]bool
	fired map[string]bool
}

func newFakeProgressStore() *fakeProgressStore {
	return &fakeProgressStore{
		a:     make(map[string]bool),
		b:     make(map[string]bool),
		fired: make(map[string]bool),
	}
}

func (s *fakeProgressStore) MarkDone(subjectID, ruleName, side string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := subjectID + "|" + ruleName
	switch side {
	case "a":
		s.a[key] = true
	case "b":
		s.b[key] = true
	}
	if s.a[key] && s.b[key] && !s.fired[key] {
		s.fired[key] = true
		return true, nil
	}
	return false, nil
}

func TestEngine_StatelessRule_FiresWhenEventTypeAndMatchPass(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := Rule{
		Name:      "tool_created_rule",
		EventType: "tool.created",
		Build: func(e events.Event) Action {
			return CreateNotification{Title: "A tool was created", Body: e.SubjectID}
		},
	}
	e := NewEngine([]Rule{rule}, nil, notify, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1"})

	got := notify.all()
	if len(got) != 1 {
		t.Fatalf("len(notifications) = %d, want 1", len(got))
	}
	if got[0].Title != "A tool was created" || got[0].Body != "app-1" || got[0].RuleName != "tool_created_rule" {
		t.Errorf("notification = %+v, unexpected", got[0])
	}
}

func TestEngine_StatelessRule_IgnoresNonMatchingEventType(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := Rule{
		Name:      "tool_created_rule",
		EventType: "tool.created",
		Build:     func(e events.Event) Action { return CreateNotification{Title: "x"} },
	}
	e := NewEngine([]Rule{rule}, nil, notify, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "tool.deleted", SubjectID: "app-1"})

	if got := notify.all(); len(got) != 0 {
		t.Fatalf("len(notifications) = %d, want 0", len(got))
	}
}

func TestEngine_StatelessRule_MatchCanVetoAnEventTypeMatch(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := Rule{
		Name:      "first_tool_only",
		EventType: "tool.created",
		Match:     func(e events.Event) bool { return e.Metadata["isFirst"] == true },
		Build:     func(e events.Event) Action { return CreateNotification{Title: "first!"} },
	}
	e := NewEngine([]Rule{rule}, nil, notify, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1", Metadata: map[string]any{"isFirst": false}})
	if got := notify.all(); len(got) != 0 {
		t.Fatalf("Match=false: len(notifications) = %d, want 0", len(got))
	}

	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1", Metadata: map[string]any{"isFirst": true}})
	if got := notify.all(); len(got) != 1 {
		t.Fatalf("Match=true: len(notifications) = %d, want 1", len(got))
	}
}

// TestEngine_Rule_CreateNotificationMustSetSubjectIDItself confirms Engine
// no longer stamps SubjectID after Build returns (see Rule's own doc
// comment on this being the rule author's responsibility now that Build
// returns an Action instead of a bare Notification) — a Build that
// forgets to set SubjectID on its CreateNotification ends up with "".
func TestEngine_Rule_CreateNotificationMustSetSubjectIDItself(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := Rule{
		Name:      "forgets_subject_id",
		EventType: "tool.created",
		Build:     func(e events.Event) Action { return CreateNotification{Title: "x"} },
	}
	e := NewEngine([]Rule{rule}, nil, notify, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1"})

	got := notify.all()
	if len(got) != 1 {
		t.Fatalf("len(notifications) = %d, want 1", len(got))
	}
	if got[0].SubjectID != "" {
		t.Errorf("SubjectID = %q, want \"\" (Build never set it, and Engine no longer fills it in)", got[0].SubjectID)
	}
}

// TestEngine_PairRule_FiresOnlyAfterBothSidesHappen is the core scenario
// this package was built for: two independent event sources, a
// notification only once both have occurred for the same subject.
func TestEngine_PairRule_FiresOnlyAfterBothSidesHappen(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := PairRule{
		Name:       "first_tool_and_feedback",
		EventTypeA: "tool.created",
		EventTypeB: "feedback.submitted",
		Build: func(subjectID string) Action {
			return CreateNotification{SubjectID: subjectID, Title: "You're all set up!", Body: "thanks for trying things out"}
		},
	}
	e := NewEngine(nil, []PairRule{rule}, notify, newFakeProgressStore(), testLogger())

	// Side A alone: not enough yet.
	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1"})
	if got := notify.all(); len(got) != 0 {
		t.Fatalf("after side A only: len(notifications) = %d, want 0", len(got))
	}

	// Side B completes the pair: exactly one notification.
	e.Handle(events.Event{Type: "feedback.submitted", SubjectID: "app-1"})
	got := notify.all()
	if len(got) != 1 {
		t.Fatalf("after both sides: len(notifications) = %d, want 1", len(got))
	}
	if got[0].SubjectID != "app-1" || got[0].RuleName != "first_tool_and_feedback" {
		t.Errorf("notification = %+v, unexpected", got[0])
	}
}

func TestEngine_PairRule_DoesNotFireTwiceForRepeatedSideBEvents(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := PairRule{
		Name:       "first_tool_and_feedback",
		EventTypeA: "tool.created",
		EventTypeB: "feedback.submitted",
		Build:      func(subjectID string) Action { return CreateNotification{Title: "done"} },
	}
	e := NewEngine(nil, []PairRule{rule}, notify, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1"})
	e.Handle(events.Event{Type: "feedback.submitted", SubjectID: "app-1"})
	e.Handle(events.Event{Type: "feedback.submitted", SubjectID: "app-1"}) // a second, later feedback submission
	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1"})       // a second tool created afterward

	if got := notify.all(); len(got) != 1 {
		t.Fatalf("len(notifications) = %d, want exactly 1 (fire-once)", len(got))
	}
}

func TestEngine_PairRule_TracksEachSubjectIndependently(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := PairRule{
		Name:       "first_tool_and_feedback",
		EventTypeA: "tool.created",
		EventTypeB: "feedback.submitted",
		Build:      func(subjectID string) Action { return CreateNotification{Title: "done", Body: subjectID} },
	}
	e := NewEngine(nil, []PairRule{rule}, notify, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1"})
	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-2"})
	e.Handle(events.Event{Type: "feedback.submitted", SubjectID: "app-2"})

	got := notify.all()
	if len(got) != 1 {
		t.Fatalf("len(notifications) = %d, want 1 (only app-2 completed the pair)", len(got))
	}
	if got[0].Body != "app-2" {
		t.Errorf("notification fired for subject %q, want app-2", got[0].Body)
	}

	// app-1's side A still stands; completing its side B now should fire
	// its own, separate notification.
	e.Handle(events.Event{Type: "feedback.submitted", SubjectID: "app-1"})
	got = notify.all()
	if len(got) != 2 {
		t.Fatalf("len(notifications) = %d, want 2 after app-1 also completes its pair", len(got))
	}
}

func TestEngine_PairRule_MatchAVetoesSideA(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := PairRule{
		Name:       "first_tool_and_feedback",
		EventTypeA: "tool.created",
		EventTypeB: "feedback.submitted",
		MatchA:     func(e events.Event) bool { return e.Metadata["isFirst"] == true },
		Build:      func(subjectID string) Action { return CreateNotification{Title: "done"} },
	}
	e := NewEngine(nil, []PairRule{rule}, notify, newFakeProgressStore(), testLogger())

	// Side A fails MatchA — should not register as done.
	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1", Metadata: map[string]any{"isFirst": false}})
	e.Handle(events.Event{Type: "feedback.submitted", SubjectID: "app-1"})

	if got := notify.all(); len(got) != 0 {
		t.Fatalf("len(notifications) = %d, want 0 (side A never matched)", len(got))
	}
}

func TestEngine_Register_SubscribesToEveryDistinctEventTypeExactlyOnce(t *testing.T) {
	bus := events.NewBus(testLogger())
	notify := &fakeNotificationStore{}
	rules := []Rule{
		{Name: "r1", EventType: "tool.created", Build: func(e events.Event) Action { return CreateNotification{Title: "r1"} }},
	}
	pairRules := []PairRule{
		{Name: "p1", EventTypeA: "tool.created", EventTypeB: "feedback.submitted", Build: func(s string) Action { return CreateNotification{Title: "p1"} }},
	}
	e := NewEngine(rules, pairRules, notify, newFakeProgressStore(), testLogger())
	e.Register(bus)

	// "tool.created" is shared by both a Rule and a PairRule's side A —
	// Register must not double-subscribe Handle for it (which would run
	// Handle's whole body twice per event, double-inserting r1's
	// notification).
	bus.Publish(events.Event{Type: "tool.created", SubjectID: "app-1"})

	got := notify.all()
	r1Count := 0
	for _, n := range got {
		if n.RuleName == "r1" {
			r1Count++
		}
	}
	if r1Count != 1 {
		t.Fatalf("rule r1 fired %d times for one tool.created event, want exactly 1 (Register must dedupe event type subscriptions)", r1Count)
	}
}

func TestEngine_Handle_OneFailingRuleDoesNotBlockOthers(t *testing.T) {
	failing := Rule{
		Name:      "failing",
		EventType: "tool.created",
		Build:     func(e events.Event) Action { return CreateNotification{Title: "will fail to insert"} },
	}
	working := Rule{
		Name:      "working",
		EventType: "tool.created",
		Build:     func(e events.Event) Action { return CreateNotification{Title: "should still fire"} },
	}
	// A store whose Insert fails only for the "failing" rule's title.
	store := &selectivelyFailingStore{failTitle: "will fail to insert"}
	e := NewEngine([]Rule{failing, working}, nil, store, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "tool.created", SubjectID: "app-1"})

	if len(store.inserted) != 1 || store.inserted[0].Title != "should still fire" {
		t.Fatalf("inserted = %+v, want exactly the working rule's notification", store.inserted)
	}
}

// TestEngine_Rule_CompleteNotificationsAppliesToMatchingActionTarget
// covers the CompleteNotifications side of Action — a rule whose Build
// returns it should call through to CompleteByActionTarget with exactly
// the subjectIDs/target it specified, not Insert a new row.
func TestEngine_Rule_CompleteNotificationsAppliesToMatchingActionTarget(t *testing.T) {
	notify := &fakeNotificationStore{}
	rule := Rule{
		Name:      "usecase_submitted_completes_welcome",
		EventType: "usecase.submitted",
		Build: func(e events.Event) Action {
			return CompleteNotifications{SubjectIDs: []string{"app-1", "app-2"}, Target: "useCaseForm"}
		},
	}
	e := NewEngine([]Rule{rule}, nil, notify, newFakeProgressStore(), testLogger())

	e.Handle(events.Event{Type: "usecase.submitted", ActorID: 42})

	if len(notify.completed) != 1 {
		t.Fatalf("len(completed calls) = %d, want 1", len(notify.completed))
	}
	call := notify.completed[0]
	if call.target != "useCaseForm" {
		t.Errorf("target = %q, want %q", call.target, "useCaseForm")
	}
	if len(call.subjectIDs) != 2 || call.subjectIDs[0] != "app-1" || call.subjectIDs[1] != "app-2" {
		t.Errorf("subjectIDs = %v, want [app-1 app-2]", call.subjectIDs)
	}
	// Must not have inserted a new notification — CompleteNotifications
	// closes something out, it doesn't create anything.
	if got := notify.all(); len(got) != 0 {
		t.Fatalf("len(notifications) = %d, want 0 (CompleteNotifications must not insert)", len(got))
	}
}

type selectivelyFailingStore struct {
	failTitle string
	inserted  []Notification
}

func (s *selectivelyFailingStore) Insert(n Notification) error {
	if n.Title == s.failTitle {
		return errFake
	}
	s.inserted = append(s.inserted, n)
	return nil
}

func (s *selectivelyFailingStore) CompleteByActionTarget(subjectIDs []string, target string) error {
	return nil
}

type fakeError string

func (e fakeError) Error() string { return string(e) }

const errFake fakeError = "fake insert failure"
